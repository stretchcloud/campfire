# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## Code verification

After generating or modifying code, verify it by calling `run_advanced_code_analysis` (if that tool is available in your environment) before committing. Always run `bun run typecheck` and `bun run test` regardless.

## What This Is

Campfire — a collaborative web platform for AI coding agents (Claude Code, Codex, Goose, Aider, OpenHands, OpenClaw, OpenCode). It provides a browser-based interface for running multiple agent sessions with streaming, tool call visibility, and permission control.

Claude Code runs over a long-lived **stdio stream-json transport** by default (`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`), wrapped in `claude-stdio-adapter.ts`. The legacy reverse-engineered `--sdk-url` WebSocket transport is still available behind `CAMPFIRE_CLAUDE_TRANSPORT=sdk-url`. All other backends run through stdio adapters (JSON-RPC or stdout parsing).

## Development Commands

```bash
# Dev server (Hono backend on :4567 + Vite HMR on :4567)
cd web && bun install && bun run dev

# Or from repo root
make dev

# Type checking
cd web && bun run typecheck

# Production build + serve
cd web && bun run build && bun run start

# Landing page (campfire.sh) — idempotent: starts if down, no-op if up
# IMPORTANT: Always use this script to run the landing page. Never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh          # start
./scripts/landing-start.sh --stop   # stop
```

## Testing

```bash
# Run tests
cd web && bun run test

# Watch mode
cd web && bun run test:watch
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

### Data Flow

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ AgentAdapter (stdio) ←→ Agent CLI
     :4567          /ws/browser/:id       :4567      NDJSON / JSON-RPC     (claude, codex, goose, …)
```

1. Browser sends a "create session" REST call to the server
2. Server spawns the backend CLI as a subprocess (Claude Code: `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`)
3. An `AgentAdapter` translates the backend's stdio protocol into normalized browser messages
4. Server bridges messages between the adapter and browser WebSockets (`ws-bridge.ts`)
5. Tool calls arrive as `control_request` (subtype `can_use_tool`) — browser renders approval UI, server relays `control_response` back
6. Legacy path: with `CAMPFIRE_CLAUDE_TRANSPORT=sdk-url`, Claude instead connects back over `/ws/cli/:id` (`--sdk-url` WebSocket, NDJSON)

### All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 4567)
  - `index.ts` — Server bootstrap, Bun.serve with dual WebSocket upgrade (CLI vs browser)
  - `ws-bridge.ts` — Core message router. Maintains per-session state (CLI socket, browser sockets, message history, pending permissions). Parses NDJSON from CLI, translates to typed JSON for browsers.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts.
  - `session-store.ts` — JSON file persistence to `~/.campfire/sessions/`. Debounced writes.
  - `session-types.ts` — All TypeScript types for CLI messages (NDJSON), browser messages, session state, permissions.
  - `routes.ts` — backwards-compat shim; the REST API lives in `routes/*.ts` (session CRUD, filesystem browsing, environments, git, cron, gallery, webhooks, agents, races, orchestrator, …).
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.campfire/envs/`.

- **`web/src/`** — React 19 frontend
  - `store.ts` — Zustand store. All state keyed by session ID (messages, streaming text, permissions, tasks, connection status).
  - `ws.ts` — Browser WebSocket client. Connects per-session, handles all incoming message types, auto-reconnects. Extracts task items from `TaskCreate`/`TaskUpdate`/`TodoWrite` tool calls.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`).
  - `api.ts` — REST client for session management.
  - `App.tsx` — Root layout with sidebar, chat view, task panel. Hash routing (`#/playground`).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `HomePage`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `Playground`.

- **`web/bin/cli.ts`** — CLI entry point (`bunx the-campfire`). Sets `__CAMPFIRE_PACKAGE_ROOT` and imports the server.

### WebSocket Protocol

The Claude CLI uses NDJSON (newline-delimited JSON) over stdio (or the legacy `--sdk-url` WebSocket). Key message types from CLI: `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`, `tool_progress`, `tool_use_summary`, `keep_alive`. Messages to CLI: `user`, `control_response`, `control_request` (for interrupt/set_model/set_permission_mode).

Protocol references: pinned upstream schema snapshots live in `web/server/protocol/{claude,codex}-upstream/` (guarded by the `*-protocol-contract.test.ts` and `*-protocol-drift.test.ts` suites), Codex message mapping is documented in `web/CODEX_MAPPING.md`, and raw wire recordings in `~/.campfire/recordings/` capture real traffic.

### Session Lifecycle

Sessions persist to disk (`~/.campfire/sessions/`) and survive server restarts. On restart, live CLI processes are detected by PID and given a grace period to reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume` using the CLI's internal session ID.

### Raw Protocol Recordings

The server automatically records **all raw protocol messages** (both Claude Code NDJSON and Codex JSON-RPC) to JSONL files. This is useful for debugging, understanding the protocol, and building replay-based tests.

- **Location**: `~/.campfire/recordings/` (override with `CAMPFIRE_RECORDINGS_DIR`)
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Disable**: set `CAMPFIRE_RECORD=0` or `CAMPFIRE_RECORD=false`
- **Rotation**: automatic cleanup when total lines exceed 100k (configurable via `CAMPFIRE_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

## Browser Exploration

Always use `agent-browser` CLI command to explore the browser. Never use playwright or other browser automation libraries.

## Pull Requests

When submitting a pull request:
- use commitzen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if its a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitzen)

# 2) Commit using commitzen format
git add <files>
git commit -m "fix(scope): short summary" (commitzen)

# 3) Push and set upstream
git push -u origin fix/short-description

# 4) Create PR (title should follow commitzen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.

## Codebase Understanding (Updated 2026-02-16)

### **High-Level Purpose**
Campfire (published as `the-campfire` on npm) is a collaborative web platform for AI coding agents. It provides a unified browser interface for multiple agent backends (Claude Code, Codex, Goose, Aider, OpenHands) with real-time collaboration, permission voting, session replay, webhooks, scheduled tasks, and a session gallery.

The core innovation is a **protocol bridge** that normalizes different agent protocols (NDJSON WebSocket, JSON-RPC stdio, stdout parsing) into a single browser message format, making the frontend completely backend-agnostic.

---

### **Architecture Overview**

**Data Flow:**
```
Browser (React 19) ←→ WebSocket ←→ Hono Server (Bun) ←→ Agent Backend
     :4567              /ws/browser/:id     :4567         (Claude/Codex/Goose/Aider/OpenHands)
```

**Key Components:**
- **Runtime**: Bun (JS/TS runtime + package manager)
- **Backend**: Hono (lightweight web framework with WebSocket support)
- **Frontend**: React 19 + Zustand state management
- **Styling**: Tailwind CSS 4
- **Build**: Vite 6 with HMR
- **Testing**: Vitest with 66 test files, 80% coverage target

---

### **Server Architecture** (`web/server/`)

#### **Core Components**

**`index.ts`** - Server Bootstrap
- Enriches PATH for binary resolution (handles version managers like nvm, volta, fnm)
- Instantiates all managers: `CliLauncher`, `WsBridge`, `SessionStore`, `TerminalManager`, `PRPoller`, `RecorderManager`, `CronScheduler`, `WorktreeTracker`, `WebhookManager`, `AdapterRegistry`
- WebSocket routing: `/ws/cli/:id` (agent backends), `/ws/browser/:id` (browsers), `/ws/terminal/:id` (PTY)
- Mounts REST API under `/api` from `routes/index.ts` (via the `routes.ts` compat shim)
- Serves static files from `dist/` in production

**`ws-bridge.ts`** - The Heart of the System
- Routes messages between agent backends and browser clients
- Maintains per-session state: `Session` objects with CLI socket, browser sockets, message history, pending permissions, event buffer
- Handles permission gating with multi-viewer voting (majority-rules, any-deny-blocks, owner-decides)
- Buffers broadcast events with sequence IDs for reconnect replay (`session_subscribe`/`session_ack`)
- Deduplicates idempotent browser messages using `client_msg_id`
- Tracks git metadata (branch, ahead/behind, worktree) via `resolveGitInfo()`
- Delegates non-Claude backends to adapter instances
- Emits `cli_connected`/`cli_disconnected`, handles `control_request` for permissions

**`cli-launcher.ts`** - Process Lifecycle Manager
- Spawns agent subprocesses:
  - Claude Code: `claude --sdk-url ws://localhost:4567/ws/cli/SESSION_ID`
  - Codex: `codex app-server` (JSON-RPC over stdio)
  - Goose: `goose acp` (JSON-RPC 2.0 over stdio)
  - Aider: `aider --no-pretty --yes` (stdout parsing)
  - OpenHands: `openhands acp` (JSON-RPC 2.0 over stdio)
- Tracks session metadata in `SdkSessionInfo` (pid, state, model, cwd, CLI session ID, worktree info)
- Persists launcher state via `SessionStore` for server restart recovery
- Supports `--resume` for Claude Code sessions using CLI internal `session_id`
- Creates git worktrees for branch isolation

**`session-store.ts`** - Disk Persistence
- Debounced JSON writes to `~/.campfire/sessions/` (150ms delay to batch rapid changes)
- Persists per session: state, message history, pending permissions, event buffer, processed client message IDs
- Sessions survive server restarts
- `launcher.json` stores launcher state separately

**`session-types.ts`** - Type Contracts
- **CLI message types**: `CLISystemInitMessage`, `CLIAssistantMessage`, `CLIResultMessage`, `CLIStreamEventMessage`, `CLIControlRequestMessage`, etc.
- **Browser message types**: `BrowserIncomingMessage`, `BrowserOutgoingMessage` (stable regardless of backend)
- **Session state**: `SessionState` with model, cwd, tools, permissions mode, git info, cost tracking
- **Permission types**: `PermissionRequest`, `PermissionVote`, `VotingPolicy`
- **Presence types**: `PresenceViewer`, `SessionRole` (owner/collaborator/spectator)

#### **Adapter Layer** - Multi-Backend Support

The adapter pattern is the key to backend-agnostic design. All adapters implement the `AgentAdapter` interface:

**`adapter-types.ts`** - Interface Definition
```typescript
interface AgentAdapter {
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;
  onSessionMeta(cb: (meta: AdapterSessionMeta) => void): void;
  onDisconnect(cb: () => void): void;
  onInitError(cb: (error: string) => void): void;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  getBackendSessionId(): string | null;
}
```

**Available Adapters:**
- **`codex-adapter.ts`**: Translates Codex JSON-RPC (app-server stdio) to browser messages. Maps Codex items (agentMessage, fileChange, commandExecution, mcpToolCall, webSearch, reasoning, contextCompaction) into chat/tool timeline events.
- **`goose-adapter.ts`**: Translates Goose ACP (JSON-RPC 2.0 over stdio). Handles session/new, session/load, session/prompt, ActionRequired permissions.
- **`aider-adapter.ts`**: Parses Aider stdout into browser messages (file edits, command execution).
- **`openhands-adapter.ts`**: Translates OpenHands ACP to browser messages.
- **`openclaw-adapter.ts`**: Translates OpenClaw protocol.

Each adapter:
- Implements JSON-RPC transport with buffering and pending request tracking
- Hooks into `RecorderManager` for raw message capture
- Emits session metadata (model, cwd, backend session ID) on initialization
- Handles backend-specific permission flows and translates to standard `PermissionRequest`

**`adapter-registry.ts`** - Community Adapters
- Installs adapters from npm packages with `campfireAdapter` field in `package.json`
- Stored in `~/.campfire/adapters/`
- Adapters appear as new backend options in session creation UI

#### **Supporting Services**

**Recording & Replay:**
- **`recorder.ts`**: Captures raw protocol messages (both directions) to JSONL files in `~/.campfire/recordings/`
- Format: `{"ts": <timestamp>, "dir": "in"|"out", "raw": "<original string>", "ch": "cli"|"browser"}`
- Auto-rotation when total lines exceed 100k
- **`replay.ts`**: Load & filter utilities for replay UI at 1x/2x/4x/8x speed

**Automation:**
- **`cron-scheduler.ts` + `cron-store.ts`**: Persistent scheduled jobs (recurring or one-shot) stored in `~/.campfire/cron/`
- Jobs create sessions, inject prompts, track execution history, auto-disable after repeated failures
- Cron expression examples: `0 2 * * *` (daily 2am), `*/30 * * * *` (every 30 min)

**Webhooks:**
- **`webhook-manager.ts`**: HTTP POST notifications for session events (created, completed, failed, permission requested/resolved, turn completed, cost threshold)
- HMAC-SHA256 signing with `X-Campfire-Signature` header
- Retry logic: 3 attempts with exponential backoff (1s, 5s, 15s)
- Stored in `~/.campfire/webhooks/`

**Git Integration:**
- **`git-utils.ts` + `worktree-tracker.ts`**: Resolve repo info, manage worktrees, track ahead/behind counts
- **`github-pr.ts` + `pr-poller.ts`**: Fetch PR metadata via `gh` CLI with adaptive polling; push updates to sessions via WebSocket

**Other Services:**
- **`terminal-manager.ts`**: Embedded PTY terminal via `/ws/terminal/:id`
- **`container-manager.ts`**: Docker sandboxing for sessions
- **`gallery-store.ts`**: Session gallery with voting, featured status, stored in `~/.campfire/gallery/`
- **`env-manager.ts`**: Environment profiles (named sets of env vars) in `~/.campfire/envs/`
- **`settings-manager.ts`**: Global settings (OpenRouter API key for auto-naming) in `~/.campfire/settings.json`
- **`auto-namer.ts` + `session-names.ts`**: Auto-generate session titles via OpenRouter after first turn
- **`update-checker.ts` + `service.ts`**: Check npm for updates, track service mode (launchd/systemd)
- **`usage-limits.ts`**: Track account usage limits per backend

**REST API (`routes/*.ts`, mounted via `routes/index.ts`):**
- Session CRUD: create (with backend, model, permission mode, env, worktree, container options), list, get, rename, delete, archive, kill, relaunch, fork, invite links
- Git: repo info, branches, worktrees, fetch, pull, PR status
- Recordings: list, status, start/stop per session
- Gallery: list (with filters), get, publish, update, delete, vote, feature toggle
- Webhooks: CRUD, toggle enable/disable, test delivery
- Adapters: list, install from npm, uninstall
- Backends & models: list available backends with availability status, get models per backend
- Cron: CRUD jobs, toggle, manual trigger, execution history
- Environments: CRUD profiles
- Collaboration: get/set voting policy
- Filesystem: list dirs, read files, write files, git diff, CLAUDE.md management
- Settings: get/update OpenRouter config
- System: containers status, usage limits, update check, terminal lifecycle

---

### **Frontend Architecture** (`web/src/`)

**`store.ts`** - Zustand State Management
Session-scoped state keyed by session ID:
- `sessions`: Map of `SessionState` (model, cwd, tools, permission mode, git info, cost)
- `messages`: Map of `ChatMessage[]` per session
- `streaming`: Map of partial streaming text per session
- `pendingPermissions`: Map of pending permission requests (outer key = sessionId, inner = request_id)
- `connectionStatus` + `cliConnected`: Connection state per session
- `sessionStatus`: "idle" | "running" | "compacting" | null
- `sessionTasks`: Map of `TaskItem[]` (extracted from TodoWrite/TaskCreate/TaskUpdate)
- `changedFiles`: Map of file paths (from Edit/Write tool blocks)
- `sessionNames`: Display names per session
- `prStatus`: PR metadata per session
- `mcpServers`: MCP server details per session
- `toolProgress`: Tool execution progress tracking
- `sessionViewers`: Presence (connected viewers with roles)
- `myRole` + `myViewerId`: This browser's role and viewer ID per session
- `permissionVotes` + `voteResults`: Voting state per permission request
- UI state: `darkMode`, `sidebarOpen`, `taskPanelOpen`, `activeTab` ("chat" | "diff")

**`ws.ts`** - WebSocket Client
- Connects to `/ws/browser/:sessionId`
- Handles reconnect with sequence-based event replay (`session_subscribe` with `last_seq`, server replies with `event_replay`)
- Processes incoming messages:
  - `session_init`: Initialize session state
  - `assistant`: Append message to chat
  - `stream_event`: Accumulate streaming text
  - `result`: Update cost, turns, context usage
  - `permission_request`: Add to pending permissions
  - `permission_cancelled`: Remove from pending
  - `status_change`: Update session status (idle/running/compacting)
  - `presence_update` + `role_assigned`: Update viewers and role
  - `vote_update` + `vote_resolved`: Track permission voting
  - `pr_status_update`: Update PR metadata
  - `mcp_status`: Update MCP servers
  - `tool_progress`: Track long-running tool execution
- Extracts tasks from `TodoWrite`/`TaskCreate`/`TaskUpdate` tool blocks (deduplicated by `tool_use_id`)
- Extracts changed files from `Edit`/`Write` tool blocks (resolved to absolute paths, filtered by session cwd)
- Emits desktop + sound notifications for permission requests
- Sends messages with `client_msg_id` for idempotency on reconnect

**`api.ts`** - REST Client
Typed REST client with analytics for success/failure. Helpers for:
- Sessions: create, list, get, rename, delete, archive, kill, relaunch, fork, join (invite links)
- Settings: get/update OpenRouter config
- Environments: CRUD profiles
- Cron: CRUD jobs, trigger, history
- Containers: status, images
- Recordings: list, status, start/stop
- Gallery: list, publish, vote, feature
- Webhooks: CRUD, toggle, test
- Adapters: list, install, uninstall
- Git: repo info, branches, worktrees, PR status
- Update checks

**`types.ts`** - Type Definitions
Re-exports server types + frontend-only types:
- `ChatMessage`: Frontend representation of messages with `role`, `content`, `toolResults`
- `TaskItem`: Task with `id`, `subject`, `description`, `status`, `activeForm`, `owner`, `blockedBy`
- `SdkSessionInfo`: Session metadata enriched by REST API (git branch, ahead/behind, lines changed)

**`App.tsx`** - Root Layout & Routing
Hash routing:
- `#/` (default): Chat view or home page
- `#/playground`: Component mock gallery
- `#/settings`: Settings page
- `#/terminal`: Embedded PTY terminal
- `#/environments`: Environment profiles
- `#/scheduled`: Cron jobs
- `#/gallery`: Session gallery
- `#/webhooks`: Webhook manager
- `#/adapters`: Adapter manager
- `#/clawhub`: ClawHub browser (session sharing)
- `#/replay/:filename` or `#/replay/session/:id`: Session replay
- `#/join/:token`: Invite link handler

Layout: Sidebar (overlay on mobile) + Main area (TopBar + content) + Task panel (overlay on mobile)
Active tab toggles between "chat" and "diff" views

**Components (`components/`):**
- **Chat Timeline**: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`
- **Session Chrome**: `Sidebar`, `TopBar`, `UpdateBanner`
- **Permission Flow**: `PermissionBanner` (with voting UI, countdown timer, vote tally)
- **Task Panel**: `TaskPanel` (shows tasks, cost, PR status, MCP servers, tool progress)
- **Diff View**: `DiffPanel`, `DiffViewer` (side-by-side with file tree using react-arborist)
- **Pages**: `HomePage` (session creation), `SettingsPage`, `EnvManager`, `CronManager`, `TerminalPage`, `SessionReplay`, `GalleryPage`, `WebhookManager`, `AdapterManager`, `ClawHubBrowser`
- **Utilities**: `Playground` (component mock gallery), `CostCard` (shareable PNG cost summary), `AppErrorBoundary`

---

### **Key Features**

1. **Multi-Backend Support**: Claude Code (WebSocket NDJSON), Codex (JSON-RPC stdio), Goose (ACP), Aider (stdout), OpenHands (ACP), OpenClaw
2. **Real-Time Collaboration**: Multiple viewers with roles (owner/collaborator/spectator), presence indicators
3. **Permission Voting**: Configurable policies (majority-rules, any-deny-blocks, owner-decides), 30-second deadline, vote tally UI
4. **Session Replay**: JSONL recordings with 1x/2x/4x/8x playback, scrubber for seeking
5. **Fork & Branch**: Fork sessions at any point, optional worktree creation for branch isolation
6. **Session Gallery**: Publish sessions with tags, voting, featured status, filter/sort by cost/duration/votes
7. **Webhooks**: HTTP POST notifications with HMAC-SHA256 signing, retry logic, session filters
8. **Scheduled Tasks (Cron)**: Recurring or one-shot autonomous sessions, execution history, auto-disable on repeated failures
9. **Adapter Registry**: Install community adapters from npm (packages with `campfireAdapter` field)
10. **Embedded Terminal**: Full PTY terminal via `/ws/terminal/:id` with ANSI colors and resize support
11. **Git Integration**: Branch tracking, worktrees, ahead/behind counts, PR status polling via `gh` CLI
12. **Docker Containers**: Optional sandboxing with the working directory mounted at `/workspace`; provider auth (`~/.claude`, `~/.codex`) is seeded into the container as a writable copy via `docker cp`
13. **PWA**: Installable on mobile with push notifications for permission requests
14. **Auto-Naming**: Session titles generated via OpenRouter after first turn

---

### **Data Persistence**

All state is file-based (no database):

| Data | Location | Format |
|------|----------|--------|
| Sessions | `~/.campfire/sessions/` | JSON per session |
| Recordings | `~/.campfire/recordings/` | JSONL per session |
| Environments | `~/.campfire/envs/` | JSON per profile |
| Cron jobs | `~/.campfire/cron/` | JSON per job |
| Gallery entries | `~/.campfire/gallery/` | JSON per entry |
| Webhooks | `~/.campfire/webhooks/` | JSON per webhook |
| Adapters | `~/.campfire/adapters/` | npm packages |
| Settings | `~/.campfire/settings.json` | Single JSON file |
| Session names | `~/.campfire/session-names.json` | Single JSON file |

---

### **Testing Infrastructure**

- **66 test files** across `web/server/**/*.test.ts` and `web/src/**/*.test.ts(x)`
- **Vitest** with coverage thresholds: 80% statements/branches/functions/lines
- **Tests colocated with source**: `routes.test.ts` next to `routes.ts`
- **Protocol contract tests**: `claude-protocol-contract.test.ts`, `codex-protocol-contract.test.ts`
- **Protocol drift tests**: `claude-protocol-drift.test.ts`, `codex-protocol-drift.test.ts`
- **Environments**: Node for server tests, jsdom for frontend/React tests
- **Current status**: all tests pass — keep it that way (the pre-commit hook runs `bun run typecheck && bun run test`)
- **Husky pre-commit hook**: Runs `bun run typecheck && bun run test` automatically

---

### **Key Design Patterns**

1. **Protocol Normalization**: Adapter pattern ensures browser sees identical messages regardless of backend
2. **Debounced Persistence**: `SessionStore` batches writes (150ms delay) to avoid I/O thrashing during streaming
3. **Sequence-Based Replay**: Event buffer with monotonic `seq` IDs enables reliable reconnect without missing messages
4. **Idempotency**: `client_msg_id` prevents duplicate processing when browsers retry messages after reconnect
5. **Session-Scoped State**: All Zustand state keyed by session ID enables multi-session UI in one browser tab
6. **Tool-Derived Tasks**: Extract tasks from `TodoWrite`/`TaskCreate`/`TaskUpdate` tool blocks automatically
7. **Changed File Tracking**: Extract file paths from `Edit`/`Write` tool blocks for diff view
8. **Git-First Design**: Worktrees, branches, PR status polling integrated throughout
9. **Extensibility**: Adapter registry + `AgentAdapter` interface enables community backends via npm
10. **Raw Protocol Capture**: JSONL recording preserves exact bytes for replay, debugging, and contract testing

---

### **Project Layout**

```
campfire/
├── web/                      # Main application (published as "the-campfire")
│   ├── server/               # Bun + Hono backend (port 4567)
│   │   ├── index.ts          # Server bootstrap
│   │   ├── ws-bridge.ts      # Core message router
│   │   ├── cli-launcher.ts   # Process lifecycle manager
│   │   ├── session-store.ts  # Disk persistence
│   │   ├── session-types.ts  # Type contracts
│   │   ├── adapter-types.ts  # AgentAdapter interface
│   │   ├── codex-adapter.ts  # Codex backend
│   │   ├── goose-adapter.ts  # Goose backend
│   │   ├── aider-adapter.ts  # Aider backend
│   │   ├── openhands-adapter.ts # OpenHands backend
│   │   ├── openclaw-adapter.ts  # OpenClaw backend
│   │   ├── recorder.ts       # Protocol recording
│   │   ├── replay.ts         # Replay utilities
│   │   ├── cron-scheduler.ts # Scheduled tasks
│   │   ├── webhook-manager.ts # Webhook delivery
│   │   ├── pr-poller.ts      # GitHub PR polling
│   │   ├── worktree-tracker.ts # Git worktree management
│   │   ├── terminal-manager.ts # PTY terminal
│   │   ├── container-manager.ts # Docker sandboxing
│   │   ├── gallery-store.ts  # Session gallery
│   │   ├── adapter-registry.ts # Community adapters
│   │   ├── routes.ts         # REST API
│   │   └── *.test.ts         # Colocated tests
│   ├── src/                  # React 19 frontend
│   │   ├── store.ts          # Zustand state
│   │   ├── ws.ts             # WebSocket client
│   │   ├── api.ts            # REST client
│   │   ├── types.ts          # Type definitions
│   │   ├── App.tsx           # Root layout + routing
│   │   ├── components/       # UI components
│   │   └── *.test.tsx        # Frontend tests
│   ├── bin/cli.ts            # CLI entry point (bunx the-campfire)
│   ├── dist/                 # Built frontend assets
│   └── package.json          # Published as "the-campfire"
├── landing/                  # Marketing site (separate Vite app)
├── scripts/                  # Utility scripts (landing-start.sh)
├── CLAUDE.md                 # This file (project instructions)
├── README.md                 # User documentation
└── TODO.md                   # Roadmap

**Landing Page**
- `landing/`: separate Vite app for marketing site (campfire.sh)
- Started via `scripts/landing-start.sh` (idempotent: starts if down, no-op if up)
- Never cd into `landing/` and run bun/vite manually

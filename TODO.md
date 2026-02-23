# Campfire TODO

Status legend: `[x]` = implemented, `[ ]` = not started, `[~]` = partially implemented

---

## Baseline: Fork The Companion v0.42.0

These are features from The Companion v0.42.0 that form our starting baseline.

- [x] **Session Recording** — `recorder.ts`, `replay.ts` — JSONL capture of raw protocol messages
- [x] **Cron Scheduling** — `cron-scheduler.ts`, `cron-store.ts`, `cron-types.ts` — Persistent scheduled autonomous sessions
- [x] **Service Daemon** — `service.ts`, `path-resolver.ts` — systemd/launchd background mode
- [x] **GitHub PR Integration** — `github-pr.ts`, `pr-poller.ts` — Adaptive polling, PR metadata
- [x] **Settings Manager** — `settings-manager.ts` — Global user preferences
- [x] **MCP Panel UI** — `McpPanel.tsx` — MCP server management interface

### Additional v0.42.0 features already present:
- [x] **Claude Code adapter** — WS/NDJSON bridge via `ws-bridge.ts`
- [x] **Codex adapter** — JSON-RPC stdio via `codex-adapter.ts`
- [x] **Container support** — `container-manager.ts` — Docker-backed execution
- [x] **Worktree support** — `worktree-tracker.ts` — Git worktree creation/tracking
- [x] **Terminal support** — `terminal-manager.ts` — Embedded PTY
- [x] **Git utilities** — `git-utils.ts` — Branch tracking, ahead/behind, repo info
- [x] **Auto-naming** — `auto-namer.ts` — Session names via OpenRouter after first turn
- [x] **Update checker** — `update-checker.ts` — Periodic npm update checks
- [x] **Usage limits** — `usage-limits.ts` — Rate limiting/usage tracking
- [x] **Environment profiles** — `env-manager.ts` — CRUD for environment configurations

---

## Phase 1 (Weeks 1-3): Goose Adapter + Foundation

### 1.1 Goose ACP Adapter
- [x] Create `goose-adapter.ts` — Goose ACP (JSON-RPC 2.0 over stdio) adapter
  - [x] JSON-RPC transport (stdin/stdout NDJSON)
  - [x] ACP initialization handshake (`initialize` → `session/new`)
  - [x] Session resume (`session/load`)
  - [x] Message mapping: `agentMessageChunk` → `stream_event`
  - [x] Message mapping: `toolCall` → `assistant` with `tool_use` content block
  - [x] Message mapping: `toolCallUpdate` → `tool_result`
  - [x] Message mapping: `agentThoughtChunk` → thinking block
  - [x] Permission flow: `actionRequired.toolConfirmation` → `permission_request`
  - [x] Tool name mapping: `developer__bash` → `Bash`, `developer__text_editor` → `Edit`, etc.
  - [x] `session/prompt` for sending messages
  - [x] `session/cancel` for interruption
  - [x] `session/set_model` for runtime model switching
  - [x] Message queuing before initialization completes
  - [x] Error handling and init failure reporting
- [x] Create `goose-adapter.test.ts` — Unit tests for all adapter functionality
- [x] Wire into `cli-launcher.ts` — Add `spawnGoose()` method, handle goose backend type
- [x] Wire into `ws-bridge.ts` — Add `attachGooseAdapter()`, route browser messages to goose
- [x] Wire into `index.ts` — Connect launcher goose adapter events to bridge
- [x] Update `routes.ts` — Add goose to `/api/backends` endpoint
- [x] Update `session-types.ts` — Add `"goose"` to `BackendType` union
- [x] Update `src/utils/backends.ts` — Add `GOOSE_MODELS`, `GOOSE_MODES`, update getters
- [x] Update `src/utils/backends.test.ts` — Add goose backend tests
- [x] Update `src/api.ts` — Add `"goose"` to backend type unions
- [x] Update `src/components/CronManager.tsx` — Add goose to backend cycling
- [x] Update `src/utils/project-grouping.ts` — Add `"goose"` to backend type

### 1.2 Formal Adapter Interface
- [x] Create `server/adapter-types.ts` — Typed `AgentAdapter` interface
  - [x] Define `AgentAdapter` with `sendBrowserMessage()`, `onBrowserMessage()`, etc.
  - [x] Define `AdapterSessionMeta` type
- [x] Refactor `codex-adapter.ts` to implement `AgentAdapter`
- [x] Implement `AgentAdapter` in `goose-adapter.ts`
- [x] Unify `ws-bridge.ts`: merged `attachCodexAdapter`/`attachGooseAdapter` into `attachAdapter()`
- [x] Unify `cli-launcher.ts` + `index.ts`: single `onAdapterCreated` callback
- [x] Add `adapter-types.test.ts` — structural typing + prototype checks

### 1.3 Shareable Session Links
- [x] Generate invite token per session (`createInviteToken()` / `resolveInviteToken()` in ws-bridge)
- [x] `POST /api/sessions/:id/invite` — returns invite URL with token
- [x] `GET /api/sessions/join/:token` — resolves token to session ID
- [x] Replay `session_init` + `message_history` for browsers joining via token (existing handleBrowserOpen)
- [x] UI: "Share" button in TopBar that copies invite link
- [x] Frontend: `api.ts` methods, `App.tsx` `#/join/:token` hash route

### 1.4 Live Cost Dashboard + Shareable Cost Cards
- [x] Real-time cost ticker per session in TopBar (uses `total_cost_usd`)
- [x] Session stats section in TaskPanel (cost, turns, context %, lines changed)
- [x] Create `CostCard.tsx` — generates shareable card on session idle
  - [x] Session name, cost, duration, turns, model, backend, lines changed
  - [x] HTML canvas → PNG export with Campfire watermark
- [x] Cost display in both `TaskPanel.tsx` and `TopBar.tsx`
- [x] Session start time tracking in store + ws.ts
- [x] Playground mocks for CostCard component

---

## Phase 2 (Weeks 4-6): Collaboration Layer

### 2.1 Presence Indicators
- [x] Track connected viewers per session — viewer IDs, names, roles stored on browser socket data
- [x] Broadcast `presence_update` on connect/disconnect — `broadcastPresence()` in ws-bridge
- [x] Show avatars/initials of connected users in TopBar — role-based coloring (owner=primary, collaborator=success, spectator=muted)
- [x] Add `PresenceViewer` type and `presence_update`/`role_assigned` browser message types to `session-types.ts`
- [x] Store: `sessionViewers`, `myRole`, `myViewerId` state + actions
- [x] WS client: `presence_update` and `role_assigned` handlers in `ws.ts`
- [x] Playground: presence avatar mocks with role legend

### 2.2 Role-Based Access Control
- [x] Define roles: Owner / Collaborator / Spectator
  - [x] Owner: full control (first browser to connect)
  - [x] Collaborator: approve/deny + send messages (default for invite links)
  - [x] Spectator: watch-only (buttons disabled, messages blocked)
- [x] Add `SessionRole` type to `session-types.ts`
- [x] Enforce roles at `WsBridge.routeBrowserMessage()` — `SPECTATOR_BLOCKED_TYPES` static set blocks user_message, permission_response, interrupt, set_model, etc.
- [x] UI: role selector when sharing invite link (Collaborator/Spectator options in TopBar share menu)
- [x] Invite tokens carry role info — `createInviteToken(sessionId, role)`, `resolveInviteTokenRole(token)`
- [x] PermissionBanner: spectator buttons disabled with "Spectators cannot vote" indicator
- [x] Tests: RBAC enforcement (4 tests), invite token roles (3 tests)

### 2.3 Permission Voting
- [x] `VoteProgress` component in `PermissionBanner.tsx` — voting UI with countdown timer, vote counts, voter avatars
- [x] On `control_request`, all collaborators + owner see it and vote
- [x] Voting policies: majority-rules, any-deny-blocks, owner-decides — configurable via REST API
- [x] Rewrote `handlePermissionResponse()` to collect votes via `PendingVoteCollection` before relaying to agent
- [x] Vote aggregation in ws-bridge: `recordVote()`, `checkVoteResolution()`, `resolveVoteByDeadline()`, `resolvePermission()`
- [x] Browser message types: `vote_update` (broadcast vote progress), `vote_resolved` (final result)
- [x] Store: `permissionVotes`, `voteResults` state + actions
- [x] WS client: `vote_update` and `vote_resolved` handlers
- [x] REST: `GET /voting-policy`, `PUT /voting-policy` endpoints
- [x] API client: `getVotingPolicy()`, `setVotingPolicy()` methods
- [x] Tests: voting policy (2 tests)
- [x] Playground: active vote, resolved vote, spectator view mocks

### 2.4 Mobile-First PWA
- [x] PWA manifest — `public/manifest.json` updated with Campfire branding, standalone display, maskable icons
- [x] Service worker (`public/sw.js`) — stale-while-revalidate caching, pre-cached shell resources, push notification handler
- [x] Service worker registration in `main.tsx`
- [x] Touch-optimized permission approval — `min-h-[36px] sm:min-h-0` on all permission buttons
- [x] Tool blocks default-collapsed on mobile (existing behavior)
- [x] Web push notification support — service worker handles push events with allow/deny actions
- [x] "Add to Home Screen" flow — manifest.json `display: standalone` + theme color + apple-touch-icon

---

## Phase 3 (Weeks 7-10): Replay + Ecosystem

### 3.1 Visual Session Replay
- [x] Backend recording + replay utilities — `recorder.ts`, `replay.ts` (data layer exists)
- [x] Create `SessionReplay.tsx` — visual replay player UI
  - [x] Scrub through session at 1x/2x/4x/8x
  - [x] Feed messages into store with configurable delay
  - [x] Export as shareable link
- [x] Replay REST endpoints in `routes.ts` — `GET /api/recordings/:filename`, `GET /api/sessions/:id/history`
- [x] Replay store state in `store.ts` — `replaySpeed`, `replayState`, `replaySessionId`
- [x] API client methods in `api.ts` — `getRecording()`, `getSessionHistory()`, `listRecordings()`
- [x] App routing — `#/replay/:filename`, `#/replay/session/:id`
- [x] Sidebar recordings browser — collapsible section with recording list
- [x] Playground mocks — replay controls, header bar, fork-from-message hover icon

### 3.2 Fork & Branch
- [x] Worktree creation support — `worktree-tracker.ts` (foundation exists)
- [x] `--resume` support in `cli-launcher.ts` (foundation exists)
- [x] Fork any live session or replay at any point — `POST /api/sessions/:id/fork` endpoint
- [x] Create new session on new worktree from fork point — `seedMessageHistory()` in ws-bridge
- [x] Fork REST endpoint in `routes.ts` — truncates history, creates worktree, launches new session
- [x] UI: "Fork" button in TopBar + "Fork from here" icon on each message in MessageBubble/MessageFeed
- [x] `forkedFrom` field added to `SdkSessionInfo` in `types.ts`

### 3.3 Additional Adapters (community-driven)
- [x] Aider adapter — `aider-adapter.ts` — CLI stdin/stdout, SEARCH/REPLACE block parsing, prompt detection
- [x] OpenHands adapter — `openhands-adapter.ts` — ACP/JSON-RPC over stdio, same protocol as Goose
- [x] Adapter contribution guide — `server/ADAPTERS.md` — step-by-step guide with examples
- [x] Wiring: both adapters integrated into `cli-launcher.ts`, `session-types.ts`, `routes.ts`, `backends.ts`, `api.ts`, `CronManager.tsx`, `project-grouping.ts`

---

## Phase 4 (Months 3-5): The Flywheel

### 4.1 Session Gallery
- [x] Public gallery page of best sessions (`#/gallery` route)
- [x] Each entry: cost, time, model, agent, lines changed, replay link
- [x] Voting + featuring system (anonymous IP-hashed deduplication)
- [x] `server/gallery-store.ts`, `server/gallery-votes.ts`, `server/gallery-types.ts`
- [x] `src/components/GalleryPage.tsx`, `src/components/GalleryCard.tsx`
- [x] Filter by backend/cost/tags, sort by votes/recent/cost/duration
- [x] 27 backend tests

### 4.2 Adapter Registry
- [x] Community adapters as npm packages conforming to `AgentAdapter`
- [x] `campfire install-adapter <package>` / `uninstall-adapter <name>` CLI
- [x] `server/adapter-registry.ts`, `server/adapter-registry-types.ts`
- [x] `src/components/AdapterManager.tsx` (`#/adapters` route)
- [x] REST endpoints: GET/POST/DELETE `/api/adapters`
- [x] 34 backend tests

### 4.3 Webhooks & API
- [x] REST API for webhook CRUD + toggle + test
- [x] Webhooks for: session.created/completed/failed, permission.requested/resolved, turn.completed, cost.threshold
- [x] HMAC-SHA256 signing, retry with exponential backoff (1s/5s/15s)
- [x] Slack payload formatting, session filter (backend/cwd)
- [x] `server/webhook-store.ts`, `server/webhook-manager.ts`, `server/webhook-types.ts`
- [x] `src/components/WebhookManager.tsx` (`#/webhooks` route)
- [x] Hooks in ws-bridge.ts at 5 lifecycle points
- [x] 28 backend tests

---

## Verification Checklist

- [~] Goose adapter: Create session → streaming works → permission banner renders → model switching works (code complete, needs manual verification)
- [~] Shareable links: Two browsers → same session URL → both see real-time updates (code complete, needs manual verification)
- [~] Cost cards: Session completes → cost card generates → shareable image downloads (code complete, needs manual verification)
- [~] Mobile PWA: Phone → add to home screen → permission approval works with touch (code complete, needs manual verification)
- [~] Permission voting: Two collaborators → both vote → result relayed to agent (code complete, needs manual verification)
- [~] Visual replay: Complete session → open replay → scrub at 4x → all tool calls render (code complete, needs manual verification)
- [~] Fork: Mid-session fork → new session on new worktree from that point (code complete, needs manual verification)
- [x] Recording: Session completes → JSONL file exists with full message history
- [x] Cron: Schedule a job → session runs automatically at scheduled time
- [x] Tests: `bun run test` passes, `bun run typecheck` passes
- [~] Gallery: Create session → "Add to Gallery" → gallery page shows card → vote → filter → replay (code complete, needs manual verification)
- [~] Webhooks: Create webhook → session event fires → HTTP POST received → test button works (code complete, needs manual verification)
- [~] Adapter Registry: `campfire install-adapter <pkg>` → adapter in `/api/backends` → `campfire uninstall-adapter <name>` (code complete, needs manual verification)

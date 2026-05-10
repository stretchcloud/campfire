# Multi-Agent Orchestrator — Architecture Document

**Branch**: `feature/Multi-Agent-Orchestrator`
**Date**: 2026-04-12
**Status**: DRAFT — Awaiting approval before implementation

---

## Executive Summary

This document describes the architecture for transforming Campfire from a multi-agent *chat platform* into a multi-agent *orchestration platform*. The core thesis: **agents should be able to call other agents as tools, race against each other, and auto-provision the right environment — all through Campfire's existing adapter layer.**

Six features are planned across three phases. Phase 1 focuses on the unique capabilities only a multi-agent platform can deliver.

---

## Existing Infrastructure (What We Have)

| Component | File(s) | Status |
|---|---|---|
| `AgentAdapter` interface | `adapter-types.ts` | 7 implementations (Claude, Codex, Goose, Aider, OpenHands, OpenClaw, OpenCode) |
| Community adapter registry | `adapter-registry.ts` | npm-based install, `campfireAdapter` field in package.json |
| Session lifecycle | `cli-launcher.ts` | `launch()`, `relaunch()`, process tracking, env persistence |
| WebSocket bridge | `ws-bridge.ts` | `attachAdapter()`, message routing, protocol normalization |
| Git worktrees | `git-utils.ts`, `worktree-tracker.ts` | `ensureWorktree()`, `removeWorktree()`, session-to-worktree mapping |
| Agent profiles | `agent-store.ts`, `agent-executor.ts` | CRUD, cron/webhook triggers, execution history |
| Container sandboxing | `container-manager.ts` | Docker create/remove, port mapping, volume mounts |
| Terminal | `terminal-manager.ts` | PTY spawn, WebSocket streaming |
| Diff view | `DiffPanel.tsx`, `DiffViewer.tsx` | Side-by-side diff with file tree |
| Session replay | `recorder.ts`, `replay.ts` | JSONL recording, 1x/2x/4x/8x playback |
| Permission voting | `ws-bridge.ts` | Multi-viewer, majority-rules/any-deny/owner-decides |

---

## Phase 1: Unique Multi-Agent Capabilities

### Feature 1: Agent-as-MCP-Server (Agents Calling Agents)

**The headline feature.** Each agent backend is exposed as an MCP tool that other agents can invoke. A Claude Code session can delegate subtasks to Codex, Goose, or Aider — and get results back as tool results.

#### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Lead Session                           │
│              (e.g. Claude Code, Opus)                     │
│                                                          │
│   Normal tools: Read, Write, Bash, ...                   │
│   Injected tools: ask_codex, ask_goose, ask_aider, ...   │
│                          │                                │
│                          │ tool_use: ask_codex             │
│                          ▼                                │
│   ┌──────────────────────────────────────────────┐       │
│   │          AgentMcpBridge                       │       │
│   │                                              │       │
│   │  1. Receive tool call from lead session      │       │
│   │  2. Spawn sub-session (target backend)       │       │
│   │  3. Inject prompt from tool input            │       │
│   │  4. Wait for completion (result message)     │       │
│   │  5. Collect output (text + file changes)     │       │
│   │  6. Return as tool_result to lead session    │       │
│   │  7. Kill sub-session                         │       │
│   └──────────────────────────────────────────────┘       │
│                          │                                │
│                          │ tool_result                     │
│                          ▼                                │
│   Lead session continues with sub-agent's output          │
└──────────────────────────────────────────────────────────┘
```

#### New Files

| File | Purpose |
|---|---|
| `web/server/agent-mcp-bridge.ts` | Core orchestration: intercepts `ask_*` tool calls from lead sessions, spawns sub-sessions, collects results, returns tool results |
| `web/server/agent-mcp-tools.ts` | Tool definitions for each backend (`ask_codex`, `ask_goose`, etc.) with schemas |
| `web/server/sub-session-manager.ts` | Manages sub-session lifecycle: spawn, timeout, cleanup. Tracks parent-child relationships |

#### Integration Points

1. **Tool injection**: When Claude Code sends `system.init`, the bridge inspects available backends and injects `ask_*` tools into the session's tool list via `control_request` (subtype `inject_tools`) or by pre-configuring `~/.claude.json` MCP servers before spawn.

2. **Tool call interception**: In `ws-bridge.ts`, when a `control_request` (subtype `can_use_tool`) arrives for an `ask_*` tool, the bridge:
   - Auto-approves the permission (these are internal orchestration tools)
   - Spawns a sub-session via `CliLauncher.launch()` in the same worktree
   - Sends the prompt to the sub-session
   - Waits for a `result` message
   - Collects the sub-session's text output and file changes
   - Returns a `control_response` with the combined output as tool result

3. **Worktree sharing**: Sub-sessions run in the **same working directory** as the lead session (shared filesystem). File changes are immediately visible to the lead agent.

4. **UI visibility**: Sub-sessions appear in the TaskPanel as "background agents" with their own streaming output. The existing `BackgroundAgentItem` type and `sessionBackgroundAgents` store field support this.

5. **Timeout & cleanup**: Sub-sessions have a configurable timeout (default 5 minutes). If a sub-session exceeds the timeout, it's killed and an error result is returned to the lead agent.

#### Tool Schema (per backend)

```typescript
{
  name: "ask_codex",
  description: "Delegate a coding subtask to Codex (OpenAI). Fast and cost-effective for focused code generation, scripts, and database schemas. Runs in the same working directory.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Clear, specific task description for Codex"
      },
      timeout_seconds: {
        type: "number",
        description: "Max time to wait (default: 300)",
        default: 300
      }
    },
    required: ["prompt"]
  }
}
```

#### Sequence Diagram

```
Lead (Claude)          AgentMcpBridge         CliLauncher          Sub (Codex)
     │                      │                      │                    │
     │ tool_use: ask_codex  │                      │                    │
     │─────────────────────→│                      │                    │
     │                      │ launch(codex, cwd)   │                    │
     │                      │─────────────────────→│                    │
     │                      │                      │ spawn process      │
     │                      │                      │───────────────────→│
     │                      │                      │ adapter attached   │
     │                      │                      │←──────────────────│
     │                      │ inject prompt         │                    │
     │                      │─────────────────────→│                    │
     │                      │                      │ user_message       │
     │                      │                      │───────────────────→│
     │                      │                      │                    │
     │                      │                      │   ...working...    │
     │                      │                      │                    │
     │                      │                      │ result message     │
     │                      │←─────────────────────│←──────────────────│
     │                      │                      │                    │
     │                      │ collect file changes  │                    │
     │                      │ kill sub-session      │                    │
     │                      │─────────────────────→│                    │
     │                      │                      │                    │
     │ tool_result           │                      │                    │
     │←─────────────────────│                      │                    │
     │                      │                      │                    │
     │ continues working... │                      │                    │
```

#### Key Design Decisions

- **Same worktree, not forked**: Sub-agents work in the lead's worktree so file changes are immediately visible. This enables collaboration (e.g., Codex writes schema, Claude reads it and writes API).
- **One turn only**: Sub-sessions execute a single prompt and return. No multi-turn conversation. This keeps orchestration simple and predictable.
- **Auto-approve permissions**: Sub-agent tool calls are auto-approved. The lead agent has already been granted permission to delegate.
- **Cost tracking**: Sub-session costs are tracked separately and attributed to the parent session as `sub_agent_cost`.

---

### Feature 2: Parallel Agent Races (Fork & Compare)

**Race multiple agents against each other on the same task.** Each agent gets its own worktree. User compares results and picks the winner.

#### Architecture

```
┌────────────────────────────────────────────────────────┐
│                    RaceController                       │
│                                                        │
│  Input: prompt + list of backends                      │
│                                                        │
│  1. Fork N git worktrees from current HEAD             │
│  2. Create N sessions (one per backend, one per wt)    │
│  3. Inject identical prompt to each                    │
│  4. Monitor all sessions for completion                │
│  5. Collect metrics: time, cost, files, test results   │
│  6. Present comparison view                            │
│  7. User picks winner → merge worktree to main         │
│  8. Clean up loser worktrees                           │
│  9. Log results to routing intelligence DB             │
│                                                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐         │
│  │ Session A  │ │ Session B  │ │ Session C  │         │
│  │ Claude     │ │ Codex      │ │ Goose      │         │
│  │ wt/race-a  │ │ wt/race-b  │ │ wt/race-c  │         │
│  └────────────┘ └────────────┘ └────────────┘         │
└────────────────────────────────────────────────────────┘
```

#### New Files

| File | Purpose |
|---|---|
| `web/server/race-controller.ts` | Orchestrates races: fork worktrees, create sessions, inject prompts, monitor completion, collect metrics |
| `web/server/race-store.ts` | Persists race definitions and results to `~/.campfire/races/` |
| `web/server/routes/race-routes.ts` | REST API: create race, get status, pick winner, list races |
| `web/src/components/RacePage.tsx` | Race creation UI + comparison view |
| `web/src/components/RaceComparison.tsx` | Side-by-side comparison: diff, cost, time, test results |

#### Race Lifecycle

1. **Create**: User selects 2-3 backends and enters a prompt
2. **Fork**: `RaceController` calls `gitUtils.ensureWorktree()` for each backend
3. **Launch**: Calls `launcher.launch()` for each, with the worktree as `cwd`
4. **Prompt**: Injects identical prompt via `wsBridge.injectUserMessage()`
5. **Monitor**: Watches for `result` messages on each session (via webhook or polling)
6. **Metrics**: On completion, collects:
   - Wall clock time
   - API cost (`total_cost_usd`)
   - Files changed (`git diff --stat` in worktree)
   - Test results (optional: run `npm test` in worktree)
   - Lint results (optional: run `eslint` in worktree)
7. **Compare**: UI shows side-by-side metrics with diff view per agent
8. **Merge**: User picks winner → `git merge` winner's worktree branch into main
9. **Cleanup**: Remove all race worktrees
10. **Log**: Save race result to routing intelligence DB

#### Race Result Schema

```typescript
interface RaceResult {
  raceId: string;
  prompt: string;
  repoRoot: string;
  baseBranch: string;
  createdAt: number;
  completedAt?: number;
  entries: RaceEntry[];
  winnerId?: string;  // sessionId of winner
}

interface RaceEntry {
  sessionId: string;
  backendType: BackendType;
  model: string;
  worktreePath: string;
  branch: string;
  status: "running" | "completed" | "failed" | "timeout";
  startedAt: number;
  completedAt?: number;
  metrics?: {
    wallClockMs: number;
    costUsd: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    testsPassed?: number;
    testsFailed?: number;
    lintWarnings?: number;
    lintErrors?: number;
  };
}
```

---

### Feature 3: Live Environment Injection (Auto-Detect & Provision)

**Scan the project on session start and auto-inject the right MCP servers and tools.**

#### Architecture

```
┌────────────────────────────────────────────────┐
│            EnvironmentDetector                  │
│                                                │
│  Input: session cwd                            │
│                                                │
│  1. Scan project files (package.json, .env,    │
│     docker-compose.yml, prisma/, fly.toml)     │
│  2. Match against detection rules              │
│  3. Build list of MCP server configs           │
│  4. Return recommendations to session          │
│                                                │
│  Detection Rules:                              │
│  ┌──────────────────────────────────────────┐  │
│  │ package.json → "next" → Vercel MCP       │  │
│  │ .env → SUPABASE_URL → Supabase MCP      │  │
│  │ .env → STRIPE_SECRET_KEY → Stripe MCP    │  │
│  │ prisma/schema.prisma → Prisma MCP        │  │
│  │ docker-compose.yml → Docker MCP          │  │
│  │ fly.toml → Fly.io MCP                    │  │
│  │ Dockerfile → Docker build tools          │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

#### New Files

| File | Purpose |
|---|---|
| `web/server/environment-detector.ts` | Scans project directory, matches against rules, returns MCP configs |
| `web/server/environment-rules.ts` | Detection rule definitions (extensible, community-contributed) |

#### Integration

- Called during `CliLauncher.launch()` before spawning the process
- Detected MCP servers are merged into the session's MCP config
- For backends that support MCP natively (Claude, Goose): configs injected via CLI args or config file
- For backends without MCP (Aider): Campfire acts as MCP client, proxying tool calls

#### Detection Rule Schema

```typescript
interface DetectionRule {
  id: string;
  name: string;
  description: string;
  detect: (ctx: ProjectContext) => boolean;
  mcpServer?: McpServerConfig;
  envRequired?: string[];  // env vars needed for the MCP server
}

interface ProjectContext {
  cwd: string;
  files: string[];           // top-level files
  packageJson?: PackageJson;
  envVars?: Record<string, string>;  // from .env files
  hasDocker: boolean;
  hasPrisma: boolean;
}
```

---

## Phase 2: App Factory (Weeks 5-8)

### Feature 4: One-Click Deploy Integrations

Deploy from session to Vercel, Fly.io, Railway, or Render via MCP tools or REST API.

**New files**: `web/server/deploy/vercel-deployer.ts`, `web/server/deploy/flyio-deployer.ts`, `web/server/routes/deploy-routes.ts`

### Feature 5: Auto-Provision Databases

When a project needs a database, auto-provision Supabase/Neon/PlanetScale and inject credentials.

**New files**: `web/server/provision/supabase-provisioner.ts`, `web/server/provision/neon-provisioner.ts`

### Feature 6: Browser Preview

See the app live as the agent builds it. Proxy the session's dev server to an iframe.

**New files**: `web/server/preview-proxy.ts`, `web/src/components/BrowserPreview.tsx`

---

## Phase 3: Enterprise & Scale (Weeks 9-12)

### Feature 7: BYOC Protocol

Lightweight daemon (`campfire-agent`) that runs on any machine and connects to Campfire via WebSocket tunnel.

### Feature 8: Session-as-Environment

Full IDE experience: Monaco editor pane synced to agent edits, terminal, preview, and chat in one layout.

### Feature 9: Routing Intelligence

Learn from race results. Build a database of "backend X is best for task type Y."

---

## Data Flow — Full Orchestration

```
User creates session
        │
        ▼
EnvironmentDetector scans project
        │
        ├─ Detected: Supabase → inject Supabase MCP
        ├─ Detected: Stripe → inject Stripe MCP
        ├─ Detected: Next.js → inject Vercel MCP
        │
        ▼
CliLauncher spawns lead agent (e.g. Claude Code)
        │
        ▼
Lead agent starts working
        │
        ├─ Needs DB schema → calls ask_codex("Create Prisma schema...")
        │   └─ AgentMcpBridge spawns Codex sub-session in same worktree
        │       └─ Codex generates schema.prisma + migration
        │           └─ Result returned to Claude Code
        │
        ├─ Needs deployment config → calls ask_goose("Create fly.toml...")
        │   └─ AgentMcpBridge spawns Goose sub-session
        │       └─ Goose generates fly.toml + Dockerfile
        │           └─ Result returned to Claude Code
        │
        ├─ Claude reads generated files, writes API routes
        │
        └─ User clicks "Deploy" → Vercel MCP deploys the app
```

---

## File System Layout (New Files)

```
web/server/
├── agent-mcp-bridge.ts          # Phase 1: Agent-as-MCP-Server orchestration
├── agent-mcp-tools.ts           # Phase 1: Tool definitions for ask_* tools
├── sub-session-manager.ts       # Phase 1: Sub-session lifecycle management
├── race-controller.ts           # Phase 1: Parallel agent race orchestration
├── race-store.ts                # Phase 1: Race persistence
├── environment-detector.ts      # Phase 1: Project scanning & MCP injection
├── environment-rules.ts         # Phase 1: Detection rule definitions
├── routes/
│   └── race-routes.ts           # Phase 1: Race REST API
├── deploy/                      # Phase 2: Deploy integrations
│   ├── vercel-deployer.ts
│   └── flyio-deployer.ts
├── provision/                   # Phase 2: Database provisioning
│   ├── supabase-provisioner.ts
│   └── neon-provisioner.ts
└── preview-proxy.ts             # Phase 2: Browser preview proxy

web/src/components/
├── RacePage.tsx                  # Phase 1: Race creation + management
├── RaceComparison.tsx            # Phase 1: Side-by-side comparison view
├── EnvironmentPanel.tsx          # Phase 1: Show detected environment
└── BrowserPreview.tsx            # Phase 2: Live app preview iframe
```

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| MCP tool injection varies by backend | Medium | For Claude: `--mcp-config`. For others: Campfire proxies MCP calls via adapter |
| Sub-session timeout / hang | Medium | Hard timeout (5 min default), process kill, error result |
| Race worktree cleanup failure | Low | Force-remove on race completion, periodic GC |
| Cost runaway from sub-agents | Medium | Per-sub-session cost cap, total race budget limit |
| Concurrent worktree conflicts | Low | Each race/sub-session gets unique branch name (`*-wt-XXXX`) |
| Environment detection false positives | Low | Detection is opt-in recommendation, user can dismiss |

---

## Success Metrics

1. **Agent-as-MCP-Server**: A Claude Code session successfully delegates to Codex and uses the result — end-to-end in < 60 seconds
2. **Parallel Races**: 3-agent race completes, comparison view shows meaningful metrics, user merges winner
3. **Environment Injection**: Session auto-detects Supabase project and injects MCP server without user configuration

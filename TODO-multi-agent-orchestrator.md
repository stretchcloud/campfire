# TODO — Multi-Agent Orchestrator Implementation

**Branch**: `feature/Multi-Agent-Orchestrator`
**Architecture**: See `ARCHITECTURE-multi-agent-orchestrator.md`
**Status**: AWAITING APPROVAL

---

## Phase 1: Unique Multi-Agent Capabilities (Weeks 1-4)

### 1.1 Agent-as-MCP-Server (Agents Calling Agents)

- [ ] **1.1.1** Create `web/server/agent-mcp-tools.ts` — tool definitions
  - Define `ask_codex`, `ask_goose`, `ask_aider`, `ask_openhands`, `ask_claude` tool schemas
  - Each tool has: name, description (explains agent strengths), input schema (prompt, timeout)
  - Export function to generate tool list based on available/installed backends

- [ ] **1.1.2** Create `web/server/sub-session-manager.ts` — sub-session lifecycle
  - `spawnSubSession(parentId, backendType, prompt, cwd, opts)` — launch, inject prompt, return promise
  - Track parent-child session relationships in a Map
  - Wait for `result` message from sub-session (via event listener on WsBridge)
  - Collect text output from the sub-session's message history
  - Collect file changes via `git diff` in the working directory
  - Kill sub-session on completion or timeout (default 5 min, configurable)
  - Return `SubSessionResult { text, filesChanged, costUsd, durationMs, error? }`

- [ ] **1.1.3** Create `web/server/agent-mcp-bridge.ts` — orchestration core
  - Hook into `ws-bridge.ts` CLI message handler
  - Intercept `control_request` where `tool_name` starts with `ask_`
  - Auto-approve the permission request
  - Call `SubSessionManager.spawnSubSession()` with the tool input
  - Format result as `control_response` with tool_result content
  - Send response back to lead session's CLI WebSocket
  - Track sub-agent costs and attribute to parent session

- [ ] **1.1.4** Integrate into `ws-bridge.ts` and `index.ts`
  - Instantiate `AgentMcpBridge` in server bootstrap
  - Wire it into `WsBridge` via a `setAgentMcpBridge()` setter
  - Add interception point in `handleControlRequest()` for `ask_*` tools

- [ ] **1.1.5** Tool injection mechanism for Claude Code sessions
  - Option A: Generate a temporary MCP config file with `ask_*` tools before spawning Claude
  - Option B: Intercept `system.init` and modify the tools list in the broadcast
  - Evaluate which approach works with Claude Code's tool discovery

- [ ] **1.1.6** UI — sub-session visibility in TaskPanel
  - Show active sub-sessions in TaskPanel under "Sub-Agents" section
  - Display: backend type, prompt snippet, status (running/completed/failed), cost
  - Link to sub-session's full chat view for debugging

- [ ] **1.1.7** Tests
  - Unit test: `SubSessionManager` spawn/timeout/cleanup
  - Unit test: `AgentMcpBridge` tool call interception and response formatting
  - Integration test: end-to-end tool call → sub-session → result flow (mock adapters)

---

### 1.2 Parallel Agent Races (Fork & Compare)

- [ ] **1.2.1** Create `web/server/race-store.ts` — race persistence
  - `RaceDefinition` and `RaceResult` types
  - CRUD operations: create, get, list, update, delete
  - Storage: `~/.campfire/races/{raceId}.json`

- [ ] **1.2.2** Create `web/server/race-controller.ts` — race orchestration
  - `startRace(prompt, backends[], repoRoot, baseBranch)` — main entry point
  - Fork N worktrees via `gitUtils.ensureWorktree()` with `race-{backend}-{raceId}` branch names
  - Create N sessions via `launcher.launch()`, one per backend/worktree
  - Inject identical prompt to each via `wsBridge.injectUserMessage()`
  - Monitor for completion: listen for `result` messages on each session
  - On completion: collect metrics (time, cost, files changed, lines added/removed)
  - Optional: run test command in each worktree and capture pass/fail counts
  - `pickWinner(raceId, sessionId)` — merge winning worktree, cleanup losers
  - `cancelRace(raceId)` — kill all race sessions, cleanup worktrees

- [ ] **1.2.3** Create `web/server/routes/race-routes.ts` — REST API
  - `POST /api/races` — create and start a race
  - `GET /api/races` — list all races
  - `GET /api/races/:id` — get race status and metrics
  - `POST /api/races/:id/pick` — pick winner, merge, cleanup
  - `POST /api/races/:id/cancel` — cancel running race
  - `DELETE /api/races/:id` — delete race record

- [ ] **1.2.4** Create `web/src/components/RacePage.tsx` — race creation UI
  - Backend selector (checkboxes for available backends)
  - Prompt input
  - "Start Race" button
  - Race list with status indicators

- [ ] **1.2.5** Create `web/src/components/RaceComparison.tsx` — comparison view
  - Side-by-side cards for each agent's result
  - Metrics: time, cost, files changed, lines, test results
  - Per-agent diff viewer (using existing DiffViewer component)
  - "Merge This Result" button per agent
  - Live progress while race is running (streaming status per agent)

- [ ] **1.2.6** Add route `#/races` and `#/races/:id` to `App.tsx`

- [ ] **1.2.7** Tests
  - Unit test: `RaceController` worktree forking and cleanup
  - Unit test: `RaceStore` CRUD
  - Integration test: 2-agent race with mock backends

---

### 1.3 Live Environment Injection (Auto-Detect & Provision)

- [ ] **1.3.1** Create `web/server/environment-rules.ts` — detection rules
  - Define rule interface: `{ id, name, detect(ctx), mcpServer?, envRequired? }`
  - Implement rules for:
    - `supabase` — detect `SUPABASE_URL` in .env files
    - `stripe` — detect `STRIPE_SECRET_KEY` in .env files or `stripe` in package.json deps
    - `vercel` — detect `vercel.json` or `next` in package.json
    - `prisma` — detect `prisma/schema.prisma`
    - `docker` — detect `docker-compose.yml` or `Dockerfile`
    - `flyio` — detect `fly.toml`
    - `github-actions` — detect `.github/workflows/`
    - `database` — detect `DATABASE_URL` in .env

- [ ] **1.3.2** Create `web/server/environment-detector.ts` — project scanner
  - `detectEnvironment(cwd)` — scan project root, match rules, return recommendations
  - Parse `.env`, `.env.local`, `.env.development` for env vars
  - Parse `package.json` for dependencies
  - Return `DetectedEnvironment { rules: MatchedRule[], mcpServers: McpServerConfig[] }`

- [ ] **1.3.3** Integrate into session creation flow
  - Call `detectEnvironment()` in `CliLauncher.launch()` before spawning
  - Merge detected MCP servers into session's MCP config
  - For Claude: write to temporary `~/.claude.json` MCP config or use `--mcp-config`
  - For Codex/Goose: pass via adapter options if supported
  - Store detected environment in session state for UI display

- [ ] **1.3.4** Create `web/src/components/EnvironmentPanel.tsx` — UI
  - Show detected services in TaskPanel or as a collapsible section
  - Icons for each service (Supabase, Stripe, Vercel, etc.)
  - Status: "Auto-detected", "Connected", "Not configured" (missing env vars)
  - Allow user to dismiss/disable individual detections

- [ ] **1.3.5** Add detection results to session creation REST response

- [ ] **1.3.6** Tests
  - Unit test: each detection rule against mock project structures
  - Unit test: `detectEnvironment()` with various project layouts
  - Integration test: session creation with auto-detected MCP servers

---

## Phase 2: App Factory (Weeks 5-8)

### 2.1 One-Click Deploy Integrations

- [ ] **2.1.1** Create `web/server/deploy/vercel-deployer.ts`
- [ ] **2.1.2** Create `web/server/deploy/flyio-deployer.ts`
- [ ] **2.1.3** Create `web/server/routes/deploy-routes.ts`
- [ ] **2.1.4** UI: Deploy button in TopBar with provider selection

### 2.2 Auto-Provision Databases

- [ ] **2.2.1** Create `web/server/provision/supabase-provisioner.ts`
- [ ] **2.2.2** Create `web/server/provision/neon-provisioner.ts`
- [ ] **2.2.3** Integrate into environment detector (offer to provision when DB detected but not configured)

### 2.3 Browser Preview

- [ ] **2.3.1** Create `web/server/preview-proxy.ts` — HTTP proxy for session dev servers
- [ ] **2.3.2** Create `web/src/components/BrowserPreview.tsx` — iframe with proxy URL
- [ ] **2.3.3** Auto-detect dev server port from agent output (Vite: 5173, Next: 3000, etc.)

---

## Phase 3: Enterprise & Scale (Weeks 9-12)

### 3.1 BYOC Protocol

- [ ] **3.1.1** Design BYOC WebSocket tunnel protocol
- [ ] **3.1.2** Create `campfire-agent` daemon (separate package)
- [ ] **3.1.3** Server-side tunnel manager
- [ ] **3.1.4** Auth token management

### 3.2 Routing Intelligence

- [ ] **3.2.1** Create `web/server/routing-intelligence.ts` — SQLite DB for race results
- [ ] **3.2.2** Log every race result with task classification
- [ ] **3.2.3** Query API: "which backend is best for task type X?"
- [ ] **3.2.4** Auto-suggest backend on session creation based on prompt analysis

---

## Implementation Order (Phase 1)

Priority order within Phase 1:

```
1.3 Environment Injection  ←── lowest effort, highest immediate UX value
    │
    ▼
1.1 Agent-as-MCP-Server    ←── the headline feature, needs 1.3 for full impact
    │
    ▼
1.2 Parallel Agent Races   ←── builds on 1.1, proves multi-agent value with data
```

**Rationale**: Environment injection is a standalone improvement (1 week). Agent-as-MCP-Server is the core feature that defines the platform (2 weeks). Races build on both and produce the most compelling demo content (2 weeks).

---

## Definition of Done (per feature)

- [ ] TypeScript compiles with no errors
- [ ] SonarQube analysis passes with 0 issues (run `run_advanced_code_analysis`)
- [ ] Tests written and passing
- [ ] UI components added to Playground page
- [ ] CLAUDE.md updated if architecture section changes
- [ ] Feature works with both Claude Code and Codex backends at minimum

# Campfire Testing Guide - UI Walkthrough

This guide shows you exactly where each feature is in the UI and how to test it without using APIs directly.

---

## Prerequisites

```bash
cd ~/campfire/web
bun install
bun run dev

# Opens:
# - Backend: http://localhost:3456
# - Frontend: http://localhost:5174
```

Access the app at: **http://localhost:5174**

---

## Phase 1: Basic Session Creation & Chat ✅ UI READY

### Location: Home Page (`#/`)

**Steps:**
1. Open http://localhost:5174 (or click logo in sidebar)
2. Click **"New Session"** button (big blue button)
3. Fill out the form:
   - **Backend**: Select from dropdown (Claude Code, Codex, Goose, Aider, etc.)
   - **Model**: Select from dropdown (sonnet-4-5, opus-4-6, etc.)
   - **Working Directory**: Click folder icon to browse, or type path
   - **Environment**: (Optional) Select environment profile
   - **Permission Mode**: Choose voting policy
     - `dontAsk` - No prompts, auto-approve
     - `default` - Prompt for each tool
     - `majority-rules` - Multi-viewer voting
4. Click **"Create Session"**

**What you'll see:**
- Session starts, chat interface loads
- Green dot in top-left (connected)
- Session name in header
- Composer at bottom

**Test chat:**
- Type: "List files in the current directory"
- Press Enter or click Send
- Agent responds with file list

---

## Phase 2: Multi-Backend Support ✅ UI READY

### Location: Session Creation Form

**Steps:**
1. Create multiple sessions with different backends
2. Each backend option in the dropdown shows:
   - Backend name (Claude Code, Codex, Goose, etc.)
   - Availability status (✓ Available or ✗ Not installed)
   - Model options update based on backend selected

**Supported backends:**
- **Claude Code** - Anthropic's official CLI
- **Codex** - Codex app-server (JSON-RPC)
- **Goose** - Goose ACP
- **Aider** - Aider stdout parsing
- **OpenHands** - OpenHands ACP
- **OpenClaw** - OpenClaw protocol

---

## Phase 3: Semantic Memory ✅ UI READY

### Location: Memory Page (`#/memory`)

**How it works:**
- Semantic memory extraction happens automatically in the background
- Every agent message is processed for observations
- Memory fragments stored in `~/.campfire/memory/lancedb/`
- Cross-session memory retrieval injects context into prompts automatically

**Access UI:**
1. Click **"Memory"** in sidebar (document with lines icon)
2. Or navigate to `#/memory`

**Features:**
- **Fragments Tab**: View all episodic memory fragments
  - Filter by tags (click tag badges)
  - Search memory with natural language queries
  - Color-coded by type (observation/hypothesis/decision/pattern)
  - Shows confidence score, timestamp, affected files
- **Consolidated Tab**: View synthesized knowledge
  - Grouped by semantic tags
  - Shows source fragment count
  - Confidence scores
  - Last updated timestamps
- **Consolidate Button**: Manually trigger consolidation

**Test:**
```bash
# Session 1:
Type: "Read web/server/semantic-memory.ts and explain what it does"

# Navigate to #/memory
# Should see: New fragments appear with observations about the file

# Session 2 (different session, same repo):
Type: "What do you know about semantic memory in this codebase?"

# Agent's response enriched with memory context from Session 1
```

---

## Phase 4: Deliberation Engine ✅ UI READY

### Location: Chat timeline (appears automatically when agent proposes deliberation)

**How it works:**
- When an agent needs to make a significant decision (refactor, delete, architecture change)
- Agent emits a `deliberation_proposal` message
- `DeliberationCard` appears in the chat timeline with warning border

**Features:**
- **Proposal Display**:
  - Action type badge (refactor/feature/fix/investigate/delete/architect)
  - Title and description
  - Proposed approach (collapsible)
  - Alternatives with trade-offs
  - Risks highlighted in red
  - Affected files list
  - Time left until deadline (if set)

- **Response UI**:
  - Stance buttons: ✓ Agree / ✗ Disagree / ⚠ Suggest / ○ Abstain
  - Reasoning text area
  - Alternative approach field (if suggesting)
  - Vote tally shows real-time counts

- **Resolution**:
  - Auto-resolves when deadline reached or all parties responded
  - Manual "Resolve Now" button for owner
  - Final outcome: approved / rejected / synthesized

**Test:**
```bash
# Manually trigger via API (agents don't emit this yet):
curl -X POST http://localhost:3456/api/sessions/SESSION_ID/deliberations \
  -H "Content-Type: application/json" \
  -d '{
    "action": "refactor",
    "title": "Split semantic-memory.ts into modules",
    "description": "File is getting too large, should split into separate concerns",
    "approach": "Create memory-store.ts, memory-query.ts, memory-consolidate.ts",
    "alternatives": [{"description": "Keep as one file", "tradeoffs": "Easier to navigate, harder to test"}],
    "risks": ["Breaking changes", "Import order issues"],
    "affectedFiles": ["web/server/semantic-memory.ts"]
  }'

# In browser chat timeline: DeliberationCard appears
# Click stance, enter reasoning, submit
# Click "Resolve Now" to see resolution
```

---

## Phase 5: Capability Discovery & Task Routing ✅ UI READY

### Location: Task Router Page (`#/router`)

**How it works:**
- Routes complex tasks to the best-suited agent backend
- Uses self-reported capabilities + historical performance + real-time probing
- Scoring: selfReported × 0.3 + historical × 0.4 + context × 0.2 + cost × 0.1

**Access UI:**
1. Click **"Router"** in sidebar (lightning bolt icon)
2. Or navigate to `#/router`

**Features:**
- **Left Panel - Task Input**:
  - Large text area for task description
  - Session selection (checkboxes with capability badges)
  - Shows: Backend type, strengths, tool count, context usage
  - "Select All" / "Deselect All" toggle
  - "Route Task" button

- **Right Panel - Routing Result**:
  - Winner card with trophy icon
  - Confidence percentage (0-100%)
  - Detailed reasoning explanation
  - Backend type badge
  - Alternative options ranked by confidence

**Test:**
```bash
# Prerequisites: Have 2+ active sessions running (Claude + Codex, for example)

# Navigate to #/router
1. Enter task: "Refactor a React component to use TypeScript strict mode with full type safety"
2. Select sessions (checkboxes)
3. Click "Route Task"

# Right panel shows:
# - Best session with confidence score
# - Reasoning: "Claude Sonnet has strong TypeScript capabilities..."
# - Alternative options with lower confidence

# Use this to decide which session to dispatch the task to
```

---

## Phase 6: Shared Context Stream ✅ UI READY

### Location: Collective Mind Page (`#/collective`)

**How it works:**
- Captures agent "thinking aloud" from `<thinking>` blocks
- Detects semantic relationships between thoughts
- Identifies consensus and disagreements
- Shows open questions

**Access UI:**
1. Click **"Collective"** in sidebar (circles with lines icon)
2. Or navigate to `#/collective`

**Features:**
- **Thought Stream Tab**:
  - Real-time thought feed (auto-refreshes every 5s)
  - Color-coded by source: Blue = Human, Purple = Agent
  - Fragment types: thought/observation/plan/question/answer/insight/concern
  - Consensus indicators: Green border = high agreement, Orange = controversial
  - Consensus score percentage (0-100%)
  - Semantic links as badges: "agrees with", "disagrees with", "builds on", "contradicts", "questions"
  - Thread indicators (↳ Reply to...)
  - Filter by fragment type

- **Consensus Tab**:
  - **Consensus Points** (green): Widely agreed-upon thoughts (>70% agreement)
  - **Disagreements** (orange): Conflicting thoughts with topic and summary
  - **Open Questions** (yellow): Unanswered questions from agents/humans

**Test:**
```bash
# Session with Claude Code (uses <thinking> blocks):
Type: "Think step-by-step about how to optimize database queries in this codebase"

# Navigate to #/collective
# Watch thought stream populate in real-time
# Fragments appear with type badges and consensus scores
# Semantic links show relationships between thoughts

# Multiple agents:
# Start 2+ sessions, ask related questions
# Consensus tab shows agreements/disagreements
```

---

## Phase 7: Global Prompt Library ✅ UI READY

### Location: Prompts Page (`#/prompts`)

**Steps:**
1. Click **"Prompts"** in sidebar (document icon)
2. Click **"New Prompt"** button
3. Fill out form:
   - **Name**: e.g., "Code Review"
   - **Content**: The prompt text
   - **Scope**: `global` or `project`
   - **Project Path**: (Required if scope = project)
4. Click **"Save"**

**Using prompts with @-mention:**
1. In any session composer
2. Type `@` (wait for menu to appear)
3. Type to filter prompts (e.g., `@code`)
4. Press Enter or click to insert

**Management:**
- Search prompts by name or content
- Edit inline (click prompt card)
- Delete with confirmation

---

## Phase 8: Linear Integration ✅ UI READY

### Location: Integrations Page (`#/integrations` and `#/integrations/linear`)

**Setup:**
1. Click **"Integrations"** in sidebar (puzzle icon)
2. Click **"Linear"** card
3. Get API key from: https://linear.app/settings/api
4. Paste key into input field
5. Click **"Save"**
6. Status shows **"Connected ✓"** if successful

**Using Linear:**
- API endpoints available: `/api/linear/connection`, `/api/linear/issues`
- Session creation from Linear issues not yet wired into UI
- Workaround: Manually paste issue context into session composer

**What's coming:**
- "Create from Linear Issue" button on home page
- Issue search + browse UI
- Auto-generate branch name from issue ID

---

## Phase 9: Session Features ✅ UI READY

### Location: TopBar (session header)

**9.1: Session Forking**
- **Location**: TopBar → Fork button (git branch icon)
- **Steps:**
  1. Open any active session
  2. Click fork icon in top-right
  3. Session forks with full history
  4. Automatically creates git worktree if in a repo

**9.2: Session Recording & Replay**
- **Recording**: Automatic (every session recorded to `~/.campfire/recordings/`)
- **Replay Location**: Replay Page (`#/replay`)
- **Steps:**
  1. Click logo in sidebar → Select "Replay" from dropdown
  2. Or navigate to `#/replay`
  3. Select a recording file from list
  4. Use playback controls:
     - Play/Pause
     - Speed: 1x, 2x, 4x, 8x
     - Scrubber to seek

**9.3: Session Gallery**
- **Location**: Gallery Page (`#/gallery`)
- **Steps to publish:**
  1. Click **"Gallery"** icon in TopBar (grid icon)
  2. Or navigate to `#/gallery`
  3. Click **"Publish Session"**
  4. Fill out:
     - Title
     - Description
     - Tags (comma-separated)
  5. Click **"Publish"**

- **Browse gallery:**
  - Filter by tags
  - Sort by cost, duration, votes, created date
  - Vote on entries (👍 thumbs up)
  - View session replay

---

## Phase 10: Webhooks & Automation ✅ UI READY

### Location: Webhooks Page (`#/webhooks`) and Cron Page (`#/scheduled`)

**10.1: Webhooks**
- **Location**: Navigate to `#/webhooks`
- **Steps:**
  1. Click **"New Webhook"**
  2. Fill out:
     - **URL**: Your webhook endpoint (try https://webhook.site)
     - **Events**: Select from checklist:
       - session.created
       - session.completed
       - session.failed
       - permission.requested
       - permission.resolved
       - turn.completed
       - cost.threshold
     - **Secret**: For HMAC signature verification
     - **Session Filter**: (Optional) Only trigger for specific sessions
  3. Click **"Save"**

- **Management:**
  - Enable/disable toggle
  - Edit webhook
  - Delete webhook
  - Test delivery (manual trigger button)
  - View delivery history

**10.2: Cron Scheduled Tasks**
- **Location**: Navigate to `#/scheduled`
- **Steps:**
  1. Click **"New Job"**
  2. Fill out:
     - **Name**: Job name
     - **Cron Expression**: e.g., `0 2 * * *` (daily at 2am)
       - Helper: Use https://crontab.guru to build expressions
     - **Prompt**: What to ask the agent
     - **Backend**: Which agent backend to use
     - **Model**: Which model
     - **Working Directory**: Path
     - **Environment**: (Optional) Environment profile
  3. Click **"Save"**

- **Cron expression examples:**
  - `0 2 * * *` - Daily at 2am
  - `*/30 * * * *` - Every 30 minutes
  - `0 9 * * 1` - Every Monday at 9am
  - `0 0 1 * *` - First day of every month at midnight

- **Management:**
  - Enable/disable toggle
  - Edit job
  - Delete job
  - **Manual trigger** (test now button)
  - View execution history

---

## Phase 11: Ratatui TUI Client ✅ BUILD READY

### Location: Terminal (separate application)

**Build & Run:**
```bash
cd ~/campfire/tui
cargo build --release
./target/release/campfire-tui

# Or install system-wide:
cargo install --path .
campfire-tui
```

**Key Bindings:**
- `Tab` - Switch between panels (Session List / Chat / Composer)
- `j` / `k` or `↑` / `↓` - Navigate lists
- `Enter` - Select/Open session
- `i` - Focus composer (type mode)
- `Esc` - Unfocus composer
- `Ctrl+Enter` - Send message (when composer focused)
- `y` - Approve permission
- `n` - Deny permission
- `q` or `Ctrl+C` - Quit

**What you can do:**
- View all sessions
- Open session and view chat
- Send messages
- Approve/deny permissions
- See real-time updates

---

## Phase 12: Advanced Features ✅ UI READY

### Location: Session Creation Form (Advanced Options)

**12.1: Git Worktrees**
- **Location**: Session creation form → Advanced section
- **Steps:**
  1. Expand "Advanced Options" accordion
  2. Check **"Create git worktree"**
  3. Enter **Branch name** (e.g., `feature/test-branch`)
  4. Create session
  5. Session runs in isolated branch at `.git/worktrees/campfire-SESSION_ID/`

**12.2: Docker Containers**
- **Location**: Session creation form → Advanced section
- **Prerequisites**: Docker installed (`docker --version`)
- **Steps:**
  1. Expand "Advanced Options" accordion
  2. Check **"Run in container"**
  3. Select or enter **Image** (e.g., `node:20-alpine`, `python:3.11`)
  4. Create session
  5. Session runs inside container with:
     - `~/.claude` mounted for persistence
     - Working directory mounted

**12.3: MCP Servers**
- **Location**: Task Panel → MCP Servers tab
- **Steps:**
  1. Open any session with MCP servers connected
  2. Open Task Panel (list icon in TopBar)
  3. Click **"MCP Servers"** tab
  4. See list of connected servers with:
     - Server name
     - Status (connected/disconnected)
     - Available tools

---

## Phase 13: Collaboration ✅ UI READY

### Location: TopBar (session header)

**13.1: Invite Links**
- **Location**: TopBar → Share button (share icon with three dots)
- **Steps:**
  1. Open any active session
  2. Click **Share icon** in top-right
  3. Select role for invitee:
     - **Collaborator**: Can approve permissions & send messages
     - **Spectator**: Watch only (read-only)
  4. Link automatically copied to clipboard
  5. Share link: `http://localhost:5174/#/join/TOKEN`

**13.2: Multi-Viewer Permissions**
- **How it works:**
  1. Share session link with multiple people
  2. When agent requests permission, all viewers see banner
  3. Voting UI appears (if permission mode = `majority-rules`)
  4. Each viewer votes: Approve / Deny
  5. Votes aggregate in real-time
  6. Majority determines outcome

- **Voting policies:**
  - `majority-rules`: 60% approval needed
  - `any-deny-blocks`: One deny blocks all
  - `owner-decides`: Only owner can approve
  - `dontAsk`: Auto-approve (no voting)

**13.3: Presence (Viewer Avatars)**
- **Location**: TopBar (automatically shows when multiple viewers)
- **What you see:**
  - Avatar circles with first letter of viewer name
  - Color-coded by role:
    - Blue = Owner
    - Yellow = Collaborator
    - Gray = Spectator
  - Hover to see full name + role
  - Shows up to 4 avatars, then "+N" for additional viewers

**Testing collaboration locally:**
1. Open session in browser window 1
2. Click Share → Collaborator → Copy link
3. Open link in browser window 2 (or incognito)
4. Both viewers see each other's avatars
5. Trigger permission in window 1
6. Both windows show permission banner
7. Vote in both windows
8. See vote tally update in real-time

---

## Phase 14: Environment Profiles ✅ UI READY

### Location: Environments Page (`#/environments`)

**Steps:**
1. Click **"Settings"** in sidebar → Select "Environments"
2. Or navigate to `#/environments`
3. Click **"New Profile"**
4. Fill out:
   - **Name**: e.g., "Production", "Development", "Staging"
   - **Environment Variables**: Key-value pairs
     - Example: `API_KEY=secret123`
     - Example: `DEBUG=false`
5. Click **"Save"**

**Using profiles:**
- Session creation form → **Environment** dropdown
- Select profile → Session inherits all env vars
- Env vars are passed to agent subprocess

**Management:**
- Edit profile (click card)
- Delete profile
- Duplicate profile

---

## Phase 15: Testing & Validation ✅ COMMAND LINE

### Location: Terminal

**15.1: Run Test Suite**
```bash
cd ~/campfire/web
bun run test

# Expected: 1000+ tests pass
# Note: Some jsdom/React 19 compatibility issues may show
```

**15.2: Type Check**
```bash
bun run typecheck

# Expected: No TypeScript errors
```

**15.3: Build Check**
```bash
bun run build

# Expected: Clean build, dist/ folder created
```

---

## Quick Reference: UI Navigation

| Feature | URL / Location | Sidebar Icon |
|---------|---------------|--------------|
| Home (New Session) | `#/` | Logo (top) |
| Session Chat | `#/` (auto-opens) | n/a |
| Prompts Library | `#/prompts` | 📄 Document |
| Integrations | `#/integrations` | 🧩 Puzzle |
| Settings | `#/settings` | ⚙️ Gear |
| Environments | `#/environments` | 🌍 Globe |
| Scheduled (Cron) | `#/scheduled` | ⏰ Clock |
| Gallery | `#/gallery` | 🖼️ Grid |
| Webhooks | `#/webhooks` | 🪝 Hook |
| Adapters | `#/adapters` | 🔌 Plug |
| Terminal | `#/terminal` | 💻 Terminal |
| Replay | `#/replay` | ▶️ Play |

| Session Feature | TopBar Button | Icon |
|----------------|---------------|------|
| Fork Session | Fork button | Git branch |
| Share Session | Share button | Three dots connected |
| Add to Gallery | Gallery button | Grid |
| Edit CLAUDE.md | File button | Document with lines |
| Toggle Task Panel | Panel button | List |
| Chat/Diff Tabs | Tab toggle | Switch |

---

## UI Implementation Status Summary

✅ **Fully Implemented (Ready to Test):**
- Phase 1: Basic session creation & chat
- Phase 2: Multi-backend support
- Phase 7: Global Prompt Library
- Phase 8: Linear Integration
- Phase 9: Session forking, recording, replay, gallery
- Phase 10: Webhooks & cron scheduling
- Phase 11: Ratatui TUI client (separate app)
- Phase 12: Git worktrees, Docker containers, MCP servers
- Phase 13: Collaboration (invite links, presence, voting)
- Phase 14: Environment profiles
- Phase 15: Tests & build

✅ **Now Fully Implemented (UI + Backend):**
- Phase 3: Semantic Memory (`MemoryPanel.tsx` at `#/memory`) ✓
- Phase 4: Deliberation Engine (`DeliberationCard.tsx`) ✓
- Phase 5: Capability Discovery (`TaskRouterPage.tsx` at `#/router`) ✓
- Phase 6: Shared Context Stream (`CollectiveMindPanel.tsx` at `#/collective`) ✓

---

## Testing Order Recommendation

**Day 1 - Try the working features:**
1. Phase 1 - Basic session (10 min)
2. Phase 7 - Prompt library (5 min)
3. Phase 9 - Fork, replay, gallery (10 min)
4. Phase 13 - Collaboration (10 min)
5. Phase 14 - Environment profiles (5 min)

**Day 2 - Advanced features:**
1. Phase 10 - Webhooks & cron (15 min)
2. Phase 12 - Worktrees & containers (10 min)
3. Phase 11 - TUI client (10 min)

**Day 3 - Implement missing UI:**
1. Phase 3 - Build MemoryPanel.tsx
2. Phase 4 - Build DeliberationCard.tsx
3. Phase 5 - Build TaskRouterPage.tsx
4. Phase 6 - Build CollectiveMindPanel.tsx

---

Ready to start testing! Let me know which phase you want to try first.

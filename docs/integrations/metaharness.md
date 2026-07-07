# Running MetaHarness Harnesses in Campfire

[MetaHarness](https://github.com/ruvnet/metaharness) (MIT) is a generator for
custom agent harnesses: it scaffolds a branded agent package with its own CLI,
an MCP server, scoped memory, and governance policies, targeting hosts like
Claude Code and Codex. Campfire is a control plane for those same hosts — so a
MetaHarness-generated harness and Campfire compose naturally, with **zero code
changes on either side**:

- The harness supplies the **capabilities**: its MCP tools, memory, and
  governance travel with the MCP server it generates.
- Campfire supplies the **operations layer**: the browser UI, session
  persistence and replay, cost tracking, and — most usefully — the
  **permission-voting UI**, so a team can approve or deny the harness's tool
  calls collaboratively before they run.

## How it works

A MetaHarness harness attaches to Claude Code primarily through an **MCP
server** (plus optional settings/hooks). Campfire supports **runtime MCP
injection** into live sessions: server configs sent to a session flow through
the bridge into the agent CLI (`mcp_set_servers`), and the agent can start
using the tools immediately — no restart required. Claude Code and Codex
sessions both support this.

Every MCP tool call the harness's server exposes still goes through
Campfire's permission flow: tool calls arrive as permission requests named
`mcp:<server>:<tool>`, render in the chat with Allow/Deny, and participate in
multi-viewer voting (`majority-rules`, `any-deny-blocks`, or `owner-decides`)
when more than one collaborator is connected.

## Recipe

### 1. Scaffold a harness

```bash
# Pick any vertical template and a host Campfire runs (claude-code or codex)
npx metaharness my-devops-bot --template vertical:devops --host claude-code

# Or use the interactive wizard / browser Studio:
npx metaharness --wizard
```

Follow the generated harness's own README for `npm install` and setup. What
you need from it is the **MCP server launch command** — MetaHarness prints
host wiring instructions after scaffolding (the Studio shows them inline).
For a typical generated harness this is a stdio server: a command, args, and
any env vars it needs.

### 2. Start a Campfire session

Create a Claude Code or Codex session from the Campfire home page in the
project directory where you want the harness to operate.

### 3. Attach the harness's MCP server

Open the session's **Task Panel → MCP Servers** and add the harness's server
using the command from step 1, e.g.:

```json
{
  "my-devops-bot": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "my-devops-bot", "mcp"]
  }
}
```

The exact command/args come from your generated harness — use whatever its
setup instructions specify. Once connected, the server's tools appear in the
MCP panel with their status, and the agent can call them.

> Campfire statically scans MCP server configs on injection and logs warnings
> for suspicious shapes (shell metacharacters, inline-eval flags, plaintext
> `http://` URLs to non-local hosts). Explicit user-added servers are never
> blocked — the scan is for visibility. Only *auto-injected* servers (from
> environment detection) are subject to Campfire's default-deny catalog
> policy (`web/server/mcp-policy.ts`).

### 4. Operate with Campfire's controls on top

From here everything is a normal Campfire session, with the harness's
capabilities inside it:

- **Permission voting** — invite collaborators (session → Invite); harness
  tool calls that require approval are voted on before execution.
- **Recording & replay** — every raw protocol message, including the
  harness's MCP traffic, is recorded to `~/.campfire/recordings/` and
  replayable from the UI.
- **Cost & session tracking** — cost, token usage, and changed files show in
  the Task Panel; sessions persist across restarts and support `--resume`.
- **Automation** — the same session shape works under Campfire cron jobs and
  agent profiles, so a harness-equipped session can run on a schedule.

## Notes and limits

- MetaHarness is beta (v0.1.x); the generated harness's own commands are the
  source of truth for how to launch its MCP server — they may change between
  releases.
- Settings/hooks that a harness writes into `~/.claude` or the project's
  `.claude/` directory apply to Claude Code itself and work under Campfire
  unchanged, since Campfire runs the real `claude` CLI.
- Backends other than Claude Code and Codex don't currently support runtime
  MCP injection in Campfire; attach harnesses to Claude/Codex sessions.

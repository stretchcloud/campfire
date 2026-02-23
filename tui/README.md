# campfire-tui

A terminal UI for [Campfire](../README.md) built with [Ratatui](https://ratatui.rs).

Connect to a running Campfire server from your terminal — view sessions, stream
agent output, send messages, and handle permission prompts without a browser.

## Requirements

- Rust 1.75+ (`rustup` recommended)
- A running Campfire server (default: `http://localhost:3456`)

## Build

```bash
cd tui
cargo build --release
```

The binary is at `target/release/campfire-tui`.

## Run

```bash
# Connect to local Campfire (must already be running)
cargo run

# Or point at a different server
cargo run -- --server http://myserver:3456

# Via environment variable
CAMPFIRE_URL=http://myserver:3456 cargo run
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate session list / scroll messages |
| `Enter` | Open selected session |
| `i` | Enter Insert mode (focus message composer) |
| `Esc` | Back to Normal mode / close current session |
| `n` | New session (opens backend picker) |
| `r` | Refresh session list |
| `q` | Quit |
| `y` | Allow permission (once) |
| `a` | Allow permission (always) |
| `n` | Deny permission |
| `Ctrl+C` | Force quit |

## Architecture

```
main.rs          CLI entry, terminal init/restore
app.rs           App state + main tokio::select! loop
api.rs           REST client (reqwest) for sessions + backends
ws.rs            WebSocket task (tokio-tungstenite)
protocol.rs      Serde types for Campfire WS protocol
events.rs        Crossterm → AppEvent
ui/
  mod.rs         Top-level render(), layout
  session_list   Left sidebar: session list
  chat           Chat messages + streaming
  composer       Input box
  permission     Permission overlay
```

The TUI is a **pure client** — it connects to the Campfire server's existing
`/ws/browser/:sessionId` WebSocket endpoint and `/api/*` REST API.
No server-side changes are required.

# Changelog

> Campfire began as a fork of [the-companion](https://github.com/The-Vibe-Company/companion) and diverged into a separate product. Pre-fork history (versions up to 0.42.0) lives in the upstream repository; Campfire's own releases start at 0.1.0.

## 0.1.0 (2026-07-07)

First public release of Campfire — a collaborative web platform for AI coding agents.

### Features

* Multi-backend sessions: Claude Code, Codex, Goose, Aider, OpenHands, OpenClaw, and OpenCode behind one normalized browser protocol, plus community adapters installable from npm
* Real-time collaboration: owner/collaborator/spectator roles, presence, invite links, and multi-viewer permission voting (majority-rules, any-deny-blocks, owner-decides)
* Automation: cron-scheduled sessions, agent profiles with webhook/schedule triggers, multi-stage orchestrator pipelines, and backend races in isolated git worktrees
* Agent-to-agent delegation: lead sessions can hand one-turn subtasks to other backends via the built-in `campfire_agents` MCP server
* Session durability: disk persistence, crash recovery with `--resume`, sequence-numbered reconnect replay, and always-on raw protocol recording with replay UI
* Git-native workflow: branch/worktree tracking, ahead/behind counts, PR status polling, diff review
* Embedded terminal, session gallery, prompt library, environment profiles, webhooks with HMAC signing, Linear integration, and optional Docker sandboxing

### Security

* Salted scrypt password hashing with transparent migration from legacy hashes
* Invite tokens expire after 24 hours
* Rate limiting keyed to the real socket address (spoof-resistant)
* Community adapter installs run with `--ignore-scripts`

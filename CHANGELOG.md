# Changelog

> Campfire began as a fork of [the-companion](https://github.com/The-Vibe-Company/companion) and diverged into a separate product. Pre-fork history (versions up to 0.42.0) lives in the upstream repository; Campfire's own releases start at 0.1.0.

## 0.3.2 (2026-07-07)

### Documentation

* **readme:** rewrite the Semantic Memory section for v2 — namespaces (global/repo/session/agent), decay + reinforcement + pinning, the auto-recall enrichment and recalled-context chip, the JUDGE→DISTILL→CONSOLIDATE pipeline, versioned `fragments_v2`/`consolidated_v2` storage, and the new overview/pin endpoints. The previous copy described the pre-v2 (and partly dead) behavior

## 0.3.1 (2026-07-07)

### Fixes

* **memory:** warm the memory store's tables when a session becomes ready, so the session's first user message is enriched within the 250 ms budget instead of gracefully passing through on the cold (~230 ms) first query. The warm-up is fire-and-forget at session init, off the hot path, and never reinforces

## 0.3.0 (2026-07-07)

### Features

* **memory:** semantic memory v2 — the full rebuild. Namespace-scoped storage (global / repo / session / agent), automatic v1→v2 schema migration, lazy decay with access-based reinforcement, composite scored retrieval (similarity × decay × confidence) with a no-embedding fallback, pinning, and eviction
* **memory:** prompt enrichment now actually works — user messages are enriched with recalled memories under a 250 ms budget with per-session ordering guarantees; the UI shows a collapsible "recalled context" chip listing exactly what was injected
* **memory:** LLM-backed consolidation (JUDGE→DISTILL→CONSOLIDATE) via OpenRouter with strict JSON validation and graceful concat fallback; triggers on turn boundaries, idle, session end, and manual
* **memory:** MemoryPanel namespace overview with decayed-weight bars and pin/unpin; Settings → Memory section for decay half-lives, reinforce multipliers, and recall depths

### Fixes

* memory extraction no longer keyword-gated; thinking-block content is scrubbed before storage or promotion
* global memory endpoint returned nothing structurally; consolidation duplicated rows on every run; zero-vectors no longer pollute vector search

## 0.2.1 (2026-07-07)

### Fixes

* **npm:** include the project README and LICENSE in the published tarball so the npm package page renders documentation (previously the package root had neither)
* **ci:** publish the Docker image to GitHub Container Registry (`ghcr.io/stretchcloud/campfire`) using the workflow's built-in token — the Docker Hub path required credentials that were never configured, so no image had ever been published

## 0.2.0 (2026-07-07)

### Features

* **races:** cost-cascade mode — run backends sequentially cheapest-first and stop at the first entry that completes with a non-empty change set; failures, timeouts, and empty patches escalate to the next backend
* **mcp:** default-deny injection policy with static scanning for auto-injected MCP servers (curated catalog match + shell-metacharacter/inline-eval/plaintext-http checks); `CAMPFIRE_MCP_AUTO_INJECT_POLICY=permissive` escape hatch

### Security

* auto-injected MCP servers can no longer be smuggled in via tampered persisted session state or crafted session-create payloads

### Documentation

* README: removed a documented-but-nonexistent feature (Adopt Running Sessions), corrected the auth setup endpoint and password-hashing description, documented cost-cascade races, the MCP injection policy, invite-link expiry, ClawHub/Moltbook/public-replay sharing, and added an Agents API reference table
* new: MetaHarness integration recipe (docs/integrations/metaharness.md), semantic-memory v2 design study (docs/design/semantic-memory-v2.md), SECURITY.md

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

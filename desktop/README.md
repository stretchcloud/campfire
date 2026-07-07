# Campfire Desktop (macOS, Apple Silicon)

A native Electron shell around the Campfire server. The app is deliberately
thin: the main process boots the **same Bun + Hono backend** the npm/Docker
distributions run (bundled under `Contents/Resources/backend` together with a
Bun runtime at `Contents/Resources/bun/bun`), then points a `BrowserWindow` at
`http://127.0.0.1:<port>`. Every feature — all agent backends, collaboration,
replay, gallery, webhooks, cron, semantic memory — is served by that sidecar,
so the desktop and web builds can never diverge.

## Behavior

- **Reuse-first**: if a Campfire server already answers on port 4567 (the
  `the-campfire` background service, `bunx the-campfire`, or the dev server),
  the app attaches to it instead of spawning a second server against the same
  `~/.campfire` state. Otherwise it spawns the bundled sidecar on the first
  free port from 4567 upward.
- **Shared state**: sessions, recordings, settings, and memory live in
  `~/.campfire`, shared with the CLI/web flavors.
- **Sidecar logs**: `~/.campfire/logs/desktop-server.log`.
- **Lifecycle**: closing the window keeps the app (and server) alive per macOS
  convention; Cmd+Q stops the sidecar. Agent CLI processes persist and are
  resumed on the next launch, same as a server restart.
- **Links**: anything not on the local server origin opens in the default
  browser.

## Build

```bash
# From the repo root
make dmg          # stage + package desktop/dist/Campfire-<version>-arm64.dmg

# Or step by step
./desktop/scripts/stage.sh   # build frontend, stage backend + node_modules + bun into desktop/vendor/
cd desktop
bun install
bun run smoke                # boots the app headless: spawns sidecar, loads UI, exits 0/1
bun run dist                 # electron-builder → dist/Campfire-<version>-arm64.dmg
```

`bun test test/` runs the unit tests for the boot-time networking helpers
(free-port scan, Campfire probe, readiness wait). They need no Electron
install.

## Signing ("cheap" distribution)

Builds are **ad-hoc signed** (`scripts/after-pack.js`) — valid signature, no
Apple Developer account, $0. Downloaded copies carry the quarantine attribute,
so the first launch needs right-click → **Open**, or:

```bash
xattr -cr /Applications/Campfire.app
```

To move to real signing + notarization later: set `mac.identity` in
`electron-builder.yml`, add notarize options, and delete the codesign calls in
`scripts/after-pack.js` (keep the node_modules copy step — electron-builder
drops `node_modules` from `extraResources` by default, and without the copied
modules the app only works on machines where Bun can auto-install at runtime).

## Gotchas learned the hard way

- `extraResources` silently excludes `node_modules`; a bundle missing them
  *appears* to work on dev machines because Bun auto-installs into its global
  cache at runtime. `scripts/after-pack.js` copies them explicitly and CI
  would fail the packaging step if staging was skipped.
- `codesign` rejects bundles containing symlinks whose targets it can't seal —
  `node_modules/.bin` shims are removed during packaging.
- The first GUI launch takes ~20 s while Gatekeeper scans the bundle; later
  launches are ~3 s.

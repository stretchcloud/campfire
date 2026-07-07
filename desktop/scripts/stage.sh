#!/usr/bin/env bash
# Stage the Campfire backend + Bun runtime for the desktop app.
#
# Produces desktop/vendor/:
#   backend/   server source, built frontend (dist/), bin/, and a minimal
#              production node_modules (hono, croner, @lancedb/lancedb)
#   bun/bun    the Bun runtime binary that executes the backend
#
# electron-builder ships vendor/* as extraResources; the Electron main process
# spawns `Resources/bun/bun Resources/backend/server/index.ts`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="$ROOT/web"
DESK="$ROOT/desktop"
VENDOR="$DESK/vendor"
BACKEND="$VENDOR/backend"

command -v bun >/dev/null || { echo "error: bun is required (https://bun.sh)"; exit 1; }

echo "── [1/5] Building frontend"
(cd "$WEB" && bun install --frozen-lockfile && bun run build)

echo "── [2/5] Staging backend sources"
rm -rf "$BACKEND"
mkdir -p "$BACKEND"
rsync -a --exclude='*.test.ts' --exclude='protocol/' "$WEB/server/" "$BACKEND/server/"
rsync -a "$WEB/dist/" "$BACKEND/dist/"
rsync -a "$WEB/bin/" "$BACKEND/bin/"

echo "── [3/5] Installing server runtime dependencies"
# Only the packages the server imports at runtime; every frontend dependency
# is already compiled into dist/ by Vite.
bun -e '
  const web = await Bun.file(process.argv[1] + "/package.json").json();
  const keep = ["hono", "croner", "@lancedb/lancedb"];
  const deps = Object.fromEntries(keep.map((k) => [k, web.dependencies[k]]));
  const missing = keep.filter((k) => !deps[k]);
  if (missing.length) throw new Error("runtime deps missing from web/package.json: " + missing);
  const pkg = {
    name: "campfire-desktop-backend",
    private: true,
    version: web.version,
    type: web.type,
    dependencies: deps,
  };
  await Bun.write(process.argv[2] + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$WEB" "$BACKEND"
(cd "$BACKEND" && bun install --production)

echo "── [4/5] Bundling Bun runtime"
BUN_BIN="$(command -v bun)"
# Resolve symlinks (e.g. ~/.bun/bin/bun) to the real binary.
BUN_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$BUN_BIN" 2>/dev/null || readlink -f "$BUN_BIN")"
mkdir -p "$VENDOR/bun"
cp -f "$BUN_REAL" "$VENDOR/bun/bun"
chmod +x "$VENDOR/bun/bun"
ARCH_INFO="$(file "$VENDOR/bun/bun")"
echo "    $ARCH_INFO"
if [[ "$(uname -s)" == "Darwin" && "$ARCH_INFO" != *"arm64"* ]]; then
  echo "error: bundled bun is not an arm64 binary — install an Apple Silicon bun"
  exit 1
fi

echo "── [5/5] Syncing desktop app version"
bun -e '
  const web = await Bun.file(process.argv[1] + "/package.json").json();
  const deskPath = process.argv[2] + "/package.json";
  const desk = await Bun.file(deskPath).json();
  if (desk.version !== web.version) {
    desk.version = web.version;
    await Bun.write(deskPath, JSON.stringify(desk, null, 2) + "\n");
    console.log(`    desktop version -> ${web.version}`);
  } else {
    console.log(`    already at ${web.version}`);
  }
' "$WEB" "$DESK"

echo
echo "Staged. Sizes:"
du -sh "$BACKEND" "$VENDOR/bun" | sed 's/^/    /'
echo
echo "Next: cd desktop && bun install && bun run smoke   # or: bun run dist"

.PHONY: dev build start desktop-stage desktop dmg

dev:
	cd web && bun run dev

build:
	cd web && bun run build

start:
	cd web && bun run start

# ── macOS desktop app (Electron shell around the Bun server) ────────────────
desktop-stage:
	./desktop/scripts/stage.sh

desktop: desktop-stage
	cd desktop && bun install && bun run start

dmg: desktop-stage
	cd desktop && bun install && bun run dist

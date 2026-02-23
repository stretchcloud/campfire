#!/usr/bin/env bun
/**
 * Unified dev server — runs both the Hono backend and Vite frontend
 * in a single terminal. Ctrl+C kills both.
 */
import { spawn, type Subprocess } from "bun";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname);

const procs: Subprocess[] = [];

function prefix(name: string, color: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const reset = "\x1b[0m";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
        }
      }
    }
  })();
}

// ── Backend (Hono on Bun) ──────────────────────────────────────────
const backend = spawn(["bun", "--watch", "server/index.ts"], {
  cwd: webDir,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NODE_ENV: "development" },
});
procs.push(backend);
prefix("api", "\x1b[36m", backend.stdout);
prefix("api", "\x1b[31m", backend.stderr);

// ── Vite (frontend HMR) ───────────────────────────────────────────
const vite = spawn(["bun", "run", "dev:vite"], {
  cwd: webDir,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NODE_ENV: "development" },
});
procs.push(vite);
prefix("vite", "\x1b[35m", vite.stdout);
prefix("vite", "\x1b[31m", vite.stderr);

// ── Cleanup on exit ───────────────────────────────────────────────
function cleanup() {
  for (const p of procs) p.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// If either process exits unexpectedly, kill the other and exit
Promise.race([backend.exited, vite.exited]).then((code) => {
  console.error(`\x1b[31mA dev server exited with code ${code}, shutting down...\x1b[0m`);
  cleanup();
});

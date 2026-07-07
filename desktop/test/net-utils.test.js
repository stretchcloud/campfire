// Tests for the desktop shell's networking helpers (bun test).
//
// These validate the boot-time decisions the Electron main process makes:
//   - picking a free port for the sidecar (skipping occupied ones)
//   - recognizing a running Campfire server by its /api/backends shape
//     (so the app attaches to an existing service instead of double-spawning
//     against the same ~/.campfire state)
//   - waiting for readiness with early abort when the sidecar dies
const { test, expect } = require("bun:test");
const net = require("node:net");
const http = require("node:http");
const {
  isPortFree,
  findFreePort,
  probeCampfire,
  waitForCampfire,
} = require("../main/net-utils.js");

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
}

test("isPortFree: reports an occupied port as busy and a fresh one as free", async () => {
  const blocker = net.createServer();
  const port = await listen(blocker);
  expect(await isPortFree(port)).toBe(false);
  await new Promise((r) => blocker.close(r));
  expect(await isPortFree(port)).toBe(true);
});

test("findFreePort: skips occupied ports and returns the next free one", async () => {
  const blocker = net.createServer();
  const base = await listen(blocker);
  // base is occupied, so the scan starting at base must return something after it.
  const found = await findFreePort(base, 10);
  expect(found).toBeGreaterThan(base);
  expect(await isPortFree(found)).toBe(true);
  await new Promise((r) => blocker.close(r));
});

test("probeCampfire: accepts a Campfire-shaped /api/backends response", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/backends") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "claude", name: "Claude Code", available: true }]));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const port = await listen(server);
  expect(await probeCampfire(port)).toBe(true);
  await new Promise((r) => server.close(r));
});

test("probeCampfire: rejects non-Campfire services and dead ports", async () => {
  // A generic web app answering 200 with HTML must not be mistaken for Campfire.
  const server = http.createServer((_req, res) => res.end("<html>hello</html>"));
  const port = await listen(server);
  expect(await probeCampfire(port)).toBe(false);
  await new Promise((r) => server.close(r));
  // Nothing listening at all → false, not a thrown error.
  expect(await probeCampfire(port)).toBe(false);
});

test("waitForCampfire: resolves once the server comes up mid-wait", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ id: "codex" }]));
  });
  const port = await findFreePort(20567);
  setTimeout(() => listen(server, port), 300);
  expect(await waitForCampfire(port, 5000, () => true, 100)).toBe(true);
  await new Promise((r) => server.close(r));
});

test("waitForCampfire: aborts early when the sidecar process dies", async () => {
  const port = await findFreePort(21567);
  const start = Date.now();
  // isAlive=false simulates the spawned server exiting during boot; the wait
  // must bail immediately rather than burning the full 10s deadline.
  expect(await waitForCampfire(port, 10000, () => false, 50)).toBe(false);
  expect(Date.now() - start).toBeLessThan(2000);
});

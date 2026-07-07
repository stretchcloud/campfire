// Pure networking helpers for the desktop shell. No Electron imports here so
// these stay unit-testable with plain `bun test`.
"use strict";

const net = require("node:net");
const http = require("node:http");

/** Check whether a TCP port on 127.0.0.1 accepts a listener (i.e. is free). */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find the first free port starting at `start`, scanning upward.
 * Throws if nothing is free within `span` ports.
 */
async function findFreePort(start, span = 50) {
  for (let port = start; port < start + span; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + span - 1}`);
}

/**
 * GET a URL with a hard timeout. Resolves to { status, body } or null on any
 * network error / timeout. Never rejects.
 */
function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        // Cap the buffered body; the probe only needs the shape, not the payload.
        if (body.length < 65536) body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
  });
}

/**
 * Probe whether a Campfire server is answering at the given port.
 * `/api/backends` returns a JSON array of known agent backends — a shape no
 * other local service plausibly serves at that path.
 */
async function probeCampfire(port, timeoutMs = 2000) {
  const res = await httpGet(`http://127.0.0.1:${port}/api/backends`, timeoutMs);
  if (!res || res.status !== 200) return false;
  try {
    const parsed = JSON.parse(res.body);
    return Array.isArray(parsed) && parsed.every((b) => typeof b?.id === "string");
  } catch {
    return false;
  }
}

/**
 * Poll until a Campfire server answers on `port` or `deadlineMs` elapses.
 * `isAlive` lets the caller abort early (e.g. the sidecar process died).
 */
async function waitForCampfire(port, deadlineMs = 30000, isAlive = () => true, intervalMs = 250) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    if (await probeCampfire(port, 1500)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = { isPortFree, findFreePort, httpGet, probeCampfire, waitForCampfire };

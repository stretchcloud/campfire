// Campfire desktop — Electron main process.
//
// The app is a thin native shell: it boots the full Campfire server (the same
// Bun + Hono backend the web/npm distribution runs) as a bundled sidecar, then
// points a BrowserWindow at it. Every feature — all agent backends, sessions,
// collaboration, replay, gallery, webhooks, cron, memory — is served by that
// sidecar, so desktop and web builds never diverge.
"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
const { join } = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");
const { ServerManager } = require("./server-manager.js");
const { buildMenu } = require("./menu.js");

const SMOKE = process.env.CAMPFIRE_SMOKE === "1";
const REPO_ROOT = join(__dirname, "..", "..");

const serverManager = new ServerManager({
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged,
  repoRoot: REPO_ROOT,
});

/** @type {BrowserWindow | null} */
let mainWindow = null;
let quitting = false;

// ── Single instance ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] Another Campfire instance is already running — focusing it instead.");
  app.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Window bounds persistence ────────────────────────────────────────────────
function boundsFile() {
  return join(app.getPath("userData"), "window-bounds.json");
}
function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(boundsFile(), "utf8"));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch { /* first run */ }
  return { width: 1440, height: 900 };
}
function saveBounds(win) {
  try {
    writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds()));
  } catch { /* non-fatal */ }
}

// ── Splash markup (shown while the sidecar boots) ────────────────────────────
const SPLASH_HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0b0b0c;color:#e7e5e4;font:15px -apple-system,system-ui">
<div style="font-size:56px">🔥</div>
<div style="font-weight:600;font-size:18px;letter-spacing:.2px">Campfire</div>
<div id="s" style="color:#a8a29e">Starting the server…</div>
</body>`;

function createWindow() {
  const bounds = loadBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0c",
    title: "Campfire",
    webPreferences: {
      preload: join(__dirname, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--campfire-version=${app.getVersion()}`],
    },
  });

  // Anything that isn't our local server opens in the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const origin = serverManager.origin();
    if (origin && url.startsWith(origin)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const origin = serverManager.origin();
    if (origin && url.startsWith(origin)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on("close", () => saveBounds(win));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

async function bootAndLoad(win) {
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  if (!SMOKE) {
    win.once("ready-to-show", () => win.show());
  }

  // First launches can sit in Gatekeeper verification for a while — tell the
  // user the wait is expected instead of looking hung.
  const slowBootNote = setTimeout(() => {
    win.webContents
      .executeJavaScript(
        `document.getElementById("s").textContent = "Still starting — the first launch can take a minute while macOS verifies the app…"`,
      )
      .catch(() => { /* window may have navigated */ });
  }, 15000);

  let result;
  try {
    result = await serverManager.ensure();
  } catch (err) {
    clearTimeout(slowBootNote);
    if (SMOKE) {
      console.error(`SMOKE_FAIL: ${err.message}`);
      app.exit(1);
      return;
    }
    dialog.showMessageBoxSync({
      type: "error",
      title: "Campfire could not start",
      message: "Campfire could not start",
      detail: String(err.message || err),
    });
    app.exit(1);
    return;
  }

  clearTimeout(slowBootNote);
  const origin = serverManager.origin();
  console.log(
    result.external
      ? `[desktop] Attached to existing Campfire server at ${origin}`
      : `[desktop] Sidecar server ready at ${origin}`,
  );

  await win.loadURL(`${origin}/`);
  if (SMOKE) {
    console.log(`SMOKE_OK: ${origin} external=${result.external}`);
    quitting = true;
    serverManager.stop();
    // Give the SIGTERM a beat to land before the Electron process exits.
    setTimeout(() => app.exit(0), 500);
  }
}

// A sidecar crash mid-session is recoverable: offer a relaunch.
serverManager.onUnexpectedExit = (code) => {
  if (quitting) return;
  console.error(`[desktop] Sidecar exited unexpectedly (code ${code})`);
  if (!mainWindow) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "error",
    title: "Campfire server stopped",
    message: `The Campfire server stopped unexpectedly (exit code ${code}).`,
    detail: "Session state is persisted in ~/.campfire and will be restored on relaunch.",
    buttons: ["Relaunch", "Quit"],
    defaultId: 0,
  });
  if (choice === 0) {
    app.relaunch();
  }
  quitting = true;
  app.exit(code ?? 1);
};

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu({ getWindow: () => mainWindow, getOrigin: () => serverManager.origin() });
  const win = createWindow();
  void bootAndLoad(win);

  if (SMOKE) {
    // Hard ceiling so a hung boot can never wedge CI.
    setTimeout(() => {
      console.error("SMOKE_FAIL: timeout");
      app.exit(1);
    }, 90000).unref?.();
  }

  app.on("activate", () => {
    // macOS: re-create the window when the dock icon is clicked after close.
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow();
      const origin = serverManager.origin();
      if (origin) {
        newWin.loadURL(`${origin}/`);
        newWin.once("ready-to-show", () => newWin.show());
      } else {
        void bootAndLoad(newWin);
      }
    }
  });
});

app.on("window-all-closed", () => {
  // macOS convention: the app (and its server) stays alive until Cmd+Q.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  serverManager.stop();
});

// Minimal bridge: lets the web UI detect it is running inside the desktop
// shell (e.g. to hide "open in browser" hints or adjust notification copy).
const { contextBridge } = require("electron");

const versionArg = process.argv.find((a) => a.startsWith("--campfire-version="));

contextBridge.exposeInMainWorld("campfireDesktop", {
  isDesktop: true,
  platform: process.platform,
  version: versionArg ? versionArg.split("=")[1] : "",
});

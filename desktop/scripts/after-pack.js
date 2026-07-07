// electron-builder afterPack hook. Two jobs:
//
// 1. Copy the backend's node_modules into the packed bundle. electron-builder
//    silently drops node_modules from extraResources (default ignore), and a
//    bundle without them only *appears* to work on dev machines because Bun
//    auto-installs missing packages into its global cache at runtime — end
//    users would hit a slow first boot online and a hard crash offline.
//
// 2. Ad-hoc sign the whole bundle. With identity:null electron-builder skips
//    signing entirely, leaving Electron's original (seal-broken) signature.
//    Apple Silicon requires a valid signature to launch. Ad-hoc costs nothing;
//    downloaded builds still need right-click → Open or `xattr -cr` once.
//    Real signing/notarization can replace this by setting mac.identity.
"use strict";

const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const stagedModules = join(__dirname, "..", "vendor", "backend", "node_modules");
  const bundledModules = join(appPath, "Contents", "Resources", "backend", "node_modules");
  if (!existsSync(stagedModules)) {
    throw new Error(`staged node_modules missing — run desktop/scripts/stage.sh first (${stagedModules})`);
  }
  cpSync(stagedModules, bundledModules, { recursive: true, dereference: false });
  // node_modules/.bin contains symlinked CLI shims we never execute; codesign
  // rejects symlinks in bundles ("invalid destination for symbolic link").
  rmSync(join(bundledModules, ".bin"), { recursive: true, force: true });
  console.log(`  • copied backend node_modules into bundle`);

  execFileSync("codesign", [
    "--force",
    "--deep",
    "--sign", "-",
    "--identifier", "sh.campfire.desktop",
    appPath,
  ], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${appPath}`);
};

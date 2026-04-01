/**
 * AdapterRegistry — manages third-party agent adapters installed via npm.
 *
 * Adapters are stored in ~/.campfire/adapters/{name}/ and discovered by
 * scanning for package.json files with a "campfireAdapter" field.
 *
 * Follows the same file-based persistence pattern as cron-store.ts.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AdapterMetadata, InstalledAdapter } from "./adapter-registry-types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Only allow safe characters in npm package names to prevent shell injection. */
const SAFE_NPM_PACKAGE_RE = /^[a-zA-Z0-9@/_.-]+$/;

// ─── Registry ────────────────────────────────────────────────────────────────

class AdapterRegistry {
  private adaptersDir: string;
  private installed: Map<string, InstalledAdapter>;

  constructor() {
    this.adaptersDir = join(homedir(), ".campfire", "adapters");
    mkdirSync(this.adaptersDir, { recursive: true });
    this.installed = new Map();
    this.scan();
  }

  // ─── Scan ────────────────────────────────────────────────────────────────

  /**
   * Scan ~/.campfire/adapters/ for installed adapter packages.
   * Each subdirectory is expected to contain a package.json with a
   * "campfireAdapter" field. Invalid directories are silently skipped.
   */
  scan(): InstalledAdapter[] {
    this.installed.clear();

    let entries: string[];
    try {
      entries = readdirSync(this.adaptersDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      const dir = join(this.adaptersDir, entry);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      const metadata = this.validate(dir);
      if (!metadata) continue;

      // Read the persisted metadata.json for installedAt / npmPackage
      let installedAt = Date.now();
      let npmPackage = metadata.name;
      const metaJsonPath = join(dir, "metadata.json");
      try {
        const raw = readFileSync(metaJsonPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.installedAt === "number") installedAt = parsed.installedAt;
        if (typeof parsed.npmPackage === "string") npmPackage = parsed.npmPackage;
      } catch {
        // metadata.json may not exist for manually-placed adapters
      }

      const adapter: InstalledAdapter = {
        metadata,
        path: dir,
        installedAt,
        npmPackage,
      };

      this.installed.set(metadata.name, adapter);
    }

    return Array.from(this.installed.values());
  }

  // ─── Validate ────────────────────────────────────────────────────────────

  /**
   * Validate a single adapter directory by reading its package.json and
   * checking for a well-formed "campfireAdapter" field.
   *
   * Returns the validated AdapterMetadata or null if invalid.
   */
  validate(dir: string): AdapterMetadata | null {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return null;

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      return null;
    }

    const raw = pkg.campfireAdapter;
    if (!raw || typeof raw !== "object") return null;

    const adapter = raw as Record<string, unknown>;

    // Required fields
    if (typeof adapter.name !== "string" || !adapter.name.trim()) return null;
    if (typeof adapter.displayName !== "string" || !adapter.displayName.trim()) return null;

    // Build validated metadata with defaults
    const metadata: AdapterMetadata = {
      name: adapter.name as string,
      displayName: adapter.displayName as string,
      version: typeof adapter.version === "string" ? adapter.version : (typeof pkg.version === "string" ? pkg.version : "0.0.0"),
      protocol: adapter.protocol === "websocket" || adapter.protocol === "http"
        ? adapter.protocol
        : "stdio",
      models: Array.isArray(adapter.models) && adapter.models.length > 0
        ? adapter.models as Array<{ value: string; label: string }>
        : [{ value: "default", label: "Default" }],
      modes: Array.isArray(adapter.modes) && adapter.modes.length > 0
        ? adapter.modes as Array<{ value: string; label: string }>
        : [{ value: "default", label: "Default" }],
    };

    // Optional fields
    if (typeof adapter.binaryName === "string") metadata.binaryName = adapter.binaryName;
    if (typeof adapter.description === "string") metadata.description = adapter.description;
    if (typeof adapter.author === "string") metadata.author = adapter.author;
    if (typeof adapter.homepage === "string") metadata.homepage = adapter.homepage;

    return metadata;
  }

  // ─── Install ─────────────────────────────────────────────────────────────

  /**
   * Install an adapter from npm into ~/.campfire/adapters/{name}/.
   *
   * Uses `bun add` in a temporary directory, validates the downloaded package
   * has a campfireAdapter field, then moves it into the adapters directory.
   */
  async install(npmPackage: string): Promise<InstalledAdapter> {
    // Sanitize package name to prevent shell injection
    if (!npmPackage || !SAFE_NPM_PACKAGE_RE.test(npmPackage)) {
      throw new Error(
        `Invalid npm package name: "${npmPackage}". Only alphanumeric characters, @, /, _, ., and - are allowed.`,
      );
    }

    // Create a temporary directory for the install
    const tempDir = join(this.adaptersDir, `.tmp-install-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Write a minimal package.json so bun add works
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "adapter-install-tmp", version: "0.0.0", private: true }),
        "utf-8",
      );

      // Run bun add in the temp directory
      const proc = Bun.spawn(["bun", "add", npmPackage], {
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to install "${npmPackage}": ${stderr.trim() || `exit code ${exitCode}`}`);
      }

      // Find the installed package in node_modules
      // Handle scoped packages like @scope/pkg
      const nodeModulesDir = join(tempDir, "node_modules");
      const pkgName = npmPackage.replace(/@[\d^~>=<. |]+$/, ""); // strip version suffixes
      const pkgDir = join(nodeModulesDir, pkgName);

      if (!existsSync(pkgDir)) {
        throw new Error(`Package "${npmPackage}" was installed but not found in node_modules`);
      }

      // Validate the package has campfireAdapter metadata
      const metadata = this.validate(pkgDir);
      if (!metadata) {
        throw new Error(
          `Package "${npmPackage}" does not contain a valid "campfireAdapter" field in its package.json`,
        );
      }

      // Move to the final location
      const destDir = join(this.adaptersDir, metadata.name);
      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      renameSync(pkgDir, destDir);

      // Persist install metadata
      const installedAt = Date.now();
      writeFileSync(
        join(destDir, "metadata.json"),
        JSON.stringify({ installedAt, npmPackage }, null, 2),
        "utf-8",
      );

      // Re-scan to pick up the new adapter
      this.scan();

      const installed = this.installed.get(metadata.name);
      if (!installed) {
        throw new Error(`Adapter "${metadata.name}" was installed but not found after scan`);
      }

      return installed;
    } finally {
      // Clean up temp directory
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ─── Uninstall ───────────────────────────────────────────────────────────

  /**
   * Uninstall an adapter by name, removing its directory from
   * ~/.campfire/adapters/.
   */
  uninstall(name: string): boolean {
    const dir = join(this.adaptersDir, name);
    if (!existsSync(dir)) {
      this.installed.delete(name);
      return false;
    }

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      return false;
    }

    this.installed.delete(name);
    return true;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  /** List all installed adapters. */
  listInstalled(): InstalledAdapter[] {
    return Array.from(this.installed.values());
  }

  /** Get a single installed adapter by its backend name, or null. */
  getAdapter(name: string): InstalledAdapter | null {
    return this.installed.get(name) || null;
  }

  /**
   * Get backend configs for all installed adapters, suitable for the
   * /api/backends endpoint.
   */
  getBackendConfigs(): Array<{ id: string; name: string; available: boolean }> {
    return this.listInstalled().map((a) => ({
      id: a.metadata.name,
      name: a.metadata.displayName,
      available: true, // If installed, it's available
    }));
  }
}

export { AdapterRegistry };

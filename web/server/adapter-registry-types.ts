/**
 * Types for the adapter registry — manages third-party agent adapters
 * installed via npm into ~/.campfire/adapters/.
 *
 * Each adapter package declares a "campfireAdapter" field in its package.json
 * containing an AdapterMetadata object that tells the registry how to launch
 * and configure the backend.
 */

export interface AdapterMetadata {
  name: string; // backend ID used in BackendType, e.g. "my-agent"
  displayName: string; // human-readable label for UI
  version: string;
  binaryName?: string; // CLI binary name to resolve (optional)
  models: Array<{ value: string; label: string }>;
  modes: Array<{ value: string; label: string }>;
  protocol: "stdio" | "websocket" | "http";
  description?: string;
  author?: string;
  homepage?: string;
}

export interface InstalledAdapter {
  metadata: AdapterMetadata;
  path: string; // absolute path to adapter directory
  installedAt: number;
  npmPackage: string; // original npm package name used to install
}

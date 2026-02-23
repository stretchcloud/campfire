import { useState, useEffect } from "react";
import { api } from "../api.js";
import { LinearLogo } from "./LinearLogo.js";
import { navigateTo } from "../utils/routing.js";

interface LinearConnectionStatus {
  connected: boolean;
  viewer?: { name: string; email: string };
  teams?: Array<{ id: string; key: string; name: string }>;
}

export function LinearSettingsPage({ embedded }: { embedded?: boolean }) {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<LinearConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Load current settings
  useEffect(() => {
    api.getSettings().then((s) => {
      if (s.linearApiKeyConfigured) {
        // Key is configured; check connection
        checkConnection();
      }
    }).catch(() => {});
  }, []);

  async function checkConnection() {
    setChecking(true);
    setError(null);
    try {
      const conn = await api.getLinearConnection();
      setStatus(conn);
    } catch (e) {
      setStatus({ connected: false });
      setError("Could not connect to Linear. Check your API key.");
    } finally {
      setChecking(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await api.updateSettings({ linearApiKey: apiKey.trim() });
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await checkConnection();
    } catch (e) {
      setError("Failed to save API key.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    setError(null);
    try {
      await api.updateSettings({ linearApiKey: "" });
      setStatus(null);
    } catch (e) {
      setError("Failed to disconnect.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigateTo("#/integrations")}
            className="text-cc-fg-muted hover:text-cc-fg transition-colors text-sm"
          >
            ← Integrations
          </button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <LinearLogo className="w-8 h-8 text-[#5E6AD2]" />
          <div>
            <h2 className="text-lg font-semibold text-cc-fg">Linear</h2>
            <p className="text-sm text-cc-fg-muted">Connect your Linear workspace to browse issues</p>
          </div>
        </div>

        {/* Connection status */}
        {status?.connected && status.viewer && (
          <div className="mb-6 p-4 rounded-lg border border-green-500/20 bg-green-500/5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-cc-fg">
                  Connected as <span className="text-green-400">{status.viewer.name}</span>
                </p>
                <p className="text-xs text-cc-fg-muted">{status.viewer.email}</p>
                {status.teams && status.teams.length > 0 && (
                  <p className="text-xs text-cc-fg-muted mt-1">
                    Teams: {status.teams.map((t) => t.name).join(", ")}
                  </p>
                )}
              </div>
              <button
                onClick={handleDisconnect}
                disabled={loading}
                className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {/* API Key input */}
        {!status?.connected && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-cc-fg mb-2">
              Linear API Key
            </label>
            <p className="text-xs text-cc-fg-muted mb-3">
              Create a personal API key at{" "}
              <span className="font-mono text-cc-accent">linear.app/settings/api</span>
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                placeholder="lin_api_..."
                className="flex-1 px-3 py-2 rounded-md border border-cc-border bg-cc-input text-cc-fg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-cc-accent"
              />
              <button
                onClick={handleSave}
                disabled={loading || !apiKey.trim()}
                className="px-4 py-2 rounded-md bg-cc-accent text-white text-sm font-medium hover:bg-cc-accent/90 disabled:opacity-50 transition-colors"
              >
                {loading ? "Saving…" : saved ? "Saved!" : "Connect"}
              </button>
            </div>
          </div>
        )}

        {/* Check connection button when configured but status unknown */}
        {!status && !checking && (
          <button
            onClick={checkConnection}
            className="text-sm text-cc-accent hover:text-cc-accent/80 transition-colors"
          >
            Check connection
          </button>
        )}

        {checking && (
          <p className="text-sm text-cc-fg-muted">Checking connection…</p>
        )}

        {error && (
          <p className="text-sm text-red-400 mt-2">{error}</p>
        )}

        {/* Info */}
        <div className="mt-8 p-4 rounded-lg border border-cc-border bg-cc-bg-subtle">
          <h3 className="text-sm font-medium text-cc-fg mb-2">What this enables</h3>
          <ul className="text-xs text-cc-fg-muted space-y-1 list-disc list-inside">
            <li>Browse and search Linear issues when creating sessions</li>
            <li>Auto-generate branch names from issue titles</li>
            <li>Inject issue context as startup prompt for the agent</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

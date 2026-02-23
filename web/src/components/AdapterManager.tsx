import { useState, useEffect, useCallback } from "react";
import { api, type InstalledAdapterInfo } from "../api.js";

interface Props {
  embedded?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PROTOCOL_LABELS: Record<string, string> = {
  stdio: "stdio",
  websocket: "WebSocket",
  http: "HTTP",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function AdapterManager({ embedded = false }: Props) {
  const [adapters, setAdapters] = useState<InstalledAdapterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [installPackage, setInstallPackage] = useState("");
  const [installing, setInstalling] = useState(false);
  const [uninstallingIds, setUninstallingIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    api.listAdapters().then(setAdapters).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // ─── Install ─────────────────────────────────────────────────────────

  async function handleInstall() {
    const pkg = installPackage.trim();
    if (!pkg) return;

    setInstalling(true);
    setError("");
    try {
      await api.installAdapter(pkg);
      setInstallPackage("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  // ─── Uninstall ───────────────────────────────────────────────────────

  async function handleUninstall(name: string) {
    setUninstallingIds((prev) => new Set(prev).add(name));
    try {
      await api.uninstallAdapter(name);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUninstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }

  // ─── Renderers ───────────────────────────────────────────────────────

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
      {error}
    </div>
  );

  const adaptersList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading adapters...</div>
  ) : adapters.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No community adapters installed. Install one below.
    </div>
  ) : (
    <div className="space-y-3">
      {adapters.map((adapter) => {
        const m = adapter.metadata;
        return (
          <div key={m.name} className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border">
              <span className="text-sm font-medium text-cc-fg flex-1 truncate">{m.displayName}</span>

              {/* Version */}
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-cc-muted bg-cc-hover">
                v{m.version}
              </span>

              {/* Protocol */}
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-blue-500 bg-blue-500/10">
                {PROTOCOL_LABELS[m.protocol] || m.protocol}
              </span>

              {/* Uninstall */}
              <button
                onClick={() => handleUninstall(m.name)}
                disabled={uninstallingIds.has(m.name)}
                className={`text-xs cursor-pointer ${
                  uninstallingIds.has(m.name)
                    ? "text-cc-muted cursor-not-allowed"
                    : "text-cc-muted hover:text-cc-error"
                }`}
              >
                {uninstallingIds.has(m.name) ? "Removing..." : "Uninstall"}
              </button>
            </div>

            {/* Details */}
            <div className="px-3 py-2.5 space-y-1.5">
              {m.description && (
                <div className="text-xs text-cc-muted">{m.description}</div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cc-muted">
                {/* Backend ID */}
                <span className="font-mono-code">{m.name}</span>

                {/* Models */}
                <span>{m.models.length} model{m.models.length !== 1 ? "s" : ""}</span>

                {/* Binary */}
                {m.binaryName && (
                  <span className="font-mono-code">{m.binaryName}</span>
                )}

                {/* Author */}
                {m.author && <span>by {m.author}</span>}

                {/* Installed */}
                <span>Installed {timeAgo(adapter.installedAt)}</span>

                {/* npm package */}
                <span className="font-mono-code">{adapter.npmPackage}</span>
              </div>

              {/* Models list */}
              {m.models.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  {m.models.map((model) => (
                    <span
                      key={model.value}
                      className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted"
                    >
                      {model.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const installSection = (
    <div className="space-y-2.5">
      <div className="text-[11px] font-medium text-cc-muted">
        Install a community adapter from npm
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={installPackage}
          onChange={(e) => setInstallPackage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleInstall()}
          placeholder="@campfire/example-adapter"
          className="flex-1 px-3 py-2 text-sm font-mono-code bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
        />
        <button
          onClick={handleInstall}
          disabled={!installPackage.trim() || installing}
          className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
            installPackage.trim() && !installing
              ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              : "bg-cc-hover text-cc-muted cursor-not-allowed"
          }`}
        >
          {installing ? "Installing..." : "Install"}
        </button>
      </div>
      <div className="text-[10px] text-cc-muted">
        Adapters must declare a "campfireAdapter" field in their package.json
      </div>
    </div>
  );

  // ─── Layout ──────────────────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Adapters</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Install and manage community agent adapters.
            </p>
          </div>
          {errorBanner}
          <div className="mt-4 space-y-4">
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-cc-fg">Installed Adapters</h2>
              {adaptersList}
            </section>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-cc-fg">Install Adapter</h2>
              {installSection}
            </section>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

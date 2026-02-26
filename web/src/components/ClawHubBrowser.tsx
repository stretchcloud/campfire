import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

interface SkillResult {
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
}

export function ClawHubBrowser({ onClose, embedded = false }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    api.getClawHubStatus().then((s) => setAvailable(s.available)).catch(() => setAvailable(false));
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      const res = await api.searchClawHub(query.trim());
      setResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [query]);

  async function handleInstall(slug: string) {
    setInstallingSlug(slug);
    setInstallResult((prev) => { const n = new Map(prev); n.delete(slug); return n; });
    try {
      const res = await api.installClawHubSkill(slug);
      setInstallResult((prev) => new Map(prev).set(slug, res.ok));
    } catch {
      setInstallResult((prev) => new Map(prev).set(slug, false));
    } finally {
      setInstallingSlug(null);
    }
  }

  // ─── Not available state ──────────────────────────────────────────

  if (available === null) {
    return (
      <div className="text-sm text-cc-muted text-center py-10">
        Checking ClawHub availability...
      </div>
    );
  }

  if (!available) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <h1 className="text-xl font-semibold text-cc-fg">ClawHub Skills</h1>
          <div className="mt-4 p-6 bg-cc-card border border-cc-border rounded-xl text-center">
            <p className="text-sm text-cc-muted mb-3">
              The <code className="text-cc-fg bg-cc-hover px-1 rounded">clawhub</code> CLI is not installed.
            </p>
            <p className="text-xs text-cc-muted">
              Install it with: <code className="text-cc-fg bg-cc-hover px-1 rounded">npm install -g clawhub</code>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────

  const content = (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cc-fg">ClawHub Skills</h1>
        <p className="mt-1 text-sm text-cc-muted">
          Browse and install skills from the OpenClaw skill marketplace.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      {/* Search bar */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search skills (e.g. 'code review', 'email', 'slack')"
          className="flex-1 px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            !searching && query.trim()
              ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              : "bg-cc-hover text-cc-muted cursor-not-allowed"
          }`}
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Results */}
      {results.length > 0 ? (
        <div className="space-y-3">
          {results.map((skill) => (
            <div
              key={skill.name}
              className="border border-cc-border rounded-lg overflow-hidden bg-cc-card"
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-cc-fg">{skill.name}</span>
                    <span className="text-[10px] text-cc-muted bg-cc-hover px-1.5 py-0.5 rounded">
                      v{skill.version}
                    </span>
                  </div>
                  <p className="text-xs text-cc-muted mt-0.5 truncate">
                    {skill.description}
                  </p>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-cc-muted">
                    {skill.author && <span>by {skill.author}</span>}
                    {skill.downloads !== undefined && (
                      <span>{skill.downloads.toLocaleString()} downloads</span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => handleInstall(skill.name)}
                  disabled={installingSlug === skill.name}
                  className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    installingSlug === skill.name
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : installResult.get(skill.name) === true
                        ? "bg-cc-success/20 text-cc-success cursor-default"
                        : installResult.get(skill.name) === false
                          ? "bg-cc-error/20 text-cc-error cursor-pointer"
                          : "bg-cc-primary/20 text-cc-primary hover:bg-cc-primary/30 cursor-pointer"
                  }`}
                >
                  {installingSlug === skill.name
                    ? "Installing..."
                    : installResult.get(skill.name) === true
                      ? "Installed"
                      : installResult.get(skill.name) === false
                        ? "Failed — Retry"
                        : "Install"}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !searching && query ? (
        <div className="text-sm text-cc-muted text-center py-8">
          No skills found for &ldquo;{query}&rdquo;
        </div>
      ) : !searching ? (
        <div className="text-sm text-cc-muted text-center py-8">
          Enter a search term to browse ClawHub skills.
        </div>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          {content}
        </div>
      </div>
    );
  }

  return null;
}

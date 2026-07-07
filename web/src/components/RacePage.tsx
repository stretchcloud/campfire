import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CampfireEnv, type RaceInfo } from "../api.js";
import { RaceComparison } from "./RaceComparison.js";

const BACKENDS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "goose", label: "Goose" },
  { id: "aider", label: "Aider" },
  { id: "openhands", label: "OpenHands" },
];

export function RacePage() {
  const hashRaceId = typeof window !== "undefined"
    ? window.location.hash.match(/^#\/races\/([^/?#]+)/)?.[1]
    : undefined;
  const [races, setRaces] = useState<RaceInfo[]>([]);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(hashRaceId ? decodeURIComponent(hashRaceId) : null);
  const [repoRoot, setRepoRoot] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedBackends, setSelectedBackends] = useState<string[]>(["claude", "codex"]);
  const [cascade, setCascade] = useState(false);
  const [envs, setEnvs] = useState<CampfireEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => {
    try {
      return localStorage.getItem("cc-selected-env") || "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const selectedRace = useMemo(
    () => races.find((race) => race.raceId === selectedRaceId) || races[0] || null,
    [races, selectedRaceId],
  );

  const load = useCallback(async () => {
    const data = await api.listRaces();
    setRaces(data);
    if (!selectedRaceId && data[0]) setSelectedRaceId(hashRaceId ? decodeURIComponent(hashRaceId) : data[0].raceId);
  }, [selectedRaceId]);

  useEffect(() => {
    api.getHome().then(async (home) => {
      try {
        const repo = await api.getRepoInfo(home.cwd);
        setRepoRoot(repo.repoRoot);
      } catch {
        setRepoRoot(home.cwd);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    void load();
  }, [load]);

  useEffect(() => {
    const active = selectedRace?.status === "running";
    if (!active) return;
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, [load, selectedRace?.status]);

  const toggleBackend = (id: string) => {
    setSelectedBackends((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const startRace = async () => {
    setError(null);
    setStarting(true);
    try {
      const race = await api.createRace({
        prompt,
        repoRoot,
        backends: selectedBackends,
        envSlug: selectedEnv || undefined,
        cascade: cascade || undefined,
      });
      setRaces((current) => [race, ...current]);
      setSelectedRaceId(race.raceId);
      window.location.hash = `#/races/${encodeURIComponent(race.raceId)}`;
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const cancelRace = async (raceId: string) => {
    const race = await api.cancelRace(raceId);
    setRaces((current) => current.map((item) => item.raceId === race.raceId ? race : item));
  };

  return (
    <div className="h-full overflow-auto bg-cc-bg">
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[18px] font-semibold text-cc-fg">Agent Races</h1>
            <p className="text-[12px] text-cc-muted">Run the same task in isolated worktrees and compare the results.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
          <div className="space-y-3">
            <div className="rounded-lg border border-cc-border bg-cc-card p-3 space-y-3">
              <input
                value={repoRoot}
                onChange={(e) => setRepoRoot(e.target.value)}
                placeholder="Repository root"
                className="w-full px-2.5 py-2 rounded-md border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
              />
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Task prompt"
                rows={5}
                className="w-full px-2.5 py-2 rounded-md border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg resize-none"
              />
              <div className="grid grid-cols-2 gap-2">
                {BACKENDS.map((backend) => (
                  <label key={backend.id} className="flex items-center gap-2 rounded-md border border-cc-border px-2 py-1.5 text-[11px] text-cc-fg">
                    <input
                      type="checkbox"
                      checked={selectedBackends.includes(backend.id)}
                      onChange={() => toggleBackend(backend.id)}
                    />
                    {backend.label}
                  </label>
                ))}
              </div>
              <label className="flex items-start gap-2 rounded-md border border-cc-border px-2 py-1.5 text-[11px] text-cc-fg">
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={() => setCascade((current) => !current)}
                  className="mt-0.5"
                />
                <span>
                  Cost cascade — run backends in order, stop at first success
                  <span className="block text-[10px] text-cc-muted">List cheapest first; failures and empty patches escalate to the next backend.</span>
                </span>
              </label>
              <div>
                <label className="block text-[10px] font-semibold text-cc-muted/60 uppercase tracking-wider mb-1.5" htmlFor="race-env-select">Environment</label>
                <div className="flex gap-1">
                  <select
                    id="race-env-select"
                    value={selectedEnv}
                    onChange={(e) => {
                      setSelectedEnv(e.target.value);
                      try {
                        localStorage.setItem("cc-selected-env", e.target.value);
                      } catch {
                        // best-effort preference
                      }
                    }}
                    onFocus={() => { api.listEnvs().then(setEnvs).catch(() => {}); }}
                    className="flex-1 min-w-0 px-2.5 py-2 rounded-md border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg focus:outline-none focus:border-cc-primary/50 cursor-pointer"
                  >
                    <option value="">No environment</option>
                    {envs.map((env) => (
                      <option key={env.slug} value={env.slug}>{env.name} ({Object.keys(env.variables).length} vars)</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => { window.location.hash = "#/environments"; }}
                    aria-label="Manage environments"
                    className="px-2.5 py-2 rounded-md border border-cc-border bg-cc-input-bg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                      <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z" />
                      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.843 1.843 0 01-2.739 1.049c-1.547-.966-3.317.803-2.35 2.35a1.843 1.843 0 01-1.049 2.74c-1.79.526-1.79 3.064 0 3.59a1.843 1.843 0 011.049 2.74c-.966 1.547.803 3.317 2.35 2.35a1.843 1.843 0 012.74 1.049c.526 1.79 3.064 1.79 3.59 0a1.843 1.843 0 012.74-1.049c1.547.966 3.317-.803 2.35-2.35a1.843 1.843 0 011.049-2.74c1.79-.526 1.79-3.064 0-3.59a1.843 1.843 0 01-1.049-2.74c.966-1.547-.803-3.317-2.35-2.35a1.843 1.843 0 01-2.74-1.049z" />
                    </svg>
                  </button>
                </div>
              </div>
              {error && <div className="text-[11px] text-cc-error">{error}</div>}
              <button
                onClick={() => void startRace()}
                disabled={starting || !prompt.trim() || !repoRoot.trim() || selectedBackends.length < 2}
                className="w-full rounded-md bg-cc-fg text-cc-bg px-3 py-2 text-[12px] font-medium disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {starting ? "Starting..." : "Start Race"}
              </button>
            </div>

            <div className="rounded-lg border border-cc-border bg-cc-card overflow-hidden">
              {races.map((race) => (
                <button
                  key={race.raceId}
                  onClick={() => {
                    setSelectedRaceId(race.raceId);
                    window.location.hash = `#/races/${encodeURIComponent(race.raceId)}`;
                  }}
                  className={`w-full text-left px-3 py-2 border-b border-cc-border/40 hover:bg-cc-hover ${selectedRace?.raceId === race.raceId ? "bg-cc-hover" : ""}`}
                >
                  <div className="text-[12px] text-cc-fg truncate">{race.prompt}</div>
                  <div className="text-[10px] text-cc-muted uppercase font-mono-code">{race.status} / {race.entries.length} agents{race.cascade ? " / cascade" : ""}</div>
                </button>
              ))}
              {races.length === 0 && <div className="px-3 py-5 text-[12px] text-cc-muted">No races yet.</div>}
            </div>
          </div>

          <div className="space-y-3">
            {selectedRace ? (
              <>
                <div className="rounded-lg border border-cc-border bg-cc-card p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-cc-fg truncate">{selectedRace.prompt}</div>
                    <div className="text-[10px] text-cc-muted font-mono-code uppercase">{selectedRace.status} on {selectedRace.baseBranch}{selectedRace.cascade ? " / cascade" : ""}</div>
                  </div>
                  {selectedRace.status === "running" && (
                    <button onClick={() => void cancelRace(selectedRace.raceId)} className="px-2 py-1 rounded-md text-[11px] text-cc-error border border-cc-error/40">
                      Cancel
                    </button>
                  )}
                </div>
                <RaceComparison
                  race={selectedRace}
                  onUpdate={(updated) => setRaces((current) => current.map((race) => race.raceId === updated.raceId ? updated : race))}
                />
              </>
            ) : (
              <div className="rounded-lg border border-cc-border bg-cc-card p-6 text-[12px] text-cc-muted">
                Start a race to compare agents.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type RaceInfo } from "../api.js";
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
      const race = await api.createRace({ prompt, repoRoot, backends: selectedBackends });
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
                  <div className="text-[10px] text-cc-muted uppercase font-mono-code">{race.status} / {race.entries.length} agents</div>
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
                    <div className="text-[10px] text-cc-muted font-mono-code uppercase">{selectedRace.status} on {selectedRace.baseBranch}</div>
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

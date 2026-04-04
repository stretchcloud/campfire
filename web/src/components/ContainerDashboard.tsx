import { useState, useEffect, useCallback } from "react";
import { api, type ContainerStatus, type ContainerInfoApi } from "../api.js";
import { useStore } from "../store.js";

/**
 * ContainerDashboard — operations view for Docker containers.
 *
 * Shows Docker availability, running containers with session links,
 * port mappings, available images, and stop/remove actions.
 */

function stateColor(state: string): string {
  if (state === "running") return "text-cc-success bg-cc-success/10";
  if (state === "creating") return "text-cc-primary bg-cc-primary/10";
  if (state === "stopped") return "text-cc-muted bg-cc-hover";
  return "text-cc-error bg-cc-error/10";
}

export function ContainerDashboard({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const [dockerStatus, setDockerStatus] = useState<ContainerStatus | null>(null);
  const [containers, setContainers] = useState<ContainerInfoApi[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const sessionNames = useStore((s) => s.sessionNames);
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const refresh = useCallback(() => {
    Promise.all([
      api.getContainerStatus().catch(() => null),
      api.listContainers().catch(() => []),
      api.getContainerImages().catch(() => []),
    ]).then(([status, ctrs, imgs]) => {
      if (status) setDockerStatus(status);
      setContainers(ctrs);
      setImages(imgs);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleStop(sessionId: string) {
    await api.stopContainer(sessionId).catch(() => {});
    refresh();
  }

  function handleJump(sessionId: string) {
    setCurrentSession(sessionId);
    globalThis.location.hash = "#/";
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-cc-muted text-sm">Loading...</div>;
  }

  return (
    <div className={embedded ? "px-4 py-6 max-w-5xl mx-auto" : "p-6 max-w-5xl mx-auto"}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-cc-fg">Containers</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">Docker container management for sandboxed sessions</p>
        </div>
        <button onClick={refresh} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer">
          Refresh
        </button>
      </div>

      {/* Docker status card */}
      <div className="rounded-xl border border-cc-border bg-cc-card px-4 py-3 mb-5 flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${dockerStatus?.available ? "bg-cc-success/10" : "bg-cc-error/10"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`w-5 h-5 ${dockerStatus?.available ? "text-cc-success" : "text-cc-error"}`} aria-hidden>
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" />
            {dockerStatus?.available && <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />}
            {!dockerStatus?.available && <><path d="M15 9l-6 6" strokeLinecap="round" /><path d="M9 9l6 6" strokeLinecap="round" /></>}
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-medium text-cc-fg">
            Docker {dockerStatus?.available ? "Available" : "Not Available"}
          </p>
          {dockerStatus?.version && (
            <p className="text-[11px] text-cc-muted font-mono-code">{dockerStatus.version}</p>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-cc-muted">
          <span className="tabular-nums">{containers.length} container{containers.length === 1 ? "" : "s"}</span>
          <span className="tabular-nums">{images.length} image{images.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      {/* Running containers */}
      {containers.length > 0 && (
        <div className="mb-5">
          <h2 className="text-[12px] font-semibold text-cc-fg mb-2">Running Containers</h2>
          <div className="space-y-2">
            {containers.map((c) => {
              const sessionId = c.name.replace("campfire-", "");
              const sessionName = sessionNames.get(sessionId);
              return (
                <div key={c.containerId} className="rounded-xl border border-cc-border bg-cc-card overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* State badge */}
                    <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${stateColor(c.state)}`}>
                      {c.state}
                    </span>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium text-cc-fg truncate">
                          {sessionName || sessionId.slice(0, 12)}
                        </span>
                        <span className="text-[9px] text-cc-muted font-mono-code">{c.image}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[10px] text-cc-muted font-mono-code">
                        <span title="Container ID">{c.containerId.slice(0, 12)}</span>
                        <span title="Working directory">{c.hostCwd}</span>
                      </div>
                    </div>

                    {/* Ports */}
                    {c.portMappings.length > 0 && (
                      <div className="flex gap-1 shrink-0">
                        {c.portMappings.map((p) => (
                          <span key={p.containerPort} className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
                            :{p.hostPort}→{p.containerPort}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleJump(sessionId)}
                        title="Jump to session"
                        className="p-1.5 rounded-md hover:bg-cc-hover text-cc-primary cursor-pointer transition-colors"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
                          <path d="M8.22 2.97a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06l2.97-2.97H3.75a.75.75 0 010-1.5h7.44L8.22 4.03a.75.75 0 010-1.06z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleStop(sessionId)}
                        title="Stop and remove"
                        className="p-1.5 rounded-md hover:bg-cc-hover text-cc-muted hover:text-cc-error cursor-pointer transition-colors"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
                          <path d="M4.5 4.5h7v7h-7z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {containers.length === 0 && dockerStatus?.available && (
        <div className="text-center py-12 text-cc-muted mb-5">
          <p className="text-sm">No containers running</p>
          <p className="text-xs mt-1">Create a session with container mode enabled to start one</p>
        </div>
      )}

      {/* Available images */}
      {images.length > 0 && (
        <div>
          <h2 className="text-[12px] font-semibold text-cc-fg mb-2">Available Images</h2>
          <div className="flex flex-wrap gap-1.5">
            {images.map((img) => (
              <span key={img} className="text-[11px] font-mono-code px-2.5 py-1 rounded-lg border border-cc-border bg-cc-card text-cc-fg">
                {img}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

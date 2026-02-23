import { useState, useEffect } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { AgentCapabilities, RouteTaskResult } from "../types.js";

export function TaskRouterPage() {
  const sdkSessions = useStore((s) => s.sdkSessions);
  const [capabilities, setCapabilities] = useState<AgentCapabilities[]>([]);
  const [taskDescription, setTaskDescription] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [result, setResult] = useState<RouteTaskResult | null>(null);
  const [routing, setRouting] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadCapabilities();
  }, []);

  async function loadCapabilities() {
    setLoading(true);
    try {
      const data = await api.getCapabilities();
      setCapabilities(data.sessions || []);
      // Auto-select all by default
      setSelectedSessions(data.sessions.map((s) => s.sessionId));
    } catch (err) {
      console.error("[TaskRouterPage] Failed to load capabilities:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRoute() {
    if (!taskDescription.trim() || selectedSessions.length === 0) return;
    setRouting(true);
    setResult(null);
    try {
      const routeResult = await api.routeTask({
        taskDescription,
        availableSessions: selectedSessions,
      });
      setResult(routeResult);
    } catch (err) {
      console.error("[TaskRouterPage] Failed to route task:", err);
    } finally {
      setRouting(false);
    }
  }

  function toggleSession(sessionId: string) {
    setSelectedSessions((prev) =>
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId]
    );
  }

  function getSessionName(sessionId: string): string {
    const session = sdkSessions.find((s) => s.sessionId === sessionId);
    return session?.name || `Session ${sessionId.slice(0, 8)}`;
  }

  return (
    <div className="flex h-full bg-cc-bg">
      {/* Left: Task Input + Session Selection */}
      <div className="w-1/2 border-r border-cc-border overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-lg font-semibold text-cc-fg">Task Router</h1>
            <p className="text-sm text-cc-muted mt-1">
              Route complex tasks to the best-suited agent based on capabilities and historical performance
            </p>
          </div>

          {/* Task Input */}
          <div>
            <label className="block text-sm font-medium text-cc-fg mb-2">
              Task Description
            </label>
            <textarea
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              placeholder="Describe the task you want to route... e.g., 'Refactor auth module to use JWT tokens with TypeScript strict mode'"
              className="w-full px-3 py-2 text-sm bg-cc-card border border-cc-border rounded-lg text-cc-fg placeholder-cc-muted focus:outline-none focus:border-cc-primary resize-none"
              rows={4}
            />
          </div>

          {/* Available Sessions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-cc-fg">
                Available Sessions ({selectedSessions.length}/{capabilities.length})
              </label>
              <button
                onClick={() =>
                  setSelectedSessions(
                    selectedSessions.length === capabilities.length
                      ? []
                      : capabilities.map((c) => c.sessionId)
                  )
                }
                className="text-xs text-cc-primary hover:underline cursor-pointer"
              >
                {selectedSessions.length === capabilities.length ? "Deselect All" : "Select All"}
              </button>
            </div>
            {loading ? (
              <div className="text-sm text-cc-muted">Loading capabilities...</div>
            ) : capabilities.length === 0 ? (
              <div className="text-sm text-cc-muted">No active sessions with capabilities reported</div>
            ) : (
              <div className="space-y-2">
                {capabilities.map((cap) => (
                  <div
                    key={cap.sessionId}
                    onClick={() => toggleSession(cap.sessionId)}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedSessions.includes(cap.sessionId)
                        ? "bg-cc-active border-cc-primary"
                        : "bg-cc-card border-cc-border hover:border-cc-primary/50"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-cc-fg">
                            {getSessionName(cap.sessionId)}
                          </span>
                          <span className="px-1.5 py-0.5 text-[10px] bg-cc-hover text-cc-muted rounded">
                            {cap.backendType}
                          </span>
                        </div>
                        {cap.strengths.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {cap.strengths.slice(0, 5).map((strength) => (
                              <span key={strength} className="px-1.5 py-0.5 text-[10px] bg-green-500/20 text-green-400 rounded">
                                {strength}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-cc-muted text-right">
                        <div>{cap.availableTools.length} tools</div>
                        <div>{cap.contextUsedPercent.toFixed(0)}% context</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Route Button */}
          <button
            onClick={handleRoute}
            disabled={!taskDescription.trim() || selectedSessions.length === 0 || routing}
            className="w-full px-4 py-2 text-sm font-medium text-white bg-cc-primary hover:bg-cc-primary/90 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {routing ? "Routing..." : "Route Task"}
          </button>
        </div>
      </div>

      {/* Right: Routing Result */}
      <div className="w-1/2 overflow-y-auto">
        {result ? (
          <div className="p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-cc-fg">Routing Result</h2>
              <p className="text-sm text-cc-muted mt-1">Best agent for this task</p>
            </div>

            {/* Winner */}
            <div className="p-4 bg-cc-card border-2 border-cc-primary rounded-lg">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-cc-primary" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                    </svg>
                    <span className="text-base font-semibold text-cc-fg">
                      {getSessionName(result.sessionId)}
                    </span>
                  </div>
                  <span className="px-2 py-0.5 text-xs bg-cc-hover text-cc-muted rounded inline-block mt-1">
                    {result.backendType}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-cc-primary">
                    {(result.confidence * 100).toFixed(0)}%
                  </div>
                  <div className="text-xs text-cc-muted">confidence</div>
                </div>
              </div>
              <div className="mt-3 p-3 bg-cc-bg rounded border border-cc-border">
                <div className="text-xs font-semibold text-cc-muted mb-1">Reasoning:</div>
                <p className="text-sm text-cc-fg">{result.reasoning}</p>
              </div>
            </div>

            {/* Alternatives */}
            {result.alternatives.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-cc-fg mb-2">Alternative Options</h3>
                <div className="space-y-2">
                  {result.alternatives.map((alt, i) => (
                    <div key={i} className="p-3 bg-cc-card border border-cc-border rounded-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-cc-fg">
                            {getSessionName(alt.sessionId)}
                          </span>
                          <span className="px-1.5 py-0.5 text-[10px] bg-cc-hover text-cc-muted rounded">
                            {alt.backendType}
                          </span>
                        </div>
                        <span className="text-sm font-semibold text-cc-muted">
                          {(alt.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-cc-muted">
            <svg className="w-16 h-16 mb-4 opacity-20" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd"/>
            </svg>
            <p className="text-sm">No routing result yet</p>
            <p className="text-xs text-cc-muted mt-1">Describe a task and route it to see recommendations</p>
          </div>
        )}
      </div>
    </div>
  );
}

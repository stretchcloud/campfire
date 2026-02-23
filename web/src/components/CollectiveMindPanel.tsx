import { useState, useEffect } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ContextFragment, ConsensusState } from "../types.js";

export function CollectiveMindPanel() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const [fragments, setFragments] = useState<ContextFragment[]>([]);
  const [consensus, setConsensus] = useState<ConsensusState | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"stream" | "consensus">("stream");
  const [filterType, setFilterType] = useState<string>("");

  useEffect(() => {
    if (!currentSessionId) return;
    loadContext();
    const interval = setInterval(loadContext, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, [currentSessionId]);

  async function loadContext() {
    if (!currentSessionId) return;
    setLoading(true);
    try {
      const [streamData, consensusData] = await Promise.all([
        api.getContextStream(currentSessionId),
        api.getConsensusState(currentSessionId),
      ]);
      setFragments(streamData.fragments || []);
      setConsensus(consensusData);
    } catch (err) {
      console.error("[CollectiveMindPanel] Failed to load context:", err);
    } finally {
      setLoading(false);
    }
  }

  if (!currentSessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-cc-muted">
        <svg className="w-16 h-16 mb-4 opacity-20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <p className="text-sm">No session selected</p>
        <p className="text-xs text-cc-muted mt-1">Select a session to view its collective reasoning</p>
      </div>
    );
  }

  const allTypes = Array.from(new Set(fragments.map((f) => f.type))).sort();
  const filteredFragments = filterType
    ? fragments.filter((f) => f.type === filterType)
    : fragments;

  const sortedFragments = [...filteredFragments].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="flex flex-col h-full bg-cc-bg">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-cc-border">
        <h2 className="text-sm font-semibold text-cc-fg mb-3">Collective Mind</h2>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-cc-hover rounded-lg p-0.5">
          <button
            onClick={() => setTab("stream")}
            className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === "stream"
                ? "bg-cc-card text-cc-fg shadow-sm"
                : "text-cc-muted hover:text-cc-fg"
            }`}
          >
            Thought Stream ({fragments.length})
          </button>
          <button
            onClick={() => setTab("consensus")}
            className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === "consensus"
                ? "bg-cc-card text-cc-fg shadow-sm"
                : "text-cc-muted hover:text-cc-fg"
            }`}
          >
            Consensus
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "stream" && (
          <div className="p-4 space-y-3">
            {/* Type filter */}
            {allTypes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2 border-b border-cc-border">
                <button
                  onClick={() => setFilterType("")}
                  className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
                    !filterType
                      ? "bg-cc-primary text-white"
                      : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  All
                </button>
                {allTypes.map((type) => (
                  <button
                    key={type}
                    onClick={() => setFilterType(type)}
                    className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
                      filterType === type
                        ? "bg-cc-primary text-white"
                        : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            )}

            {sortedFragments.length === 0 ? (
              <div className="text-center py-8 text-cc-muted text-sm">
                {loading ? "Loading..." : "No thoughts in the stream yet"}
              </div>
            ) : (
              <div className="space-y-3">
                {sortedFragments.map((frag) => (
                  <div
                    key={frag.fragmentId}
                    className={`p-3 rounded-lg border ${
                      frag.consensusScore > 0.7
                        ? "bg-green-500/5 border-green-500/30"
                        : frag.isControversial
                        ? "bg-orange-500/5 border-orange-500/30"
                        : "bg-cc-card border-cc-border"
                    }`}
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          frag.isHuman ? "bg-blue-400" : "bg-purple-400"
                        }`} />
                        <span className="text-xs text-cc-muted">
                          {frag.isHuman ? "Human" : "Agent"} · {frag.agentId.slice(0, 8)}
                        </span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                          frag.type === "thought" ? "bg-purple-500/20 text-purple-400" :
                          frag.type === "observation" ? "bg-blue-500/20 text-blue-400" :
                          frag.type === "plan" ? "bg-green-500/20 text-green-400" :
                          frag.type === "question" ? "bg-yellow-500/20 text-yellow-400" :
                          frag.type === "answer" ? "bg-teal-500/20 text-teal-400" :
                          frag.type === "insight" ? "bg-pink-500/20 text-pink-400" :
                          "bg-red-500/20 text-red-400"
                        }`}>
                          {frag.type}
                        </span>
                        <span className="text-xs text-cc-muted">
                          {new Date(frag.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {frag.consensusScore > 0 && (
                          <span className="text-xs text-cc-muted font-mono">
                            {(frag.consensusScore * 100).toFixed(0)}% agree
                          </span>
                        )}
                        {frag.isControversial && (
                          <span className="text-xs text-orange-400">⚠ Controversial</span>
                        )}
                      </div>
                    </div>

                    {/* Content */}
                    <p className="text-sm text-cc-fg mb-2">{frag.content}</p>

                    {/* Semantic links */}
                    {frag.semanticLinks.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {frag.semanticLinks.map((link, i) => (
                          <span
                            key={i}
                            className={`px-1.5 py-0.5 text-[10px] rounded ${
                              link.relation === "agrees_with" ? "bg-green-500/20 text-green-400" :
                              link.relation === "disagrees_with" ? "bg-red-500/20 text-red-400" :
                              link.relation === "builds_on" ? "bg-blue-500/20 text-blue-400" :
                              link.relation === "contradicts" ? "bg-orange-500/20 text-orange-400" :
                              "bg-yellow-500/20 text-yellow-400"
                            }`}
                          >
                            {link.relation.replace("_", " ")} #{link.targetFragmentId.slice(0, 6)}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Thread indicator */}
                    {frag.parentId && (
                      <div className="mt-2 text-xs text-cc-muted">
                        ↳ Reply to #{frag.parentId.slice(0, 8)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "consensus" && (
          <div className="p-4 space-y-4">
            {!consensus ? (
              <div className="text-center py-8 text-cc-muted text-sm">
                {loading ? "Loading..." : "No consensus data yet"}
              </div>
            ) : (
              <>
                {/* Consensus Points */}
                {consensus.consensusPoints.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-cc-fg mb-2 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-green-400" />
                      Consensus Points ({consensus.consensusPoints.length})
                    </h3>
                    <div className="space-y-2">
                      {consensus.consensusPoints.map((fragmentId) => {
                        const frag = fragments.find((f) => f.fragmentId === fragmentId);
                        return frag ? (
                          <div key={fragmentId} className="p-2 bg-green-500/5 border border-green-500/30 rounded text-sm">
                            <div className="text-cc-fg">{frag.content}</div>
                            <div className="text-xs text-cc-muted mt-1">
                              {(frag.consensusScore * 100).toFixed(0)}% agreement
                            </div>
                          </div>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}

                {/* Disagreements */}
                {consensus.disagreements.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-cc-fg mb-2 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-orange-400" />
                      Disagreements ({consensus.disagreements.length})
                    </h3>
                    <div className="space-y-2">
                      {consensus.disagreements.map((cluster, i) => (
                        <div key={i} className="p-3 bg-orange-500/5 border border-orange-500/30 rounded">
                          <div className="text-sm font-medium text-cc-fg mb-1">{cluster.topic}</div>
                          <div className="text-sm text-cc-muted mb-2">{cluster.summary}</div>
                          <div className="text-xs text-cc-muted">
                            {cluster.fragmentIds.length} conflicting thoughts
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Open Questions */}
                {consensus.openQuestions.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-cc-fg mb-2 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-yellow-400" />
                      Open Questions ({consensus.openQuestions.length})
                    </h3>
                    <div className="space-y-2">
                      {consensus.openQuestions.map((fragmentId) => {
                        const frag = fragments.find((f) => f.fragmentId === fragmentId);
                        return frag ? (
                          <div key={fragmentId} className="p-2 bg-yellow-500/5 border border-yellow-500/30 rounded text-sm">
                            <div className="text-cc-fg">{frag.content}</div>
                            <div className="text-xs text-cc-muted mt-1">
                              Asked by {frag.isHuman ? "human" : "agent"} · No answers yet
                            </div>
                          </div>
                        ) : null;
                      })}
                    </div>
                  </div>
                )}

                {consensus.consensusPoints.length === 0 &&
                 consensus.disagreements.length === 0 &&
                 consensus.openQuestions.length === 0 && (
                  <div className="text-center py-8 text-cc-muted text-sm">
                    No consensus data available yet
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { api } from "../api.js";
import type { DeliberationProposal, DeliberationResponse, DeliberationStance } from "../types.js";

interface DeliberationCardProps {
  proposal: DeliberationProposal;
  responses?: DeliberationResponse[];
  onRespond?: () => void;
}

export function DeliberationCard({ proposal, responses = [], onRespond }: DeliberationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState(false);
  const [stance, setStance] = useState<DeliberationStance>("agree");
  const [reasoning, setReasoning] = useState("");
  const [alternative, setAlternative] = useState("");

  const deadline = proposal.deadline ? new Date(proposal.deadline) : null;
  const isExpired = deadline && deadline.getTime() < Date.now();
  const timeLeft = deadline
    ? Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 1000 / 60))
    : null;

  const voteBreakdown = {
    agree: responses.filter((r) => r.stance === "agree").length,
    disagree: responses.filter((r) => r.stance === "disagree").length,
    suggest_alternative: responses.filter((r) => r.stance === "suggest_alternative").length,
    abstain: responses.filter((r) => r.stance === "abstain").length,
  };

  async function handleRespond() {
    if (!reasoning.trim()) return;
    setResponding(true);
    try {
      await api.respondToDeliberation(proposal.sessionId, proposal.proposalId, {
        stance,
        reasoning,
        suggestedAlternative: stance === "suggest_alternative" ? alternative : undefined,
      });
      setReasoning("");
      setAlternative("");
      onRespond?.();
    } catch (err) {
      console.error("[DeliberationCard] Failed to respond:", err);
    } finally {
      setResponding(false);
    }
  }

  async function handleResolve() {
    try {
      await api.resolveDeliberation(proposal.sessionId, proposal.proposalId);
      onRespond?.();
    } catch (err) {
      console.error("[DeliberationCard] Failed to resolve:", err);
    }
  }

  return (
    <div className="p-4 bg-cc-card border-2 border-cc-warning/30 rounded-lg space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-cc-warning animate-pulse" />
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-cc-warning/20 text-cc-warning rounded uppercase">
                {proposal.action}
              </span>
              <span className="text-xs text-cc-muted">
                {new Date(proposal.timestamp).toLocaleString()}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-cc-fg mt-1">{proposal.title}</h3>
          </div>
        </div>
        {timeLeft !== null && !isExpired && (
          <span className="text-xs text-cc-warning font-medium">
            {timeLeft}m left
          </span>
        )}
      </div>

      {/* Description */}
      <div className="text-sm text-cc-fg">
        <p className="mb-2">{proposal.description}</p>
        {expanded && (
          <>
            <div className="mt-3 p-2 bg-cc-bg rounded border border-cc-border">
              <div className="text-xs font-semibold text-cc-muted mb-1">Proposed Approach:</div>
              <p className="text-sm">{proposal.approach}</p>
            </div>

            {proposal.alternatives.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-xs font-semibold text-cc-muted">Alternatives:</div>
                {proposal.alternatives.map((alt, i) => (
                  <div key={i} className="p-2 bg-cc-bg rounded border border-cc-border text-xs">
                    <div className="font-medium">{alt.description}</div>
                    <div className="text-cc-muted mt-0.5">Trade-offs: {alt.tradeoffs}</div>
                  </div>
                ))}
              </div>
            )}

            {proposal.risks.length > 0 && (
              <div className="mt-2 p-2 bg-red-500/5 border border-red-500/20 rounded">
                <div className="text-xs font-semibold text-red-400 mb-1">Risks:</div>
                <ul className="text-xs text-cc-fg space-y-0.5 list-disc list-inside">
                  {proposal.risks.map((risk, i) => (
                    <li key={i}>{risk}</li>
                  ))}
                </ul>
              </div>
            )}

            {proposal.affectedFiles.length > 0 && (
              <div className="mt-2 text-xs">
                <span className="text-cc-muted">Affected files:</span>{" "}
                <span className="font-mono text-cc-fg">
                  {proposal.affectedFiles.slice(0, 3).join(", ")}
                  {proposal.affectedFiles.length > 3 && ` +${proposal.affectedFiles.length - 3} more`}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Toggle expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-cc-primary hover:underline cursor-pointer"
      >
        {expanded ? "Show less" : "Show details"}
      </button>

      {/* Vote breakdown */}
      {responses.length > 0 && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-cc-muted">Responses:</span>
          <span className="text-green-400">✓ {voteBreakdown.agree}</span>
          <span className="text-red-400">✗ {voteBreakdown.disagree}</span>
          <span className="text-yellow-400">⚠ {voteBreakdown.suggest_alternative}</span>
          <span className="text-cc-muted">○ {voteBreakdown.abstain}</span>
        </div>
      )}

      {/* Response form */}
      <div className="space-y-2 pt-2 border-t border-cc-border">
        <div className="flex items-center gap-2">
          {(["agree", "disagree", "suggest_alternative", "abstain"] as DeliberationStance[]).map((s) => (
            <button
              key={s}
              onClick={() => setStance(s)}
              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer ${
                stance === s
                  ? "bg-cc-primary text-white"
                  : "bg-cc-hover text-cc-muted hover:text-cc-fg"
              }`}
            >
              {s === "agree" ? "✓ Agree" :
               s === "disagree" ? "✗ Disagree" :
               s === "suggest_alternative" ? "⚠ Suggest" :
               "○ Abstain"}
            </button>
          ))}
        </div>

        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          placeholder="Your reasoning..."
          className="w-full px-3 py-2 text-sm bg-cc-bg border border-cc-border rounded text-cc-fg placeholder-cc-muted focus:outline-none focus:border-cc-primary resize-none"
          rows={2}
        />

        {stance === "suggest_alternative" && (
          <textarea
            value={alternative}
            onChange={(e) => setAlternative(e.target.value)}
            placeholder="Describe your alternative approach..."
            className="w-full px-3 py-2 text-sm bg-cc-bg border border-cc-border rounded text-cc-fg placeholder-cc-muted focus:outline-none focus:border-cc-primary resize-none"
            rows={2}
          />
        )}

        <div className="flex gap-2">
          <button
            onClick={handleRespond}
            disabled={!reasoning.trim() || responding}
            className="px-3 py-1.5 text-sm font-medium text-white bg-cc-primary hover:bg-cc-primary/90 rounded cursor-pointer disabled:opacity-50"
          >
            {responding ? "Submitting..." : "Submit Response"}
          </button>
          <button
            onClick={handleResolve}
            className="px-3 py-1.5 text-sm font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover rounded cursor-pointer"
          >
            Resolve Now
          </button>
        </div>
      </div>
    </div>
  );
}

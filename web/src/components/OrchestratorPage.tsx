import { useState, useEffect, useCallback } from "react";
import { api, type OrchestratorPipeline, type OrchestratorRun, type OrchestratorStageInput } from "../api.js";

type View = "list" | "create" | "run-view";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "text-cc-muted",
  running: "text-cc-primary",
  completed: "text-cc-success",
  failed: "text-cc-error",
  cancelled: "text-cc-warning",
  skipped: "text-cc-muted/50",
};

const STATUS_DOTS: Record<string, string> = {
  pending: "bg-cc-muted/30",
  running: "bg-cc-primary animate-pulse",
  completed: "bg-cc-success",
  failed: "bg-cc-error",
  cancelled: "bg-cc-warning",
  skipped: "bg-cc-muted/20",
};

// ─── Stage Editor ──────────────────────────────────────────────────────────

function StageEditor({
  stage,
  index,
  onChange,
  onRemove,
}: {
  stage: OrchestratorStageInput;
  index: number;
  onChange: (updated: OrchestratorStageInput) => void;
  onRemove: () => void;
}) {
  return (
    <div className="border border-cc-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono-code text-cc-muted">Stage {index + 1}</span>
        <button onClick={onRemove} className="text-[10px] text-cc-error hover:text-cc-error/80 transition-colors">
          Remove
        </button>
      </div>
      <input
        type="text"
        value={stage.name}
        onChange={(e) => onChange({ ...stage, name: e.target.value })}
        placeholder="Stage name (e.g. Implement feature)"
        className="w-full px-2.5 py-1.5 text-[12px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted/40 focus:outline-none focus:border-cc-muted/30"
      />
      <textarea
        value={stage.prompt}
        onChange={(e) => onChange({ ...stage, prompt: e.target.value })}
        placeholder="Prompt for this stage..."
        rows={3}
        className="w-full px-2.5 py-1.5 text-[12px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted/40 focus:outline-none focus:border-cc-muted/30 resize-none font-mono-code"
      />
      <div className="flex items-center gap-2">
        <select
          value={stage.backend}
          onChange={(e) => onChange({ ...stage, backend: e.target.value })}
          className="px-2 py-1 text-[11px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="goose">Goose</option>
          <option value="aider">Aider</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-cc-muted cursor-pointer">
          <input
            type="checkbox"
            checked={stage.inheritContext ?? true}
            onChange={(e) => onChange({ ...stage, inheritContext: e.target.checked })}
            className="rounded"
          />
          Pass context from previous stage
        </label>
      </div>
    </div>
  );
}

// ─── Pipeline Create/Edit Form ─────────────────────────────────────────────

function PipelineForm({
  onSave,
  onCancel,
}: {
  onSave: (pipeline: OrchestratorPipeline) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cwd, setCwd] = useState("");
  const [stages, setStages] = useState<OrchestratorStageInput[]>([
    { name: "Implement", prompt: "", backend: "claude", inheritContext: false },
    { name: "Test", prompt: "Run the test suite and fix any failures.", backend: "claude", inheritContext: true },
    { name: "Review", prompt: "Review the changes for code quality, security, and best practices.", backend: "claude", inheritContext: true },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getHome().then((r) => setCwd(r.cwd)).catch(() => {});
  }, []);

  const addStage = () => {
    setStages([...stages, { name: "", prompt: "", backend: "claude", inheritContext: true }]);
  };

  const handleSave = async () => {
    if (!name.trim() || !cwd.trim() || stages.length === 0) return;
    setSaving(true);
    try {
      const result = await api.createPipeline({ name: name.trim(), description: description.trim() || undefined, cwd, stages });
      onSave(result);
    } catch (e) {
      console.error("Failed to create pipeline:", e);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-cc-fg">Create Pipeline</h2>
        <button onClick={onCancel} className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors">Cancel</button>
      </div>

      <div className="space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pipeline name"
          className="w-full px-3 py-2 text-[13px] bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/40 focus:outline-none focus:border-cc-muted/30"
        />
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full px-3 py-2 text-[13px] bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/40 focus:outline-none focus:border-cc-muted/30"
        />
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Working directory"
          className="w-full px-3 py-2 text-[13px] bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/40 focus:outline-none focus:border-cc-muted/30 font-mono-code"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-cc-fg">Stages</span>
          <button onClick={addStage} className="text-[11px] text-cc-primary hover:text-cc-primary-hover transition-colors">
            + Add Stage
          </button>
        </div>
        {stages.map((stage, i) => (
          <StageEditor
            key={i}
            stage={stage}
            index={i}
            onChange={(updated) => {
              const next = [...stages];
              next[i] = updated;
              setStages(next);
            }}
            onRemove={() => setStages(stages.filter((_, j) => j !== i))}
          />
        ))}
      </div>

      <button
        onClick={handleSave}
        disabled={saving || !name.trim() || !cwd.trim() || stages.length === 0}
        className="w-full py-2 rounded-lg text-[13px] font-medium transition-colors bg-cc-fg text-cc-bg hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {saving ? "Creating..." : "Create Pipeline"}
      </button>
    </div>
  );
}

// ─── Run View ──────────────────────────────────────────────────────────────

function RunView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<OrchestratorRun | null>(null);

  const pollRun = useCallback(async () => {
    try {
      const r = await api.getRun(runId);
      setRun(r);
      return r.status === "running" || r.status === "pending";
    } catch {
      return false;
    }
  }, [runId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      const shouldContinue = await pollRun();
      if (active && shouldContinue) {
        setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { active = false; };
  }, [pollRun]);

  if (!run) {
    return <div className="text-[13px] text-cc-muted p-6 text-center">Loading run...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3"><path d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z"/></svg>
          Back
        </button>
        <span className={`text-[11px] font-mono-code ${STATUS_COLORS[run.status]}`}>{run.status}</span>
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-cc-fg">{run.pipelineName}</h3>
        <div className="flex items-center gap-3 mt-1 text-[11px] text-cc-muted font-mono-code">
          <span>{formatDuration(run.totalDurationMs)}</span>
          <span>{formatCost(run.totalCostUsd)}</span>
        </div>
      </div>

      {/* Stage timeline */}
      <div className="space-y-0">
        {run.stageResults.map((result, i) => (
          <div key={result.stageId} className="flex items-start gap-3 relative">
            {/* Vertical connector */}
            {i < run.stageResults.length - 1 && (
              <div className="absolute left-[7px] top-[18px] bottom-0 w-px bg-cc-border" />
            )}
            {/* Status dot */}
            <div className={`w-[15px] h-[15px] rounded-full border-2 border-cc-bg shrink-0 mt-0.5 ${STATUS_DOTS[result.status]}`} />
            {/* Content */}
            <div className="flex-1 pb-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-cc-fg">
                  Stage {i + 1}
                </span>
                <span className={`text-[10px] font-mono-code ${STATUS_COLORS[result.status]}`}>
                  {result.status}
                  {result.durationMs ? ` · ${formatDuration(result.durationMs)}` : ""}
                  {result.costUsd ? ` · ${formatCost(result.costUsd)}` : ""}
                </span>
              </div>
              {result.sessionId && (
                <a
                  href={`#/?session=${result.sessionId}`}
                  className="text-[10px] text-cc-primary hover:text-cc-primary-hover font-mono-code mt-0.5 inline-block"
                >
                  View session
                </a>
              )}
              {result.error && (
                <p className="text-[10px] text-cc-error mt-1 font-mono-code">{result.error}</p>
              )}
              {result.outputSummary && (
                <p className="text-[10px] text-cc-muted mt-1 line-clamp-2">{result.outputSummary}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {run.status === "running" && (
        <button
          onClick={async () => {
            await api.cancelRun(run.id);
            pollRun();
          }}
          className="w-full py-2 rounded-lg text-[12px] bg-cc-error/10 text-cc-error hover:bg-cc-error/20 transition-colors"
        >
          Cancel Run
        </button>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export function OrchestratorPage() {
  const [view, setView] = useState<View>("list");
  const [pipelines, setPipelines] = useState<OrchestratorPipeline[]>([]);
  const [runs, setRuns] = useState<OrchestratorRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.listPipelines(), api.listRuns()]);
      setPipelines(p);
      setRuns(r);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (view === "create") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          <PipelineForm
            onSave={() => { refresh(); setView("list"); }}
            onCancel={() => setView("list")}
          />
        </div>
      </div>
    );
  }

  if (view === "run-view" && activeRunId) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          <RunView runId={activeRunId} onBack={() => { setView("list"); refresh(); }} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-cc-fg">Orchestrator</h1>
            <p className="text-[12px] text-cc-muted mt-0.5">
              Chain multiple AI sessions into multi-stage pipelines
            </p>
          </div>
          <button
            onClick={() => setView("create")}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-fg text-cc-bg hover:opacity-80 transition-colors"
          >
            New Pipeline
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8 text-[13px] text-cc-muted">Loading...</div>
        ) : (
          <>
            {/* Pipelines */}
            {pipelines.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-cc-border rounded-lg">
                <p className="text-[13px] text-cc-muted">No pipelines yet</p>
                <p className="text-[11px] text-cc-muted/60 mt-1">
                  Create a pipeline to chain AI sessions into multi-stage workflows
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <h2 className="text-[12px] text-cc-muted uppercase tracking-wider font-medium">Pipelines</h2>
                {pipelines.map((p) => (
                  <div key={p.id} className="border border-cc-border rounded-lg p-3 hover:bg-cc-hover/30 transition-colors">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[13px] font-medium text-cc-fg">{p.name}</span>
                        {p.description && (
                          <p className="text-[11px] text-cc-muted mt-0.5">{p.description}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-cc-muted/60 font-mono-code">{p.stages.length} stages</span>
                          <span className="text-[10px] text-cc-muted/60 font-mono-code">{p.cwd}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={async () => {
                            try {
                              const run = await api.runPipeline(p.id);
                              setActiveRunId(run.id);
                              setView("run-view");
                            } catch (e) {
                              console.error("Failed to run pipeline:", e);
                            }
                          }}
                          className="px-2.5 py-1 rounded-md text-[11px] bg-cc-primary/10 text-cc-primary hover:bg-cc-primary/20 transition-colors"
                        >
                          Run
                        </button>
                        <button
                          onClick={async () => {
                            await api.deletePipeline(p.id);
                            refresh();
                          }}
                          className="px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-error transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Recent Runs */}
            {runs.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-[12px] text-cc-muted uppercase tracking-wider font-medium">Recent Runs</h2>
                {runs.slice(0, 10).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => { setActiveRunId(r.id); setView("run-view"); }}
                    className="w-full border border-cc-border rounded-lg p-3 hover:bg-cc-hover/30 transition-colors text-left"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium text-cc-fg">{r.pipelineName}</span>
                      <span className={`text-[10px] font-mono-code ${STATUS_COLORS[r.status]}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-cc-muted font-mono-code">
                      <span>{formatDuration(r.totalDurationMs)}</span>
                      <span>{formatCost(r.totalCostUsd)}</span>
                      <span>{r.stageResults.filter((s) => s.status === "completed").length}/{r.stageResults.length} stages</span>
                      <span>{new Date(r.startedAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

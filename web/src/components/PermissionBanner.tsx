import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store.js";
import { sendToSession, resolveSessionFilePath } from "../ws.js";
import type { PermissionRequest, PermissionVote as PermissionVoteType } from "../types.js";
import type { PermissionUpdate } from "../../server/session-types.js";
import { DiffViewer } from "./DiffViewer.js";

/** Human-readable label for a permission suggestion */
function suggestionLabel(s: PermissionUpdate): string {
  if (s.type === "setMode") return `Set mode to "${s.mode}"`;
  const dest = s.destination;
  const scope = dest === "session" ? "for session" : "always";
  if (s.type === "addRules" || s.type === "replaceRules") {
    const rule = s.rules[0];
    if (rule?.ruleContent) return `Allow "${rule.ruleContent}" ${scope}`;
    if (rule?.toolName) return `Allow ${rule.toolName} ${scope}`;
  }
  if (s.type === "addDirectories") {
    return `Trust ${s.directories[0] || "directory"} ${scope}`;
  }
  return `Allow ${scope}`;
}

/** Classify tool as read or write for severity-based styling */
function toolSeverity(toolName: string): "read" | "write" | "ask" {
  if (toolName === "AskUserQuestion") return "ask";
  const readTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  if (readTools.includes(toolName)) return "read";
  return "write";
}

export function PermissionBanner({
  permission,
  sessionId,
}: {
  permission: PermissionRequest;
  sessionId: string;
}) {
  const [loading, setLoading] = useState(false);
  const removePermission = useStore((s) => s.removePermission);
  const removeChangedFile = useStore((s) => s.removeChangedFile);
  // Default to "spectator" until role_assigned arrives -- this prevents
  // spectators from acting as owners during the brief window before the
  // server sends their role.  Owners always receive role_assigned promptly.
  const myRole = useStore((s) => s.myRole.get(sessionId) ?? "spectator");

  function handleAllow(updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionUpdate[]) {
    if (myRole === "spectator") return; // guard: spectators cannot vote
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "allow",
      updated_input: updatedInput,
      ...(updatedPermissions?.length ? { updated_permissions: updatedPermissions } : {}),
    });
    removePermission(sessionId, permission.request_id);
  }

  function handleDeny() {
    if (myRole === "spectator") return; // guard: spectators cannot vote
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "deny",
      message: "Denied by user",
    });
    // Remove file from changedFiles if this was a Write/Edit that was denied
    // (the file was never actually written, so it shouldn't appear in the diff view)
    if (
      (permission.tool_name === "Write" || permission.tool_name === "Edit") &&
      typeof permission.input?.file_path === "string"
    ) {
      const sessionCwd =
        useStore.getState().sessions.get(sessionId)?.cwd ||
        useStore.getState().sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
      const resolved = resolveSessionFilePath(permission.input.file_path as string, sessionCwd);
      removeChangedFile(sessionId, resolved);
    }
    removePermission(sessionId, permission.request_id);
  }

  const isAskUser = permission.tool_name === "AskUserQuestion";
  const suggestions = permission.permission_suggestions;
  const severity = toolSeverity(permission.tool_name);

  const severityBorder =
    severity === "read"
      ? "border-l-4 border-l-blue-400/50"
      : severity === "ask"
      ? "border-l-4 border-l-cc-primary/50"
      : "border-l-4 border-l-amber-400/50";

  return (
    <div className="px-4 py-3 border-t border-cc-border animate-[fadeSlideIn_0.2s_ease-out]">
      <div className={`max-w-3xl mx-auto rounded-xl border bg-cc-card shadow-sm p-4 ${severityBorder}`}>
        <div className="flex items-start gap-2 sm:gap-3">
          {/* Icon */}
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
            isAskUser
              ? "bg-gradient-to-br from-cc-primary/15 to-cc-primary/5 border border-cc-primary/20"
              : severity === "read"
              ? "bg-gradient-to-br from-blue-400/15 to-blue-400/5 border border-blue-400/20"
              : "bg-gradient-to-br from-cc-warning/15 to-cc-warning/5 border border-cc-warning/20"
          }`}>
            {isAskUser ? (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4.5 h-4.5 text-cc-primary">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            ) : severity === "read" ? (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4.5 h-4.5 text-blue-400">
                <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4.5 h-4.5 text-cc-warning">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[13px] font-semibold ${
                isAskUser ? "text-cc-primary" : severity === "read" ? "text-blue-400" : "text-cc-warning"
              }`}>
                {isAskUser ? "Question" : "Permission Request"}
              </span>
              {!isAskUser && (
                <span className="rounded-full bg-cc-hover px-2 py-0.5 text-[10px] font-mono-code text-cc-muted">{permission.tool_name}</span>
              )}
            </div>

            {isAskUser ? (
              <>
                <AskUserQuestionDisplay
                  input={permission.input}
                  onSelect={(answers) => handleAllow({ ...permission.input, answers })}
                  disabled={loading || myRole === "spectator"}
                />
                <div className="mt-2 space-y-1">
                  <VoteProgress sessionId={sessionId} requestId={permission.request_id} />
                  {myRole === "spectator" && (
                    <span className="rounded-full bg-cc-hover text-cc-muted px-2.5 py-0.5 text-[10px] italic">Spectators cannot vote</span>
                  )}
                </div>
              </>
            ) : (
              <ToolInputDisplay toolName={permission.tool_name} input={permission.input} description={permission.description} />
            )}

            {/* Actions - only for non-AskUserQuestion tools */}
            {!isAskUser && (
              <div className="mt-3 space-y-2">
                <VoteProgress sessionId={sessionId} requestId={permission.request_id} />
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => handleAllow()}
                    disabled={loading || myRole === "spectator"}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-cc-success hover:bg-cc-success/90 text-white px-4 py-2 text-[13px] font-medium shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 cursor-pointer min-h-[40px]"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
                      <path d="M3 8.5l3.5 3.5 6.5-7" />
                    </svg>
                    Allow
                    <span className="rounded-md bg-white/15 border border-white/10 px-1.5 py-0.5 text-[9px] font-mono-code ml-0.5">Y</span>
                  </button>

                  <button
                    onClick={handleDeny}
                    disabled={loading || myRole === "spectator"}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cc-error/30 text-cc-error hover:bg-cc-error/10 px-4 py-2 text-[13px] font-medium transition-all duration-200 disabled:opacity-50 cursor-pointer min-h-[40px]"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                    Deny
                    <span className="rounded-md bg-cc-hover border border-cc-border/60 px-1.5 py-0.5 text-[9px] font-mono-code text-cc-muted ml-0.5">N</span>
                  </button>

                  {myRole === "spectator" && (
                    <span className="rounded-full bg-cc-hover text-cc-muted px-2.5 py-0.5 text-[10px] italic">Spectators cannot vote</span>
                  )}
                </div>

                {/* Permission suggestions as small text links */}
                {suggestions && suggestions.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {suggestions.map((suggestion, i) => (
                      <button
                        key={i}
                        onClick={() => handleAllow(undefined, [suggestion])}
                        disabled={loading || myRole === "spectator"}
                        title={`${suggestion.type}: ${JSON.stringify(suggestion)}`}
                        className="rounded-full border border-cc-primary/20 bg-cc-primary/5 text-cc-primary px-3 py-1 text-[11px] font-medium hover:bg-cc-primary/10 disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        {suggestionLabel(suggestion)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolInputDisplay({
  toolName,
  input,
  description,
}: {
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}) {
  if (toolName === "Bash") {
    return <BashDisplay input={input} />;
  }
  if (toolName === "Edit") {
    return <EditDisplay input={input} />;
  }
  if (toolName === "Write") {
    return <WriteDisplay input={input} />;
  }
  if (toolName === "Read") {
    return <ReadDisplay input={input} />;
  }
  if (toolName === "Glob") {
    return <GlobDisplay input={input} />;
  }
  if (toolName === "Grep") {
    return <GrepDisplay input={input} />;
  }
  if (toolName === "ExitPlanMode") {
    return <ExitPlanModeDisplay input={input} />;
  }

  // Fallback: formatted key-value display
  return <GenericDisplay input={input} description={description} />;
}

function BashDisplay({ input }: { input: Record<string, unknown> }) {
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";

  return (
    <div className="space-y-1.5">
      {desc && <div className="text-xs text-cc-muted">{desc}</div>}
      <pre className="text-sm text-cc-code-fg font-mono-code bg-cc-code-bg rounded-xl border border-cc-border px-4 py-3 max-h-40 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
        <span className="text-cc-code-fg/50 select-none">$ </span>{command}
      </pre>
    </div>
  );
}

function AskUserQuestionDisplay({
  input,
  onSelect,
  disabled,
}: {
  input: Record<string, unknown>;
  onSelect: (answers: Record<string, string>) => void;
  disabled: boolean;
}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  function handleOptionClick(questionIdx: number, label: string) {
    const key = String(questionIdx);
    setSelections((prev) => ({ ...prev, [key]: label }));
    setShowCustom((prev) => ({ ...prev, [key]: false }));

    // Auto-submit if single question
    if (questions.length <= 1) {
      onSelect({ [key]: label });
    }
  }

  function handleCustomSubmit(questionIdx: number) {
    const key = String(questionIdx);
    const text = customText[key]?.trim();
    if (!text) return;
    setSelections((prev) => ({ ...prev, [key]: text }));

    if (questions.length <= 1) {
      onSelect({ [key]: text });
    }
  }

  function handleSubmitAll() {
    onSelect(selections);
  }

  if (questions.length === 0) {
    // Fallback for simple question string
    const question = typeof input.question === "string" ? input.question : "";
    if (question) {
      return (
        <div className="text-sm text-cc-fg bg-cc-code-bg/30 rounded-lg px-3 py-2">
          {question}
        </div>
      );
    }
    return <GenericDisplay input={input} />;
  }

  return (
    <div className="space-y-3">
      {questions.map((q: Record<string, unknown>, i: number) => {
        const header = typeof q.header === "string" ? q.header : "";
        const text = typeof q.question === "string" ? q.question : "";
        const options = Array.isArray(q.options) ? q.options : [];
        const key = String(i);
        const selected = selections[key];
        const isCustom = showCustom[key];

        return (
          <div key={i} className="space-y-2">
            {header && (
              <span className="inline-block text-[10px] font-semibold text-cc-primary bg-cc-primary/10 px-1.5 py-0.5 rounded">
                {header}
              </span>
            )}
            {text && (
              <p className="text-sm text-cc-fg leading-relaxed">{text}</p>
            )}
            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((opt: Record<string, unknown>, j: number) => {
                  const label = typeof opt.label === "string" ? opt.label : String(opt);
                  const desc = typeof opt.description === "string" ? opt.description : "";
                  const isSelected = selected === label;

                  return (
                    <button
                      key={j}
                      onClick={() => handleOptionClick(i, label)}
                      disabled={disabled}
                      className={`w-full text-left rounded-xl border p-3 transition-all duration-200 cursor-pointer disabled:opacity-50 ${
                        isSelected
                          ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30 shadow-sm"
                          : "border-cc-border hover:border-cc-primary/30 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          isSelected ? "border-cc-primary" : "border-cc-muted/40"
                        }`}>
                          {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-cc-primary" />}
                        </span>
                        <div>
                          <span className="text-xs font-medium text-cc-fg">{label}</span>
                          {desc && <p className="text-[11px] text-cc-muted mt-0.5 leading-snug">{desc}</p>}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* "Other" option */}
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: !prev[key] }))}
                  disabled={disabled}
                  className={`w-full text-left rounded-xl border p-3 transition-all duration-200 cursor-pointer disabled:opacity-50 ${
                    isCustom
                      ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30 shadow-sm"
                      : "border-cc-border hover:border-cc-primary/30 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isCustom ? "border-cc-primary" : "border-cc-muted/40"
                    }`}>
                      {isCustom && <span className="w-2.5 h-2.5 rounded-full bg-cc-primary" />}
                    </span>
                    <span className="text-xs font-medium text-cc-muted">Other...</span>
                  </div>
                </button>

                {isCustom && (
                  <div className="flex gap-2 pl-6">
                    <input
                      type="text"
                      value={customText[key] || ""}
                      onChange={(e) => setCustomText((prev) => ({ ...prev, [key]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCustomSubmit(i); }}
                      placeholder="Type your answer..."
                      className="flex-1 px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                    />
                    <button
                      onClick={() => handleCustomSubmit(i)}
                      disabled={!customText[key]?.trim()}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Submit all for multi-question */}
      {questions.length > 1 && Object.keys(selections).length > 0 && (
        <button
          onClick={handleSubmitAll}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

function EditDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const oldStr = String(input.old_string || "");
  const newStr = String(input.new_string || "");
  const [expanded, setExpanded] = useState(false);

  // Count lines to decide whether to cap
  const totalLines = Math.max(oldStr.split("\n").length, newStr.split("\n").length);
  const shouldCap = totalLines > 12 && !expanded;

  return (
    <div className="space-y-1">
      <div className="rounded-xl border border-cc-border overflow-hidden">
        <DiffViewer
          oldText={shouldCap ? oldStr.split("\n").slice(0, 12).join("\n") : oldStr}
          newText={shouldCap ? newStr.split("\n").slice(0, 12).join("\n") : newStr}
          fileName={filePath}
          mode="compact"
        />
      </div>
      {totalLines > 12 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[11px] text-cc-primary hover:text-cc-primary-hover cursor-pointer"
        >
          {expanded ? "Show less" : `Show more (${totalLines} lines)`}
        </button>
      )}
    </div>
  );
}

function WriteDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const content = String(input.content || "");
  const [expanded, setExpanded] = useState(false);

  const totalLines = content.split("\n").length;
  const shouldCap = totalLines > 12 && !expanded;

  return (
    <div className="space-y-1">
      <div className="rounded-xl border border-cc-border overflow-hidden">
        <DiffViewer
          newText={shouldCap ? content.split("\n").slice(0, 12).join("\n") : content}
          fileName={filePath}
          mode="compact"
        />
      </div>
      {totalLines > 12 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[11px] text-cc-primary hover:text-cc-primary-hover cursor-pointer"
        >
          {expanded ? "Show less" : `Show more (${totalLines} lines)`}
        </button>
      )}
    </div>
  );
}

function ReadDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  return (
    <div className="text-xs text-cc-muted font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2">
      {filePath}
    </div>
  );
}

function GlobDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
    </div>
  );
}

function GrepDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  const glob = typeof input.glob === "string" ? input.glob : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
      {glob && <div className="text-cc-muted">{glob}</div>}
    </div>
  );
}

function ExitPlanModeDisplay({ input }: { input: Record<string, unknown> }) {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];

  return (
    <div className="space-y-2">
      {plan && (
        <div className="rounded-lg border border-cc-border overflow-hidden">
          <div className="px-2.5 py-1.5 bg-cc-code-bg/10 border-b border-cc-border text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">
            Plan
          </div>
          <div className="px-3 py-2.5 max-h-64 overflow-y-auto text-xs text-cc-fg leading-relaxed markdown-body">
            <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
          </div>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-cc-muted uppercase tracking-wider">Requested permissions</div>
          <div className="space-y-1">
            {allowedPrompts.map((p: Record<string, unknown>, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5">
                <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                <span className="text-cc-fg">{String(p.prompt || "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan && allowedPrompts.length === 0 && (
        <div className="text-xs text-cc-muted">Plan approval requested</div>
      )}
    </div>
  );
}

/** Voting progress indicator -- shown when multiple viewers are voting on a permission request */
function VoteProgress({ sessionId, requestId }: { sessionId: string; requestId: string }) {
  const voteData = useStore((s) => s.permissionVotes.get(sessionId)?.get(requestId));
  const voteResult = useStore((s) => s.voteResults.get(sessionId)?.get(requestId));
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [totalTime] = useState(30); // 30 second voting window

  useEffect(() => {
    if (!voteData) {
      setTimeLeft(null);
      return;
    }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((voteData.deadline - Date.now()) / 1000));
      setTimeLeft(remaining);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [voteData]);

  // Show resolved result
  if (voteResult) {
    return (
      <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium ${
        voteResult.result === "allow" ? "bg-cc-success/10 text-cc-success" : "bg-cc-error/10 text-cc-error"
      }`}>
        {voteResult.result === "allow" ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
            <path d="M3 8.5l3.5 3.5 6.5-7" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        )}
        Vote resolved: {voteResult.result} ({voteResult.policy})
      </div>
    );
  }

  // No voting in progress
  if (!voteData) return null;

  const { votes, votersTotal } = voteData;
  const allowVotes = votes.filter((v: PermissionVoteType) => v.vote === "allow").length;
  const denyVotes = votes.filter((v: PermissionVoteType) => v.vote === "deny").length;

  // Calculate progress bar percentage and color
  const progressPct = timeLeft !== null ? Math.max(0, (timeLeft / totalTime) * 100) : 100;
  const timerColor =
    timeLeft !== null && timeLeft <= 5
      ? "bg-cc-error"
      : timeLeft !== null && timeLeft <= 15
      ? "bg-amber-400"
      : "bg-cc-success";

  return (
    <div className="space-y-1.5">
      {/* Countdown progress bar */}
      {timeLeft !== null && timeLeft > 0 && (
        <div className="h-2 w-full bg-cc-border rounded-full overflow-hidden">
          <div
            className={`h-full ${timerColor} transition-all duration-1000 ease-linear rounded-full`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-3 text-[11px]">
        {/* Vote counts */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-cc-success/10 text-cc-success px-2 py-0.5 font-medium">{allowVotes} allow</span>
          <span className="text-cc-muted">/</span>
          <span className="inline-flex items-center rounded-full bg-cc-error/10 text-cc-error px-2 py-0.5 font-medium">{denyVotes} deny</span>
          <span className="text-cc-muted">({votes.length}/{votersTotal} voted)</span>
        </div>

        {/* Countdown */}
        {timeLeft !== null && timeLeft > 0 && (
          <span className="text-cc-muted font-mono">{timeLeft}s</span>
        )}

        {/* Voter avatars */}
        <div className="flex items-center -space-x-1.5">
          {votes.map((v: PermissionVoteType) => (
            <div
              key={v.viewerId}
              className={`w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-bold ring-2 ring-cc-card ${
                v.vote === "allow" ? "bg-cc-success/20 text-cc-success" : "bg-cc-error/20 text-cc-error"
              }`}
              title={`${v.viewerName}: ${v.vote}`}
            >
              {v.viewerName.charAt(0).toUpperCase()}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GenericDisplay({
  input,
  description,
}: {
  input: Record<string, unknown>;
  description?: string;
}) {
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );

  if (entries.length === 0 && description) {
    return <div className="text-xs text-cc-fg">{description}</div>;
  }

  return (
    <div className="space-y-1">
      {description && <div className="text-xs text-cc-muted mb-1">{description}</div>}
      <div className="bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-1.5">
        {entries.map(([key, value]) => {
          const displayValue = typeof value === "string"
            ? value.length > 200 ? value.slice(0, 200) + "..." : value
            : JSON.stringify(value);
          return (
            <div key={key} className="flex gap-2 text-[11px] font-mono-code">
              <span className="text-cc-muted shrink-0 min-w-[60px]">{key}</span>
              <span className="text-cc-fg break-all">{displayValue}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

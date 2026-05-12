import { useMemo } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { SessionPulse } from "./SessionPulse.js";

export function ChatView({ sessionId }: Readonly<{ sessionId: string }>) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected"
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const cliLaunching = useStore((s) => s.cliLaunching.get(sessionId) ?? false);
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const terminalSubagentStatus = useStore((s) => s.completedSubagentSessions.get(sessionId));
  const isSubagent =
    session?.orchestration_role === "subagent" ||
    !!session?.parent_session_id ||
    sdkSession?.orchestrationRole === "subagent" ||
    !!sdkSession?.parentSessionId;
  const isCompletedSubagent = !!terminalSubagentStatus || (isSubagent && !cliConnected && sdkSession?.state === "exited");
  const subagentTerminalLabel =
    terminalSubagentStatus === "failed"
      ? "subagent failed"
      : terminalSubagentStatus === "timeout"
        ? "subagent timed out"
        : "subagent completed";

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms]
  );

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {/* CLI launching banner */}
      {connStatus === "connected" && !cliConnected && cliLaunching && (
        <div className="px-4 py-1.5 bg-cc-accent/5 border-b border-cc-border text-center flex items-center justify-center gap-3">
          <span className="w-1 h-1 rounded-full bg-cc-accent animate-pulse" />
          <span className="text-[11px] text-cc-muted font-mono-code">
            starting agent...
          </span>
        </div>
      )}

      {/* Completed subagent banner — one-shot MCP workers stop after returning their result */}
      {isCompletedSubagent && !cliLaunching && (
        <div className="px-4 py-1.5 bg-cc-hover/40 border-b border-cc-border text-center flex items-center justify-center gap-2">
          <span className="w-1 h-1 rounded-full bg-cc-muted/60" />
          <span className="text-[11px] text-cc-muted font-mono-code">
            {subagentTerminalLabel}
          </span>
        </div>
      )}

      {/* CLI disconnected banner — only when not launching */}
      {connStatus === "connected" && !cliConnected && !cliLaunching && !isCompletedSubagent && (
        <div className="px-4 py-1.5 bg-cc-warning/5 border-b border-cc-border text-center flex items-center justify-center gap-3">
          <span className="w-1 h-1 rounded-full bg-cc-warning animate-pulse" />
          <span className="text-[11px] text-cc-warning/80 font-mono-code">
            agent disconnected
          </span>
          <button
            onClick={() => api.relaunchSession(sessionId).catch(console.error)}
            className="text-[11px] font-mono-code px-2 py-0.5 rounded bg-cc-warning/10 hover:bg-cc-warning/20 text-cc-warning transition-colors cursor-pointer"
          >
            reconnect
          </button>
        </div>
      )}

      {/* WebSocket disconnected banner */}
      {connStatus === "disconnected" && !isCompletedSubagent && (
        <div className="px-4 py-1.5 bg-cc-warning/5 border-b border-cc-border text-center flex items-center justify-center gap-2">
          <span className="w-1 h-1 rounded-full bg-cc-warning animate-pulse" />
          <span className="text-[11px] text-cc-warning/80 font-mono-code">
            reconnecting...
          </span>
        </div>
      )}

      {/* Message feed */}
      <MessageFeed sessionId={sessionId} />

      {/* Permission banners */}
      {perms.length > 0 && (
        <div className="shrink-0 max-h-[55dvh] overflow-y-auto border-t border-cc-border">
          {perms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      )}

      {/* Composer */}
      <Composer sessionId={sessionId} />

      {/* Floating background sessions indicator */}
      <SessionPulse />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "../api.js";

type Phase = "installing" | "restarting" | "waiting" | "ready";

const PHASE_LABELS: Record<Phase, string> = {
  installing: "Installing update...",
  restarting: "Restarting server...",
  waiting: "Waiting for server...",
  ready: "Update complete.",
};

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function useServerReadyPoll(active: boolean): Phase {
  const [phase, setPhase] = useState<Phase>("installing");
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setPhase("installing");
      return;
    }

    const restartTimer = setTimeout(() => {
      if (mountedRef.current) setPhase("restarting");
    }, 3000);

    const pollStart = setTimeout(() => {
      if (mountedRef.current) setPhase("waiting");
      poll();
    }, 5000);

    function poll() {
      if (!mountedRef.current) return;

      fetch("/api/update-check", {
        headers: authHeaders(),
        signal: AbortSignal.timeout(3000),
      })
        .then((res) => {
          if (!res.ok) throw new Error("Server is not ready");
          return res.json();
        })
        .then((data: { updateInProgress?: boolean }) => {
          if (data.updateInProgress) throw new Error("Update is still running");
          if (!mountedRef.current) return;
          setPhase("ready");
          setTimeout(() => {
            if (mountedRef.current) window.location.reload();
          }, 800);
        })
        .catch(() => {
          retryRef.current = setTimeout(poll, 1500);
        });
    }

    return () => {
      clearTimeout(restartTimer);
      clearTimeout(pollStart);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [active]);

  return phase;
}

export function UpdateOverlay({ active }: Readonly<{ active: boolean }>) {
  const phase = useServerReadyPoll(active);

  if (!active) return null;

  const ready = phase === "ready";

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-cc-bg text-cc-fg animate-[fadeSlideIn_0.15s_ease-out]"
      role="status"
      aria-live="polite"
      data-testid="update-overlay"
    >
      <div className="relative mb-7">
        {!ready && <div className="absolute inset-0 -m-4 rounded-full bg-cc-primary/10 animate-pulse" />}
        <img
          src="/logo.svg"
          alt="Campfire"
          className={`relative z-10 h-20 w-20 transition-transform duration-500 ${ready ? "" : "scale-110"}`}
        />
        {!ready && (
          <div className="absolute -inset-3 z-0">
            <svg className="h-full w-full animate-[spin_1.2s_linear_infinite]" viewBox="0 0 100 100">
              <circle
                cx="50"
                cy="50"
                r="46"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="60 230"
                strokeLinecap="round"
                className="text-cc-primary/45"
              />
            </svg>
          </div>
        )}
        {ready && <div className="absolute -inset-3 z-0 rounded-full border-2 border-cc-success/30" />}
      </div>

      <p className={`mb-2 text-sm font-medium ${ready ? "text-cc-success" : "text-cc-fg"}`}>
        {PHASE_LABELS[phase]}
      </p>
      <p className="text-xs text-cc-muted">
        {ready ? "Reloading..." : "This page will refresh automatically"}
      </p>

      {!ready && (
        <div className="mt-6 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-cc-primary/50"
              style={{ animation: "pulse-dot 1.4s ease-in-out infinite", animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-border/40">
        <div className="h-full bg-cc-primary/70 transition-all duration-1000" style={{ width: ready ? "100%" : "70%" }} />
      </div>
    </div>
  );
}

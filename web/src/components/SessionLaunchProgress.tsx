import { useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";

/**
 * SessionLaunchProgress — a non-blocking floating toast that shows real-time
 * progress when ANY session is being created (standard or container).
 *
 * Unlike companion's SessionCreationProgress (container-only, full-screen overlay),
 * this is a compact bottom-left notification that:
 * - Works for ALL session types (standard + container)
 * - Tracks sessions transitioning from "starting" → "connected"
 * - Shows container-specific steps when available (from creationProgress store)
 * - Auto-dismisses after connection
 * - Non-blocking — user can navigate freely while session spins up
 */

// ─── Step Resolution ────────────────────────────────────────────────────────

interface LaunchStep {
  label: string;
  status: "done" | "active" | "pending";
}

const CONTAINER_STEP_LABELS: Record<string, string> = {
  checking_image: "Checking image",
  pulling_image: "Pulling image",
  creating_container: "Creating container",
  seeding_auth: "Seeding authentication",
  launching_agent: "Launching agent",
};

function resolveSteps(
  sessionState: string | undefined,
  containerProgress: { step: string; message: string; percent?: number } | null,
  cliConnected: boolean,
): LaunchStep[] {
  // Container flow — use granular step data
  if (containerProgress) {
    return resolveContainerSteps(containerProgress, cliConnected);
  }

  // Standard flow — 3 simple steps
  return resolveStandardSteps(sessionState, cliConnected);
}

function resolveContainerSteps(
  progress: { step: string; message: string },
  cliConnected: boolean,
): LaunchStep[] {
  const order = ["checking_image", "pulling_image", "creating_container", "seeding_auth", "launching_agent"];
  const currentIdx = order.indexOf(progress.step);
  const steps: LaunchStep[] = order.map((stepId, i) => {
    let status: LaunchStep["status"] = "pending";
    if (i < currentIdx) status = "done";
    else if (i === currentIdx) status = "active";
    return { label: CONTAINER_STEP_LABELS[stepId] || stepId, status };
  });
  if (cliConnected) {
    // Mark all as done
    for (const s of steps) s.status = "done";
  }
  return steps;
}

function connectionStepStatus(spawning: boolean, connected: boolean): LaunchStep["status"] {
  if (connected) return "done";
  if (spawning) return "active";
  return "pending";
}

function resolveStandardSteps(sessionState: string | undefined, cliConnected: boolean): LaunchStep[] {
  const spawning = sessionState === "starting";
  const connected = cliConnected || sessionState === "connected" || sessionState === "running";

  return [
    { label: "Spawning process", status: (spawning || connected) ? "done" as const : "active" as const },
    { label: "Waiting for connection", status: connectionStepStatus(spawning, connected) },
    { label: "Ready", status: connected ? "done" as const : "pending" as const },
  ];
}

// ─── Auto-dismiss Hook ──────────────────────────────────────────────────────

function useAutoDismiss(allDone: boolean, delayMs = 2000): boolean {
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (allDone) {
      timerRef.current = setTimeout(() => setDismissed(true), delayMs);
    } else {
      setDismissed(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [allDone, delayMs]);

  return dismissed;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SessionLaunchProgress() {
  const sdkSessions = useStore((s) => s.sdkSessions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionCreating = useStore((s) => s.sessionCreating);
  const creationProgress = useStore((s) => s.creationProgress);
  const creationError = useStore((s) => s.creationError);
  const sessionNames = useStore((s) => s.sessionNames);

  // Find sessions currently in "starting" state (not yet connected)
  const launchingSessions = sdkSessions.filter(
    (s) => s.state === "starting" && !s.archived,
  );

  // Also consider container creation in progress
  const hasContainerCreation = sessionCreating && !creationError;
  const hasLaunching = launchingSessions.length > 0 || hasContainerCreation;

  // Pick the most recent launching session for display
  const latestLaunching = launchingSessions.length > 0
    ? launchingSessions[launchingSessions.length - 1]
    : null;

  const latestSessionId = latestLaunching?.sessionId;
  const latestName = latestSessionId ? sessionNames.get(latestSessionId) : null;
  const latestState = latestLaunching?.state;
  const latestConnected = latestSessionId ? (cliConnected.get(latestSessionId) ?? false) : false;

  // Resolve steps
  const steps = resolveSteps(
    latestState,
    hasContainerCreation ? creationProgress : null,
    latestConnected,
  );

  const allDone = steps.every((s) => s.status === "done");
  const dismissed = useAutoDismiss(allDone);

  // Don't render if nothing is launching or already dismissed
  if (!hasLaunching && !creationError) return null;
  if (dismissed && !creationError) return null;

  // Error state (container creation failed)
  if (creationError) {
    return (
      <div className="fixed bottom-4 left-4 z-40 w-72 rounded-xl border border-cc-error/30 bg-cc-card shadow-float animate-slide-up overflow-hidden">
        <div className="px-3 py-2.5 flex items-center gap-2">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error shrink-0" aria-hidden>
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium text-cc-error">Launch failed</p>
            <p className="text-[10px] text-cc-muted truncate">{creationError}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-4 left-4 z-40 w-64 rounded-xl border border-cc-border/60 bg-cc-card/95 backdrop-blur-xl shadow-float animate-slide-up overflow-hidden"
      style={{ transition: "opacity 0.4s ease-out", opacity: dismissed ? 0 : 1 }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-cc-border/30 flex items-center gap-2">
        {!allDone && (
          <svg className="w-3.5 h-3.5 text-cc-primary animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {allDone && (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success shrink-0" aria-hidden>
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        )}
        <span className="text-[11px] font-medium text-cc-fg truncate">
          {allDone ? "Session ready" : "Launching session"}
        </span>
        {latestName && (
          <span className="text-[9px] text-cc-muted font-mono-code truncate ml-auto">{latestName}</span>
        )}
      </div>

      {/* Steps */}
      <div className="px-3 py-2 space-y-1">
        {steps.map((step) => (
          <StepRow key={step.label} step={step} />
        ))}
      </div>

      {/* Progress bar for container pulls */}
      {creationProgress?.percent != null && (
        <div className="px-3 pb-2">
          <div className="w-full h-1 rounded-full bg-cc-hover overflow-hidden">
            <div
              className="h-full rounded-full bg-cc-primary transition-all duration-300"
              style={{ width: `${Math.min(100, creationProgress.percent)}%` }}
            />
          </div>
          <p className="text-[9px] text-cc-muted/60 font-mono-code mt-0.5 truncate">
            {creationProgress.message}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Step Row ───────────────────────────────────────────────────────────────

function stepTextClass(status: LaunchStep["status"]): string {
  if (status === "done") return "text-cc-muted/50";
  if (status === "active") return "text-cc-fg";
  return "text-cc-muted/40";
}

function StepRow({ step }: Readonly<{ step: LaunchStep }>) {
  return (
    <div className="flex items-center gap-2">
      {step.status === "done" && (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-success shrink-0" aria-hidden>
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
        </svg>
      )}
      {step.status === "active" && (
        <svg className="w-3 h-3 text-cc-primary animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M13 8a5 5 0 00-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {step.status === "pending" && (
        <svg className="w-3 h-3 text-cc-muted/30 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="4.5" />
        </svg>
      )}
      <span className={`text-[10px] ${
        stepTextClass(step.status)
      }`}>
        {step.label}
      </span>
    </div>
  );
}

import { useStore } from "../store.js";

const STEP_LABELS: Record<string, string> = {
  checking_image: "Checking image",
  pulling_image: "Pulling image",
  creating_container: "Creating container",
  seeding_auth: "Seeding authentication",
  launching_agent: "Launching agent",
};

const STEP_ORDER = [
  "checking_image",
  "pulling_image",
  "creating_container",
  "seeding_auth",
  "launching_agent",
];

export function SessionLaunchOverlay({ onRetry, onCancel }: { onRetry?: () => void; onCancel?: () => void }) {
  const sessionCreating = useStore((s) => s.sessionCreating);
  const progress = useStore((s) => s.creationProgress);
  const error = useStore((s) => s.creationError);

  if (!sessionCreating && !error) return null;

  const currentStepIndex = progress ? STEP_ORDER.indexOf(progress.step) : -1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        {error ? (
          <>
            <div className="mb-4 flex items-center gap-2 text-red-600 dark:text-red-400">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <h3 className="text-lg font-semibold">Container Launch Failed</h3>
            </div>
            <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">{error}</p>
            <div className="flex gap-2">
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Retry
                </button>
              )}
              {onCancel && (
                <button
                  onClick={onCancel}
                  className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Launching Container Session
            </h3>

            {/* Step list */}
            <div className="mb-4 space-y-2">
              {STEP_ORDER.map((step, i) => {
                const isCurrent = i === currentStepIndex;
                const isComplete = i < currentStepIndex;
                const isPending = i > currentStepIndex;

                return (
                  <div
                    key={step}
                    className={`flex items-center gap-2 text-sm ${
                      isCurrent
                        ? "font-medium text-blue-600 dark:text-blue-400"
                        : isComplete
                          ? "text-green-600 dark:text-green-400"
                          : "text-neutral-400 dark:text-neutral-600"
                    }`}
                  >
                    {isComplete ? (
                      <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : isCurrent ? (
                      <svg className="h-4 w-4 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <div className={`h-4 w-4 flex-shrink-0 rounded-full border ${isPending ? "border-neutral-300 dark:border-neutral-600" : ""}`} />
                    )}
                    <span>{STEP_LABELS[step] || step}</span>
                  </div>
                );
              })}
            </div>

            {/* Progress bar for image pull */}
            {progress?.step === "pulling_image" && progress.percent != null && (
              <div className="mb-3">
                <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${Math.min(progress.percent, 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-neutral-500">{progress.percent}%</p>
              </div>
            )}

            {/* Current step message */}
            {progress?.message && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                {progress.message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

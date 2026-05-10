import type { DetectedEnvironment } from "../types.js";

function statusForRule(rule: DetectedEnvironment["rules"][number]): string {
  if (rule.envMissing?.length) return "Missing env";
  if (rule.envPresent?.length) return "Configured";
  return "Detected";
}

export function EnvironmentPanel({ detected }: Readonly<{ detected?: DetectedEnvironment }>) {
  if (!detected || detected.rules.length === 0) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card overflow-hidden">
      <div className="px-3 py-2.5 border-b border-cc-border/40 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-cc-fg">Environment</span>
        <span className="text-[10px] text-cc-muted tabular-nums">{detected.rules.length}</span>
      </div>
      <div className="divide-y divide-cc-border/30">
        {detected.rules.map((rule) => (
          <div key={rule.id} className="px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-cc-fg truncate">{rule.name}</span>
              <span className="text-[9px] text-cc-muted uppercase font-mono-code shrink-0">
                {statusForRule(rule)}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-cc-muted/70 leading-snug">{rule.description}</p>
            {rule.envMissing?.length ? (
              <p className="mt-1 text-[10px] text-cc-warning font-mono-code truncate">
                Missing {rule.envMissing.join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

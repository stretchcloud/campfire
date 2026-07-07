import { useState } from "react";
import type { MemoryEnrichmentItem } from "../types.js";

/** Display name for a namespace: the class prefix ("repo:abc123" -> "repo"). */
function namespaceLabel(namespace: string): string {
  const idx = namespace.indexOf(":");
  return idx > 0 ? namespace.slice(0, idx) : namespace;
}

/** Kind icon: stacked layers for consolidated knowledge, a note dot for raw fragments. */
function KindIcon({ kind }: { kind: MemoryEnrichmentItem["kind"] }) {
  if (kind === "knowledge") {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary/60 shrink-0" aria-label="knowledge">
        <path d="M8 1L1 4.5 8 8l7-3.5L8 1zM1 8l7 3.5L15 8v1.5L8 13 1 9.5V8z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/50 shrink-0" aria-label="fragment">
      <path d="M3 2a1 1 0 011-1h5.5L13 4.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V2zm6.5 0v3H12L9.5 2z" />
    </svg>
  );
}

/** Subtle horizontal bar showing the decayed weight (0..1) of a recalled memory. */
function WeightBar({ weight }: { weight: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, weight)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={`decayed weight ${pct}%`}>
      <span className="w-10 h-1 rounded-full bg-cc-hover overflow-hidden inline-block">
        <span
          data-testid="weight-bar-fill"
          className="block h-full rounded-full bg-cc-primary/50"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-[9px] text-cc-muted/50 font-mono-code tabular-nums">{pct}%</span>
    </span>
  );
}

/**
 * Collapsible "recalled context" chip rendered with the user message that was
 * enriched by semantic memory (`memory_enriched` broadcast). Collapsed it is a
 * one-line summary; expanded it lists each recalled item with namespace badge,
 * tag, summary, kind icon, and a decayed-weight bar, plus a staleness hint.
 */
export function RecalledContextChip({
  items,
  truncated,
  defaultOpen = false,
}: {
  items: MemoryEnrichmentItem[];
  truncated?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;

  return (
    <div className="mt-1.5 rounded-lg border border-cc-border/60 bg-cc-card/50 overflow-hidden animate-[fadeSlideIn_0.15s_ease-out]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer hover:bg-cc-hover/50 transition-all duration-200"
      >
        {/* Memory/spark icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/40 shrink-0">
          <path d="M8 1a4 4 0 014 4c0 1.4-.7 2.6-1.8 3.3-.4.3-.7.7-.7 1.2v.5H6.5v-.5c0-.5-.3-.9-.7-1.2A4 4 0 018 1zM6.5 11.5h3V13a1 1 0 01-1 1h-1a1 1 0 01-1-1v-1.5z" />
        </svg>
        <span className="text-[11px] font-medium text-cc-muted/70 font-mono-code">
          Recalled {items.length} {items.length === 1 ? "memory" : "memories"}
        </span>
        {truncated && (
          <span className="rounded-full bg-cc-hover px-2 py-0.5 text-[9px] text-cc-muted/40 font-mono-code shrink-0">
            truncated
          </span>
        )}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 text-cc-muted/30 transition-transform duration-200 ml-auto shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-cc-border/40">
          <div className="px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-2">
                <span className="mt-0.5">
                  <KindIcon kind={item.kind} />
                </span>
                <span
                  className="rounded-full bg-cc-hover px-1.5 py-0.5 text-[9px] text-cc-muted/60 font-mono-code shrink-0"
                  title={item.namespace}
                >
                  {namespaceLabel(item.namespace)}
                </span>
                {item.tag && (
                  <span className="text-[10px] text-cc-primary/70 font-mono-code shrink-0">#{item.tag}</span>
                )}
                <span className="text-[11px] text-cc-muted leading-snug flex-1 min-w-0">{item.summary}</span>
                <span className="mt-0.5">
                  <WeightBar weight={item.weight} />
                </span>
              </div>
            ))}
          </div>
          <div className="px-3 pb-2 flex items-center gap-2">
            <span className="text-[9px] text-cc-muted/40 font-mono-code uppercase tracking-[0.1em]">
              auto-recalled — may be stale
            </span>
            {truncated && (
              <span className="text-[9px] text-cc-muted/40 font-mono-code">
                (some items omitted)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

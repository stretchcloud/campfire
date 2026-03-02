import { useEffect, useRef, useState, useId } from "react";

let mermaidInitialized = false;

async function getMermaid() {
  const m = await import("mermaid");
  if (!mermaidInitialized) {
    m.default.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "loose",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
    });
    mermaidInitialized = true;
  }
  return m.default;
}

export function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const uniqueId = useId().replace(/:/g, "-");

  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    (async () => {
      try {
        const mermaid = await getMermaid();
        const { svg } = await mermaid.render(`mermaid-${uniqueId}`, code.trim());
        if (!cancelled && el) {
          el.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to render diagram");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, uniqueId]);

  if (error) {
    return (
      <div className="my-2 rounded-md overflow-hidden border border-cc-border">
        <div className="px-3 py-1 bg-cc-code-bg border-b border-cc-border flex items-center justify-between">
          <span className="text-[9px] text-cc-error/60 font-mono-code uppercase tracking-[0.2em]">
            mermaid (render error)
          </span>
          <button
            onClick={() => setShowSource(!showSource)}
            className="text-[9px] text-cc-muted/50 hover:text-cc-muted font-mono-code transition-colors"
          >
            {showSource ? "hide source" : "show source"}
          </button>
        </div>
        {showSource && (
          <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-[1.6] overflow-x-auto">
            <code>{code}</code>
          </pre>
        )}
        {!showSource && (
          <div className="px-3 py-2 bg-cc-code-bg text-[11px] text-cc-error/70 font-mono-code">
            {error.slice(0, 200)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-md overflow-hidden border border-cc-border">
      <div className="px-3 py-1 bg-cc-code-bg border-b border-cc-border flex items-center justify-between">
        <span className="text-[9px] text-cc-code-fg/40 font-mono-code uppercase tracking-[0.2em]">
          mermaid
        </span>
        <button
          onClick={() => setShowSource(!showSource)}
          className="text-[9px] text-cc-muted/50 hover:text-cc-muted font-mono-code transition-colors"
        >
          {showSource ? "diagram" : "source"}
        </button>
      </div>
      {showSource ? (
        <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-[1.6] overflow-x-auto">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          ref={containerRef}
          className="px-3 py-3 bg-white dark:bg-zinc-900 flex items-center justify-center overflow-x-auto [&_svg]:max-w-full"
        />
      )}
    </div>
  );
}

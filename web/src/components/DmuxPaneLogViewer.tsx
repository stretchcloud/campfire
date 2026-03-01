import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { sendDmuxStreamPane, sendDmuxStopStreamPane } from "../dmux-ws.js";

interface DmuxPaneLogViewerProps {
  /** The tmux target to stream, e.g. "dmux-abc:0.1" */
  tmuxTarget: string;
  /** Called when the viewer is closed */
  onClose: () => void;
  /** Register to receive pane output from the parent dmux-ws connection */
  registerOutputHandler: (handler: (tmuxTarget: string, data: string, isHistory?: boolean) => void) => void;
  /** Unregister the output handler */
  unregisterOutputHandler: () => void;
}

export function DmuxPaneLogViewer({
  tmuxTarget,
  onClose,
  registerOutputHandler,
  unregisterOutputHandler,
}: DmuxPaneLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#0a0a0f",
        foreground: "#e0e0e0",
      },
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register output handler
    const handler = (target: string, data: string) => {
      if (target === tmuxTarget) {
        term.write(data);
      }
    };
    registerOutputHandler(handler);

    // Start streaming
    sendDmuxStreamPane(tmuxTarget);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore resize errors
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      sendDmuxStopStreamPane(tmuxTarget);
      unregisterOutputHandler();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tmuxTarget, registerOutputHandler, unregisterOutputHandler]);

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f] border-l border-cc-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cc-border bg-cc-card shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-cc-fg">Pane Log</span>
          <code className="text-xs text-cc-muted truncate">{tmuxTarget}</code>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-0.5 text-xs rounded border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
        >
          Close
        </button>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}

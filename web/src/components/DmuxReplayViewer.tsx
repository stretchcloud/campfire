import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api.js";
import type { DmuxRecordingData } from "../api.js";

type DmuxRecordingEntry = DmuxRecordingData["entries"][number];

interface DmuxReplayViewerProps {
  filename: string;
}

const SPEED_OPTIONS = [1, 2, 4, 8];

export function DmuxReplayViewer({ filename }: DmuxReplayViewerProps) {
  const [recording, setRecording] = useState<DmuxRecordingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  const terminalsRef = useRef<Map<string, Terminal>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);

  // Load recording
  useEffect(() => {
    api.getDmuxRecording(filename)
      .then((data) => setRecording(data))
      .catch((err) => setError(err.message || "Failed to load recording"))
      .finally(() => setLoading(false));
  }, [filename]);

  const totalDuration = recording?.entries.length
    ? recording.entries[recording.entries.length - 1].ts - recording.entries[0].ts
    : 0;

  const panes = recording?.header.panes || [];

  // Initialize terminals for each pane
  const termContainersRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const setTermContainer = useCallback((pane: string, el: HTMLDivElement | null) => {
    if (el) {
      termContainersRef.current.set(pane, el);
    } else {
      termContainersRef.current.delete(pane);
    }
  }, []);

  // Create terminals when recording loads
  useEffect(() => {
    if (!recording) return;

    // Small delay to allow DOM to mount
    const timer = setTimeout(() => {
      for (const pane of recording.header.panes) {
        const container = termContainersRef.current.get(pane);
        if (!container || terminalsRef.current.has(pane)) continue;

        const term = new Terminal({
          cursorBlink: false,
          disableStdin: true,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          theme: { background: "#0a0a0f", foreground: "#e0e0e0" },
          scrollback: 5000,
          convertEol: true,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        terminalsRef.current.set(pane, term);
        fitAddonsRef.current.set(pane, fitAddon);
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      for (const term of terminalsRef.current.values()) {
        term.dispose();
      }
      terminalsRef.current.clear();
      fitAddonsRef.current.clear();
    };
  }, [recording]);

  // Playback logic
  const scheduleNext = useCallback(
    (entries: DmuxRecordingEntry[], index: number, baseTs: number, speedMul: number) => {
      if (index >= entries.length) {
        setPlaying(false);
        return;
      }

      const entry = entries[index];
      const delay = index === 0 ? 0 : (entry.ts - entries[index - 1].ts) / speedMul;

      timerRef.current = setTimeout(() => {
        // Write to the correct terminal
        const term = terminalsRef.current.get(entry.tmuxTarget);
        if (term) {
          term.write(entry.data);
        }

        const newElapsed = entry.ts - baseTs;
        setElapsed(newElapsed);
        setCurrentIndex(index + 1);

        scheduleNext(entries, index + 1, baseTs, speedMul);
      }, Math.min(delay, 2000)); // Cap individual delay at 2s to prevent long waits
    },
    [],
  );

  const handlePlay = useCallback(() => {
    if (!recording || recording.entries.length === 0) return;

    setPlaying(true);
    startTimeRef.current = recording.entries[0].ts;
    scheduleNext(recording.entries, currentIndex, recording.entries[0].ts, speed);
  }, [recording, currentIndex, speed, scheduleNext]);

  const handlePause = useCallback(() => {
    setPlaying(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleRestart = useCallback(() => {
    handlePause();
    setCurrentIndex(0);
    setElapsed(0);
    // Clear all terminals
    for (const term of terminalsRef.current.values()) {
      term.clear();
    }
  }, [handlePause]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Update speed during playback
  useEffect(() => {
    if (playing && recording) {
      handlePause();
      setPlaying(true);
      scheduleNext(recording.entries, currentIndex, recording.entries[0].ts, speed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  const formatTime = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-cc-bg">
        <p className="text-sm text-cc-muted">Loading recording...</p>
      </div>
    );
  }

  if (error || !recording) {
    return (
      <div className="h-full flex items-center justify-center bg-cc-bg">
        <div className="text-center">
          <p className="text-sm text-red-400">{error || "Recording not found"}</p>
          <a href="#/dmux" className="text-xs text-cc-primary hover:underline mt-2 inline-block">
            Back to dmux
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-cc-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cc-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <a href="#/dmux" className="text-xs text-cc-muted hover:text-cc-fg transition-colors">
            dmux
          </a>
          <span className="text-cc-muted">/</span>
          <span className="text-sm font-medium text-cc-fg">Replay</span>
          <code className="text-xs text-cc-muted truncate">{recording.header.sessionName}</code>
        </div>
        <div className="text-xs text-cc-muted">
          {new Date(recording.header.startedAt).toLocaleString()}
        </div>
      </div>

      {/* Pane grid */}
      <div
        className="flex-1 min-h-0 grid gap-1 p-1"
        style={{
          gridTemplateColumns: panes.length <= 2 ? `repeat(${panes.length}, 1fr)` : "repeat(2, 1fr)",
          gridTemplateRows: panes.length <= 2 ? "1fr" : `repeat(${Math.ceil(panes.length / 2)}, 1fr)`,
        }}
      >
        {panes.map((pane) => (
          <div key={pane} className="flex flex-col min-h-0 border border-cc-border rounded">
            <div className="px-2 py-1 text-xs font-mono text-cc-muted bg-cc-card border-b border-cc-border shrink-0">
              {pane}
            </div>
            <div
              ref={(el) => setTermContainer(pane, el)}
              className="flex-1 min-h-0"
            />
          </div>
        ))}
      </div>

      {/* Playback controls */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-cc-border shrink-0 bg-cc-card">
        {/* Play/Pause/Restart */}
        <div className="flex items-center gap-1">
          {playing ? (
            <button
              type="button"
              onClick={handlePause}
              className="px-2 py-1 text-xs font-medium rounded border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePlay}
              className="px-2 py-1 text-xs font-medium rounded bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            >
              Play
            </button>
          )}
          <button
            type="button"
            onClick={handleRestart}
            className="px-2 py-1 text-xs font-medium rounded border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
          >
            Restart
          </button>
        </div>

        {/* Speed selector */}
        <div className="flex items-center gap-1">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`px-1.5 py-0.5 text-xs rounded cursor-pointer ${
                speed === s
                  ? "bg-cc-primary text-white"
                  : "text-cc-muted hover:text-cc-fg border border-cc-border hover:bg-cc-card-hover"
              } transition-colors`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Timeline / scrubber */}
        <div className="flex-1 flex items-center gap-2">
          <span className="text-xs font-mono text-cc-muted w-10 text-right">{formatTime(elapsed)}</span>
          <div className="flex-1 h-1 bg-cc-border rounded-full overflow-hidden">
            <div
              className="h-full bg-cc-primary rounded-full transition-all"
              style={{ width: totalDuration > 0 ? `${(elapsed / totalDuration) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-xs font-mono text-cc-muted w-10">{formatTime(totalDuration)}</span>
        </div>

        {/* Entry counter */}
        <span className="text-xs text-cc-muted">
          {currentIndex}/{recording.entries.length}
        </span>
      </div>
    </div>
  );
}

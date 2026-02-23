import { useRef, useCallback } from "react";

export interface CostCardProps {
  sessionName: string;
  cost: number;
  turns: number;
  durationMs: number;
  model: string;
  backend: string;
  linesAdded: number;
  linesRemoved: number;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "< 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * CostCard renders a shareable session summary card with key metrics.
 * Includes a "Download PNG" button that renders the card to a canvas.
 */
export function CostCard({
  sessionName,
  cost,
  turns,
  durationMs,
  model,
  backend,
  linesAdded,
  linesRemoved,
}: CostCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const downloadPng = useCallback(() => {
    const canvas = document.createElement("canvas");
    const w = 600;
    const h = 320;
    canvas.width = w * 2; // 2x for retina
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);

    // Background
    ctx.fillStyle = "#1a1b26";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 16);
    ctx.fill();

    // Subtle border
    ctx.strokeStyle = "#2a2b3d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 16);
    ctx.stroke();

    // Title
    ctx.fillStyle = "#c0caf5";
    ctx.font = "bold 18px system-ui, -apple-system, sans-serif";
    ctx.fillText(sessionName.length > 40 ? sessionName.slice(0, 40) + "..." : sessionName, 32, 48);

    // Subtitle: model + backend
    ctx.fillStyle = "#565f89";
    ctx.font = "13px system-ui, -apple-system, sans-serif";
    ctx.fillText(`${model} / ${backend}`, 32, 72);

    // Divider
    ctx.strokeStyle = "#2a2b3d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, 88);
    ctx.lineTo(w - 32, 88);
    ctx.stroke();

    // Stats grid
    const stats = [
      { label: "Cost", value: formatCost(cost) },
      { label: "Duration", value: formatDuration(durationMs) },
      { label: "Turns", value: String(turns) },
      { label: "Lines", value: `+${linesAdded} / -${linesRemoved}` },
    ];

    const colW = (w - 64) / 2;
    stats.forEach((stat, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 32 + col * colW;
      const y = 118 + row * 72;

      ctx.fillStyle = "#565f89";
      ctx.font = "11px system-ui, -apple-system, sans-serif";
      ctx.fillText(stat.label.toUpperCase(), x, y);

      ctx.fillStyle = "#c0caf5";
      ctx.font = "bold 28px system-ui, -apple-system, sans-serif";
      ctx.fillText(stat.value, x, y + 32);
    });

    // Watermark
    ctx.fillStyle = "#3b3d57";
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillText("Campfire", w - 80, h - 20);

    // Download
    const link = document.createElement("a");
    link.download = `campfire-${sessionName.replace(/\s+/g, "-").toLowerCase()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, [sessionName, cost, turns, durationMs, model, backend, linesAdded, linesRemoved]);

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-3">
      <span className="text-[11px] text-cc-muted uppercase tracking-wider">Session Summary</span>

      {/* Visual card preview */}
      <div
        ref={cardRef}
        className="rounded-xl p-5 space-y-3"
        style={{ background: "#1a1b26" }}
      >
        <div>
          <p className="text-[14px] font-bold text-[#c0caf5] truncate">{sessionName}</p>
          <p className="text-[11px] text-[#565f89]">{model} / {backend}</p>
        </div>
        <div className="border-t border-[#2a2b3d]" />
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <div>
            <p className="text-[9px] text-[#565f89] uppercase tracking-wider">Cost</p>
            <p className="text-[18px] font-bold text-[#c0caf5] tabular-nums">{formatCost(cost)}</p>
          </div>
          <div>
            <p className="text-[9px] text-[#565f89] uppercase tracking-wider">Duration</p>
            <p className="text-[18px] font-bold text-[#c0caf5]">{formatDuration(durationMs)}</p>
          </div>
          <div>
            <p className="text-[9px] text-[#565f89] uppercase tracking-wider">Turns</p>
            <p className="text-[18px] font-bold text-[#c0caf5] tabular-nums">{turns}</p>
          </div>
          <div>
            <p className="text-[9px] text-[#565f89] uppercase tracking-wider">Lines</p>
            <p className="text-[18px] font-bold tabular-nums">
              <span className="text-green-400">+{linesAdded}</span>
              <span className="text-[#565f89]"> / </span>
              <span className="text-red-400">-{linesRemoved}</span>
            </p>
          </div>
        </div>
        <div className="text-right">
          <span className="text-[9px] text-[#3b3d57]">Campfire</span>
        </div>
      </div>

      {/* Actions */}
      <button
        onClick={downloadPng}
        className="w-full text-[11px] font-medium py-1.5 rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg transition-colors cursor-pointer"
      >
        Download PNG
      </button>
    </div>
  );
}

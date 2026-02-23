import { useState, useEffect } from "react";
import { api, type GalleryEntryInfo } from "../api.js";

interface Props {
  embedded?: boolean;
}

interface AgentProfile {
  key: string; // backendType/model
  backendType: string;
  model: string;
  entries: GalleryEntryInfo[];
  totalSessions: number;
  totalCost: number;
  totalVotes: number;
  avgDuration: number;
  featuredCount: number;
}

const BACKEND_COLORS: Record<string, string> = {
  claude: "text-[#5BA8A0] bg-[#5BA8A0]/10 border-[#5BA8A0]/20",
  codex: "text-blue-500 bg-blue-500/10 border-blue-500/20",
  goose: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  aider: "text-purple-500 bg-purple-500/10 border-purple-500/20",
  openhands: "text-rose-500 bg-rose-500/10 border-rose-500/20",
  openclaw: "text-orange-500 bg-orange-500/10 border-orange-500/20",
};

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function buildProfiles(entries: GalleryEntryInfo[]): AgentProfile[] {
  const groups = new Map<string, GalleryEntryInfo[]>();

  for (const entry of entries) {
    const key = `${entry.backendType}/${entry.model}`;
    const list = groups.get(key) || [];
    list.push(entry);
    groups.set(key, list);
  }

  const profiles: AgentProfile[] = [];
  for (const [key, groupEntries] of groups) {
    const [backendType, ...modelParts] = key.split("/");
    const model = modelParts.join("/");
    profiles.push({
      key,
      backendType,
      model,
      entries: groupEntries.sort((a, b) => b.votes - a.votes),
      totalSessions: groupEntries.length,
      totalCost: groupEntries.reduce((sum, e) => sum + e.totalCostUsd, 0),
      totalVotes: groupEntries.reduce((sum, e) => sum + e.votes, 0),
      avgDuration: groupEntries.reduce((sum, e) => sum + e.durationMs, 0) / groupEntries.length,
      featuredCount: groupEntries.filter((e) => e.featured).length,
    });
  }

  // Sort by total votes descending
  profiles.sort((a, b) => b.totalVotes - a.totalVotes);
  return profiles;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentProfilesPage({ embedded = false }: Props) {
  const [entries, setEntries] = useState<GalleryEntryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);

  useEffect(() => {
    api.listGalleryEntries()
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const profiles = buildProfiles(entries);

  const content = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading agent profiles...</div>
  ) : profiles.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No agent profiles yet. Add sessions to the Gallery to see agent profiles here.
    </div>
  ) : (
    <div className="space-y-4">
      {profiles.map((profile) => {
        const colors = BACKEND_COLORS[profile.backendType] || "text-cc-muted bg-cc-hover border-cc-border";
        const isExpanded = expandedProfile === profile.key;

        return (
          <div key={profile.key} className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            {/* Profile header */}
            <button
              onClick={() => setExpandedProfile(isExpanded ? null : profile.key)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-cc-hover transition-colors cursor-pointer"
            >
              {/* Agent icon */}
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold border ${colors}`}>
                {profile.backendType[0].toUpperCase()}
              </div>

              {/* Agent info */}
              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colors}`}>
                    {profile.backendType}
                  </span>
                  <span className="text-sm text-cc-fg font-medium truncate">{profile.model}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-cc-muted">
                  <span>{profile.totalSessions} sessions</span>
                  <span>{formatCost(profile.totalCost)} total cost</span>
                  <span>{profile.totalVotes} votes</span>
                  <span>avg {formatDuration(profile.avgDuration)}</span>
                  {profile.featuredCount > 0 && (
                    <span className="text-amber-500">{profile.featuredCount} featured</span>
                  )}
                </div>
              </div>

              {/* Expand chevron */}
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`w-4 h-4 text-cc-muted transition-transform ${isExpanded ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Expanded session list */}
            {isExpanded && (
              <div className="border-t border-cc-border">
                {profile.entries.map((entry) => (
                  <a
                    key={entry.id}
                    href={`#/replay/session/${entry.sessionId}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-cc-hover transition-colors border-b border-cc-border last:border-b-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {entry.featured && (
                          <span className="text-amber-500">
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                              <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
                            </svg>
                          </span>
                        )}
                        <span className="text-sm text-cc-fg truncate">{entry.name}</span>
                      </div>
                      {entry.description && (
                        <p className="text-[10px] text-cc-muted truncate mt-0.5">{entry.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-cc-muted shrink-0">
                      {entry.totalCostUsd > 0 && <span>{formatCost(entry.totalCostUsd)}</span>}
                      {entry.numTurns > 0 && <span>{entry.numTurns}t</span>}
                      <span className={entry.votes > 0 ? "text-cc-primary font-semibold" : ""}>
                        {entry.votes > 0 ? `+${entry.votes}` : entry.votes}
                      </span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary">
                        <path d="M4.5 3.5A.5.5 0 015.22 3l7 4.5a.5.5 0 010 .86l-7 4.5A.5.5 0 014.5 12.5v-9z" />
                      </svg>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ─── Layout ────────────────────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Agent Profiles</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Gallery sessions grouped by agent backend and model. Each profile shows total sessions, cost, and votes.
            </p>
          </div>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-cc-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <h1 className="text-xl font-semibold text-cc-fg mb-6">Agent Profiles</h1>
        {content}
      </div>
    </div>
  );
}

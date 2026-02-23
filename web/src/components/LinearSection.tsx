import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { name: string };
  team: { id: string; key: string; name: string };
}

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

interface ProjectMapping {
  teamId: string;
  teamKey: string;
  teamName: string;
  repoRoot: string;
}

interface LinearSectionProps {
  cwd: string;
  repoRoot: string;
  onIssueSelected?: (issue: LinearIssue) => void;
  onBranchFromIssue?: (branchName: string) => void;
}

export function LinearSection({
  cwd,
  repoRoot,
  onIssueSelected,
  onBranchFromIssue,
}: LinearSectionProps) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [mapping, setMapping] = useState<ProjectMapping | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null);
  const [showTeamPicker, setShowTeamPicker] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if Linear is connected
  useEffect(() => {
    api.getLinearConnection().then((res) => {
      setConnected(res.connected);
      if (res.teams) setTeams(res.teams);
    }).catch(() => setConnected(false));
  }, []);

  // Load existing project mapping
  useEffect(() => {
    if (!repoRoot || !connected) return;
    api.getLinearProjectMapping(repoRoot).then((res) => {
      if (res.mapping) {
        setMapping(res.mapping as ProjectMapping);
      }
    }).catch(() => {});
  }, [repoRoot, connected]);

  // Debounced issue search
  const searchIssues = useCallback((query: string) => {
    if (!query.trim()) {
      setIssues([]);
      return;
    }
    setSearching(true);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      // Prefix search with team key if we have a mapping
      const searchPrefix = mapping?.teamKey ? `team:${mapping.teamKey} ` : "";
      api.searchLinearIssues(searchPrefix + query, 10).then((res) => {
        setIssues(res.issues as LinearIssue[]);
      }).catch(() => {
        setIssues([]);
      }).finally(() => setSearching(false));
    }, 300);
  }, [mapping]);

  const handleSelectIssue = useCallback((issue: LinearIssue) => {
    setSelectedIssue(issue);
    setSearchQuery("");
    setIssues([]);
    onIssueSelected?.(issue);
    // Generate branch name from issue identifier
    const branch = `${issue.identifier.toLowerCase()}/${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
    onBranchFromIssue?.(branch);
  }, [onIssueSelected, onBranchFromIssue]);

  const handleLinkTeam = useCallback(async (team: LinearTeam) => {
    try {
      await api.setLinearProjectMapping({
        repoRoot,
        teamId: team.id,
        teamKey: team.key,
        teamName: team.name,
      });
      setMapping({ teamId: team.id, teamKey: team.key, teamName: team.name, repoRoot });
      setShowTeamPicker(false);
    } catch {
      // Silently fail
    }
  }, [repoRoot]);

  // Don't render if not connected
  if (connected === false || connected === null) return null;
  if (!repoRoot) return null;

  return (
    <div className="space-y-2">
      {/* Team mapping header */}
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-indigo-400 shrink-0" fill="currentColor">
          <path d="M1 3a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V3zm2-.5a.5.5 0 00-.5.5v10a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V3a.5.5 0 00-.5-.5H3z" />
          <path d="M4 5.75a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5A.75.75 0 014 5.75zm0 4a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 9.75z" />
        </svg>
        <span className="text-xs text-cc-muted font-medium">Linear</span>
        {mapping ? (
          <span className="text-xs text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded-full font-medium">
            {mapping.teamKey}
          </span>
        ) : (
          <button
            onClick={() => setShowTeamPicker(!showTeamPicker)}
            className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            Link team...
          </button>
        )}
      </div>

      {/* Team picker dropdown */}
      {showTeamPicker && !mapping && (
        <div className="bg-cc-card border border-cc-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs text-cc-muted border-b border-cc-border">
            Select a Linear team for this repository
          </div>
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => handleLinkTeam(team)}
              className="w-full px-3 py-2 text-left text-xs hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2"
            >
              <span className="font-medium text-cc-fg">{team.key}</span>
              <span className="text-cc-muted">{team.name}</span>
            </button>
          ))}
          {teams.length === 0 && (
            <div className="px-3 py-2 text-xs text-cc-muted">No teams found</div>
          )}
        </div>
      )}

      {/* Issue search */}
      {mapping && (
        <div className="relative">
          <input
            type="text"
            placeholder={`Search ${mapping.teamKey} issues...`}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              searchIssues(e.target.value);
            }}
            className="w-full px-3 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 outline-none focus:border-indigo-500/50 transition-colors"
          />
          {searching && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <svg className="w-3 h-3 text-cc-muted animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
              </svg>
            </div>
          )}

          {/* Issue results */}
          {issues.length > 0 && (
            <div className="absolute z-50 mt-1 w-full bg-cc-card border border-cc-border rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
              {issues.map((issue) => (
                <button
                  key={issue.id}
                  onClick={() => handleSelectIssue(issue)}
                  className="w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer border-b border-cc-border last:border-b-0"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-indigo-400 shrink-0">{issue.identifier}</span>
                    <span className="text-xs text-cc-fg truncate">{issue.title}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-cc-muted">{issue.state.name}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Selected issue */}
      {selectedIssue && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
          <span className="text-[10px] font-mono text-indigo-400">{selectedIssue.identifier}</span>
          <span className="text-xs text-cc-fg truncate flex-1">{selectedIssue.title}</span>
          <button
            onClick={() => {
              setSelectedIssue(null);
              onIssueSelected?.(undefined as unknown as LinearIssue);
            }}
            className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

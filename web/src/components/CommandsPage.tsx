import { useState, useEffect, useCallback } from "react";
import { api, type DiscoveredCommand, type DiscoveredSkill } from "../api.js";
import { useStore } from "../store.js";

/**
 * CommandsPage — browse all available slash commands and skills.
 *
 * Shows user-level and project-level commands with descriptions,
 * source badges, and expandable content preview.
 */

// Static fallback descriptions for known built-in commands
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  help: "Show available commands and keyboard shortcuts",
  clear: "Clear conversation history and start fresh",
  compact: "Compact conversation to save context window space",
  cost: "Show token usage and cost for this session",
  doctor: "Check health of Claude Code installation",
  init: "Initialize a new CLAUDE.md project file",
  login: "Switch accounts or re-authenticate",
  logout: "Sign out of current account",
  memory: "View and edit CLAUDE.md memory files",
  model: "Switch the AI model for this session",
  permissions: "View and manage tool permissions",
  review: "Review recent changes made by Claude",
  status: "Show session status, model, and connection info",
  "terminal-setup": "Configure terminal integration (Shift+Enter)",
  vim: "Toggle vim keybindings mode",
};


export function CommandsPage({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const [commands, setCommands] = useState<DiscoveredCommand[]>([]);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);

  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);

  // Get cwd from current session for project-level discovery
  const cwd = currentSessionId
    ? (sessions.get(currentSessionId)?.cwd || sdkSessions.find((s) => s.sessionId === currentSessionId)?.cwd)
    : undefined;

  const refresh = useCallback(() => {
    api.discoverCommands(cwd)
      .then((r) => { setCommands(r.commands); setSkills(r.skills); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleExpand(path: string) {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    setContentLoading(true);
    try {
      const res = await api.readCommand(path);
      setExpandedContent(res.content);
    } catch {
      setExpandedContent("Failed to read file");
    }
    setContentLoading(false);
  }

  const q = filter.toLowerCase();
  const filteredCommands = q
    ? commands.filter((c) => c.name.includes(q) || c.description.toLowerCase().includes(q))
    : commands;
  const filteredSkills = q
    ? skills.filter((s) => s.slug.includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    : skills;
  // Dynamic built-in commands from CLI (fetched via API)
  const [builtinCommands, setBuiltinCommands] = useState<Array<{ name: string; description: string }>>([]);
  useEffect(() => {
    api.getSlashCommands().then((r) => {
      setBuiltinCommands(r.commands.map((name) => ({
        name,
        description: BUILTIN_DESCRIPTIONS[name] || "",
      })));
    }).catch(() => {});
  }, []);

  const filteredBuiltins = q
    ? builtinCommands.filter((c) => c.name.includes(q) || c.description.toLowerCase().includes(q))
    : builtinCommands;

  const total = filteredCommands.length + filteredSkills.length + filteredBuiltins.length;

  return (
    <div className={embedded ? "px-4 py-6 max-w-4xl mx-auto" : "p-6 max-w-4xl mx-auto"}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-cc-fg">Commands & Skills</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">
            Slash commands from <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">~/.claude/commands/</code> and skills from <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">~/.claude/skills/</code>
          </p>
        </div>
        <button onClick={refresh} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer">
          Refresh
        </button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search commands and skills..."
          className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg placeholder:text-cc-muted/30 focus:outline-none focus:ring-2 focus:ring-cc-primary/20"
        />
      </div>

      {loading && <p className="text-cc-muted text-sm">Discovering commands...</p>}

      {!loading && total === 0 && (
        <div className="text-center py-12 text-cc-muted">
          <p className="text-sm">No commands or skills found</p>
          <p className="text-xs mt-1">Create <code className="font-mono-code bg-cc-hover px-1 rounded">~/.claude/commands/my-command.md</code> to add a slash command</p>
        </div>
      )}

      {/* Built-in Commands */}
      {filteredBuiltins.length > 0 && (
        <div className="mb-6">
          <h2 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2">
            Built-in Commands <span className="text-cc-muted/50 tabular-nums ml-1">{filteredBuiltins.length}</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {filteredBuiltins.map((cmd) => (
              <div key={cmd.name} className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-cc-border bg-cc-card">
                <span className="w-7 h-7 rounded-md bg-cc-muted/10 text-cc-muted flex items-center justify-center text-[13px] font-bold shrink-0">/</span>
                <div className="flex-1 min-w-0">
                  <span className="text-[12px] font-medium text-cc-fg font-mono-code">/{cmd.name}</span>
                  <p className="text-[10px] text-cc-muted truncate">{cmd.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom Slash Commands */}
      {filteredCommands.length > 0 && (
        <div className="mb-6">
          <h2 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2">
            Custom Commands <span className="text-cc-muted/50 tabular-nums ml-1">{filteredCommands.length}</span>
          </h2>
          <div className="space-y-1.5">
            {filteredCommands.map((cmd) => (
              <div key={cmd.path}>
                <button
                  onClick={() => handleExpand(cmd.path)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                    expandedPath === cmd.path
                      ? "border-cc-primary/30 bg-cc-primary/[0.03]"
                      : "border-cc-border bg-cc-card hover:shadow-panel"
                  }`}
                >
                  {/* Slash icon */}
                  <span className="w-7 h-7 rounded-md bg-cc-primary/10 text-cc-primary flex items-center justify-center text-[13px] font-bold shrink-0">/</span>
                  {/* Name + description */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-cc-fg font-mono-code">/{cmd.name}</span>
                      <span className={`text-[8px] font-semibold px-1.5 rounded-full ${
                        cmd.source === "project" ? "text-amber-500 bg-amber-500/10" : "text-cc-muted bg-cc-hover"
                      }`}>
                        {cmd.source}
                      </span>
                    </div>
                    {cmd.description && (
                      <p className="text-[11px] text-cc-muted truncate mt-0.5">{cmd.description}</p>
                    )}
                  </div>
                  {/* Expand chevron */}
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted/40 transition-transform duration-150 shrink-0 ${expandedPath === cmd.path ? "rotate-90" : ""}`} aria-hidden>
                    <path d="M6 4l4 4-4 4V4z" />
                  </svg>
                </button>
                {/* Expanded content */}
                {expandedPath === cmd.path && (
                  <div className="ml-10 mt-1 mb-2">
                    {contentLoading ? (
                      <p className="text-[11px] text-cc-muted py-2">Loading...</p>
                    ) : (
                      <pre className="text-[11px] text-cc-code-fg bg-cc-code-bg rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto font-mono-code leading-relaxed">{expandedContent}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skills */}
      {filteredSkills.length > 0 && (
        <div>
          <h2 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2">
            Skills <span className="text-cc-muted/50 tabular-nums ml-1">{filteredSkills.length}</span>
          </h2>
          <div className="space-y-1.5">
            {filteredSkills.map((skill) => (
              <div key={skill.path}>
                <button
                  onClick={() => handleExpand(skill.path)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                    expandedPath === skill.path
                      ? "border-cc-primary/30 bg-cc-primary/[0.03]"
                      : "border-cc-border bg-cc-card hover:shadow-panel"
                  }`}
                >
                  {/* Skill icon */}
                  <span className="w-7 h-7 rounded-md bg-cc-success/10 text-cc-success flex items-center justify-center shrink-0">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
                      <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754z" />
                    </svg>
                  </span>
                  {/* Name + description */}
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-cc-fg">{skill.name}</span>
                    {skill.description && (
                      <p className="text-[11px] text-cc-muted truncate mt-0.5">{skill.description}</p>
                    )}
                  </div>
                  <span className="text-[9px] font-mono-code text-cc-muted/40 shrink-0">{skill.slug}</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted/40 transition-transform duration-150 shrink-0 ${expandedPath === skill.path ? "rotate-90" : ""}`} aria-hidden>
                    <path d="M6 4l4 4-4 4V4z" />
                  </svg>
                </button>
                {expandedPath === skill.path && (
                  <div className="ml-10 mt-1 mb-2">
                    {contentLoading ? (
                      <p className="text-[11px] text-cc-muted py-2">Loading...</p>
                    ) : (
                      <pre className="text-[11px] text-cc-code-fg bg-cc-code-bg rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto font-mono-code leading-relaxed">{expandedContent}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

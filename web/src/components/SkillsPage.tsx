import { useState, useEffect } from "react";
import { api, type PluginInfo } from "../api.js";

export function SkillsPage({ embedded }: { embedded?: boolean }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    loadPlugins();
  }, []);

  async function loadPlugins() {
    setLoading(true);
    setError("");
    try {
      const data = await api.listPlugins();
      setPlugins(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(plugin: PluginInfo) {
    setToggling(plugin.id);
    try {
      const result = await api.togglePlugin(plugin.id, !plugin.disabledInCampfire);
      setPlugins((prev) =>
        prev.map((p) =>
          p.id === plugin.id ? { ...p, disabledInCampfire: result.disabled } : p,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle plugin");
    } finally {
      setToggling(null);
    }
  }

  async function viewSkillContent(pluginId: string, skillName: string) {
    const key = `${pluginId}:${skillName}`;
    if (skillContent[key]) return; // Already loaded
    try {
      const { content } = await api.readSkillContent(pluginId, skillName);
      setSkillContent((prev) => ({ ...prev, [key]: content }));
    } catch {
      setSkillContent((prev) => ({ ...prev, [key]: "Failed to load skill content." }));
    }
  }

  const totalSkills = plugins.reduce((sum, p) => sum + p.skills.length, 0);
  const totalCommands = plugins.reduce((sum, p) => sum + p.commands.length, 0);

  return (
    <div className={`h-full flex flex-col ${embedded ? "" : ""}`}>
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-cc-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-cc-fg">Skills & Plugins</h2>
            <p className="text-[11px] text-cc-muted mt-0.5">
              {plugins.length} plugin{plugins.length !== 1 ? "s" : ""} installed
              {totalSkills > 0 && ` · ${totalSkills} skill${totalSkills !== 1 ? "s" : ""}`}
              {totalCommands > 0 && ` · ${totalCommands} command${totalCommands !== 1 ? "s" : ""}`}
            </p>
          </div>
          <button
            onClick={loadPlugins}
            disabled={loading}
            className="px-2.5 py-1 text-[11px] font-mono-code text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        {loading && plugins.length === 0 && (
          <div className="flex items-center justify-center py-12 text-cc-muted text-xs">
            <span className="w-4 h-4 border-2 border-cc-muted/30 border-t-cc-muted rounded-full animate-spin mr-2" />
            Loading plugins...
          </div>
        )}

        {!loading && plugins.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-12 text-cc-muted">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-8 h-8 opacity-30 mb-2">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <p className="text-xs">No plugins installed.</p>
            <p className="text-[11px] mt-1 opacity-70">
              Install plugins via <code className="font-mono-code bg-cc-hover px-1 rounded">/install-plugin</code> in Claude Code.
            </p>
          </div>
        )}

        {plugins.map((plugin) => (
          <div
            key={plugin.id}
            className={`rounded-lg border transition-colors ${
              plugin.blocked
                ? "border-cc-error/20 bg-cc-error/5"
                : plugin.disabledInCampfire
                  ? "border-cc-border bg-cc-hover/50 opacity-60"
                  : "border-cc-border bg-cc-card"
            }`}
          >
            {/* Plugin header */}
            <div className="px-3 py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)}
                    className="text-xs font-medium text-cc-fg hover:text-cc-primary transition-colors cursor-pointer truncate"
                  >
                    {plugin.name}
                  </button>
                  <span className="text-[10px] font-mono-code text-cc-muted bg-cc-hover px-1.5 py-0.5 rounded shrink-0">
                    {plugin.marketplace}
                  </span>
                  {plugin.blocked && (
                    <span className="text-[10px] font-mono-code text-cc-error bg-cc-error/10 px-1.5 py-0.5 rounded shrink-0">
                      blocked
                    </span>
                  )}
                </div>
                {plugin.description && (
                  <p className="text-[11px] text-cc-muted mt-0.5 line-clamp-2">{plugin.description}</p>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-cc-muted">
                  {plugin.author && <span>by {plugin.author}</span>}
                  <span>v{plugin.version}</span>
                  {plugin.skills.length > 0 && (
                    <span>{plugin.skills.length} skill{plugin.skills.length !== 1 ? "s" : ""}</span>
                  )}
                  {plugin.commands.length > 0 && (
                    <span>{plugin.commands.length} cmd{plugin.commands.length !== 1 ? "s" : ""}</span>
                  )}
                </div>
              </div>

              {/* Toggle button */}
              <button
                onClick={() => handleToggle(plugin)}
                disabled={toggling === plugin.id || plugin.blocked}
                className={`shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer disabled:opacity-50 ${
                  plugin.disabledInCampfire
                    ? "bg-cc-hover text-cc-muted hover:text-cc-fg"
                    : "bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25"
                }`}
              >
                {toggling === plugin.id ? "..." : plugin.disabledInCampfire ? "Enable" : "Disable"}
              </button>
            </div>

            {/* Expanded details */}
            {expandedPlugin === plugin.id && (
              <div className="border-t border-cc-border px-3 py-2.5 space-y-2">
                {/* Skills list */}
                {plugin.skills.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-mono-code text-cc-muted uppercase tracking-wider mb-1">Skills</h4>
                    {plugin.skills.map((skill) => {
                      const contentKey = `${plugin.id}:${skill.name}`;
                      return (
                        <div key={skill.name} className="mb-1.5">
                          <button
                            onClick={() => viewSkillContent(plugin.id, skill.name)}
                            className="text-[11px] font-mono-code text-cc-fg hover:text-cc-primary transition-colors cursor-pointer"
                          >
                            {skill.name}
                          </button>
                          {skill.description && (
                            <p className="text-[10px] text-cc-muted ml-2">{skill.description}</p>
                          )}
                          {skillContent[contentKey] && (
                            <pre className="mt-1 p-2 rounded bg-cc-code-bg text-cc-code-fg text-[10px] font-mono-code overflow-x-auto max-h-48 overflow-y-auto">
                              {skillContent[contentKey]}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Commands list */}
                {plugin.commands.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-mono-code text-cc-muted uppercase tracking-wider mb-1">Commands</h4>
                    {plugin.commands.map((cmd) => (
                      <div key={cmd.name} className="text-[11px] font-mono-code text-cc-fg">
                        /{cmd.name}
                      </div>
                    ))}
                  </div>
                )}

                {/* Install path */}
                <div className="text-[10px] font-mono-code text-cc-muted pt-1 border-t border-cc-border truncate" title={plugin.installPath}>
                  {plugin.installPath}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { api } from "../api.js";
import type { DmuxAgentInfo } from "../api.js";

interface DmuxLaunchFormProps {
  cwd: string;
  onLaunch: (command: string) => void;
  onChangeCwd: () => void;
}

export function DmuxLaunchForm({ cwd, onLaunch, onChangeCwd }: DmuxLaunchFormProps) {
  const [agents, setAgents] = useState<DmuxAgentInfo[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [branchPrefix, setBranchPrefix] = useState("dmux/");
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    api.getDmuxAgents()
      .then((result) => {
        setAgents(result);
        // Pre-select available agents
        const available = new Set(result.filter((a) => a.available).map((a) => a.id));
        setSelectedAgents(available);
      })
      .catch(() => {});
  }, []);

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      const config = {
        cwd,
        agents: [...selectedAgents],
        prompt: prompt.trim() || undefined,
        branchPrefix: branchPrefix.trim() || undefined,
      };
      const result = await api.launchDmux(config);
      onLaunch(result.command);
    } catch {
      // Error handled silently — terminal won't launch
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-cc-fg mb-4">Launch dmux</h2>

      {/* Project folder */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-cc-muted mb-1.5">
          Project Folder
        </label>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm text-cc-fg bg-cc-bg rounded-lg px-3 py-2 truncate border border-cc-border">
            {cwd}
          </code>
          <button
            type="button"
            onClick={onChangeCwd}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer whitespace-nowrap"
          >
            Change
          </button>
        </div>
      </div>

      {/* Agent selection */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-cc-muted mb-1.5">
          Agents
        </label>
        <div className="flex flex-wrap gap-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              disabled={!agent.available}
              onClick={() => toggleAgent(agent.id)}
              title={!agent.available ? `${agent.name} is not installed` : undefined}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors cursor-pointer ${
                !agent.available
                  ? "border-cc-border text-cc-muted/40 cursor-not-allowed"
                  : selectedAgents.has(agent.id)
                    ? "border-cc-primary bg-cc-primary/10 text-cc-primary"
                    : "border-cc-border text-cc-fg hover:bg-cc-card-hover"
              }`}
            >
              {agent.name}
            </button>
          ))}
          {agents.length === 0 && (
            <p className="text-xs text-cc-muted">Loading agents...</p>
          )}
        </div>
      </div>

      {/* Prompt */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-cc-muted mb-1.5">
          Prompt <span className="text-cc-muted/50">(optional)</span>
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter a prompt for all agents..."
          rows={3}
          className="w-full text-sm text-cc-fg bg-cc-bg rounded-lg px-3 py-2 border border-cc-border resize-none focus:outline-none focus:ring-1 focus:ring-cc-primary"
        />
      </div>

      {/* Branch prefix */}
      <div className="mb-6">
        <label className="block text-xs font-medium text-cc-muted mb-1.5">
          Branch Prefix
        </label>
        <input
          type="text"
          value={branchPrefix}
          onChange={(e) => setBranchPrefix(e.target.value)}
          placeholder="dmux/"
          className="w-full text-sm text-cc-fg bg-cc-bg rounded-lg px-3 py-2 border border-cc-border focus:outline-none focus:ring-1 focus:ring-cc-primary"
        />
      </div>

      {/* Launch button */}
      <button
        type="button"
        onClick={handleLaunch}
        disabled={launching || selectedAgents.size === 0}
        className="w-full px-4 py-2.5 text-sm font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {launching ? "Launching..." : "Launch dmux"}
      </button>
    </div>
  );
}

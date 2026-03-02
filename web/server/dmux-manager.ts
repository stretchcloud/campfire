/**
 * DmuxManager — Core service for tmux/dmux interactions.
 *
 * Self-contained singleton that reads .dmux/dmux.config.json and queries
 * tmux to provide pane status, focus control, and key sending.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBinary } from "./path-resolver.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DmuxPaneInfo {
  /** ID from .dmux/dmux.config.json */
  id: string;
  /** Short slug, e.g. "cc-1" */
  slug: string;
  /** tmux pane ID, e.g. "%3" */
  paneId: string;
  /** tmux target, e.g. "dmux-abc:0.1" */
  tmuxTarget: string;
  /** Agent type: "claude", "codex", etc. */
  agent: string;
  /** Current agent status */
  agentStatus: "idle" | "analyzing" | "waiting" | "working";
  /** Git branch name */
  branchName: string;
  /** Path to git worktree */
  worktreePath: string;
  /** Project root directory */
  projectRoot: string;
  /** Whether this pane is currently focused */
  isActive: boolean;
}

export interface DmuxSessionStatus {
  running: boolean;
  sessionName: string | null;
  projectRoot: string | null;
  panes: DmuxPaneInfo[];
  totalPanes: number;
}

export interface DmuxAgentInfo {
  id: string;
  slug: string;
  name: string;
  available: boolean;
}

export interface DmuxLaunchConfig {
  cwd: string;
  agents?: string[];
  prompt?: string;
  branchPrefix?: string;
}

// ─── Known agents ───────────────────────────────────────────────────────────

const KNOWN_AGENTS: Array<{ id: string; slug: string; name: string; binary: string }> = [
  { id: "claude", slug: "cc", name: "Claude Code", binary: "claude" },
  { id: "codex", slug: "cx", name: "Codex", binary: "codex" },
  { id: "goose", slug: "gs", name: "Goose", binary: "goose" },
  { id: "aider", slug: "ai", name: "Aider", binary: "aider" },
  { id: "openhands", slug: "oh", name: "OpenHands", binary: "openhands" },
];

// ─── Internal config shape from .dmux/dmux.config.json ─────────────────────

interface DmuxConfigPane {
  id?: string;
  slug?: string;
  agent?: string;
  // dmux uses camelCase in its config
  paneId?: string;
  pane_id?: string;       // legacy snake_case fallback
  tmux_target?: string;
  branch?: string;
  worktree?: string;
  worktreePath?: string;  // dmux uses this
  status?: string;
  agentStatus?: string;   // dmux uses this
  projectRoot?: string;
  projectName?: string;
}

interface DmuxConfig {
  // dmux uses camelCase
  projectName?: string;
  projectRoot?: string;
  // legacy snake_case fallback
  session_name?: string;
  project_root?: string;
  panes?: DmuxConfigPane[];
}

// ─── DmuxManager ────────────────────────────────────────────────────────────

class DmuxManager {
  /**
   * Get the current status of a dmux session for a given working directory.
   * Reads .dmux/dmux.config.json and cross-references with live tmux state.
   */
  getStatus(cwd: string): DmuxSessionStatus {
    const config = this.readDmuxConfig(cwd);
    if (!config) {
      return { running: false, sessionName: null, projectRoot: null, panes: [], totalPanes: 0 };
    }

    // dmux config uses camelCase (projectName), fall back to snake_case (session_name)
    const projectName = config.projectName || config.session_name;
    if (!projectName) {
      return { running: false, sessionName: null, projectRoot: null, panes: [], totalPanes: 0 };
    }

    const projectRoot = config.projectRoot || config.project_root || cwd;

    // dmux names tmux sessions as "dmux-{projectName}-{hash}" — find the matching session
    const sessionName = this.findDmuxTmuxSession(projectName);
    if (!sessionName) {
      return { running: false, sessionName: null, projectRoot, panes: [], totalPanes: 0 };
    }

    // Get live pane info from tmux
    const livePanes = this.listTmuxPanes(sessionName);
    const configPanes = config.panes || [];

    // Merge config panes with live tmux state — only include panes that exist in tmux
    const panes: DmuxPaneInfo[] = [];
    for (const cp of configPanes) {
      const paneId = cp.paneId || cp.pane_id || "";
      const tmuxTarget = cp.tmux_target || "";

      // Check if this pane exists in live tmux output (match by pane ID like "%3")
      const live = livePanes.find(
        (lp) => lp.paneId === paneId || (tmuxTarget && lp.tmuxTarget === tmuxTarget),
      );
      if (!live) continue;

      panes.push({
        id: cp.id || paneId,
        slug: cp.slug || "",
        paneId: live.paneId,
        tmuxTarget: live.tmuxTarget,
        agent: cp.agent || "unknown",
        agentStatus: this.normalizeStatus(cp.agentStatus || cp.status),
        branchName: cp.branch || "",
        worktreePath: cp.worktreePath || cp.worktree || "",
        projectRoot,
        isActive: live.isActive,
      });
    }

    return {
      running: true,
      sessionName,
      projectRoot,
      panes,
      totalPanes: panes.length,
    };
  }

  /**
   * Focus a specific tmux pane by target (e.g. "dmux-abc:0.1").
   */
  focusPane(tmuxTarget: string): boolean {
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return false;
      // Select the window first, then the pane
      const windowTarget = tmuxTarget.includes(".") ? tmuxTarget.split(".")[0] : tmuxTarget;
      execSync(`${tmux} select-window -t ${this.shellEscape(windowTarget)}`, {
        timeout: 5000,
      });
      execSync(`${tmux} select-pane -t ${this.shellEscape(tmuxTarget)}`, {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send keystrokes to a specific tmux pane.
   */
  sendToPane(tmuxTarget: string, keys: string, enter = false): boolean {
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return false;
      const escaped = this.shellEscape(keys);
      const enterSuffix = enter ? " Enter" : "";
      execSync(`${tmux} send-keys -t ${this.shellEscape(tmuxTarget)} ${escaped}${enterSuffix}`, {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the list of known agents with availability status.
   */
  getAvailableAgents(): DmuxAgentInfo[] {
    return KNOWN_AGENTS.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      available: resolveBinary(a.binary) !== null,
    }));
  }

  /**
   * Stop a dmux session by killing the tmux session.
   */
  stopSession(cwd: string): { ok: boolean; error?: string } {
    const status = this.getStatus(cwd);
    if (!status.running || !status.sessionName) {
      return { ok: false, error: "No running dmux session found" };
    }
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return { ok: false, error: "tmux not found" };
      execSync(`${tmux} kill-session -t ${this.shellEscape(status.sessionName)}`, {
        timeout: 5000,
        stdio: "pipe",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Build the launch command for dmux. Since dmux is configured via its own TUI
   * and config files, we just return "dmux".
   */
  buildLaunchCommand(_config: DmuxLaunchConfig): string {
    return "dmux";
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private readDmuxConfig(cwd: string): DmuxConfig | null {
    try {
      const configPath = join(cwd, ".dmux", "dmux.config.json");
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as DmuxConfig;
    } catch {
      return null;
    }
  }

  /**
   * Find a tmux session matching the dmux naming pattern "dmux-{projectName}-{hash}".
   * Also checks for exact match (legacy session_name in config).
   */
  private findDmuxTmuxSession(projectName: string): string | null {
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return null;
      const output = execSync(`${tmux} list-sessions -F "#{session_name}"`, {
        encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (!output) return null;
      const sessions = output.split("\n");
      // Match "dmux-{projectName}-{hash}" pattern
      const prefix = `dmux-${projectName}-`;
      const match = sessions.find((s) => s.startsWith(prefix));
      if (match) return match;
      // Also try exact match (legacy format)
      if (sessions.includes(projectName)) return projectName;
      return null;
    } catch {
      return null;
    }
  }

  private tmuxSessionExists(sessionName: string): boolean {
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return false;
      execSync(`${tmux} has-session -t ${this.shellEscape(sessionName)}`, {
        timeout: 5000,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }

  private listTmuxPanes(
    sessionName: string,
  ): Array<{ paneId: string; tmuxTarget: string; isActive: boolean }> {
    try {
      const tmux = this.getTmuxPath();
      if (!tmux) return [];
      const format = "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}|#{pane_active}";
      const output = execSync(
        `${tmux} list-panes -t ${this.shellEscape(sessionName)} -a -F "${format}"`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (!output) return [];
      return output.split("\n").map((line) => {
        const [paneId, tmuxTarget, active] = line.split("|");
        return { paneId, tmuxTarget, isActive: active === "1" };
      });
    } catch {
      return [];
    }
  }

  private getTmuxPath(): string | null {
    return resolveBinary("tmux");
  }

  private normalizeStatus(status?: string): DmuxPaneInfo["agentStatus"] {
    switch (status) {
      case "working":
        return "working";
      case "analyzing":
        return "analyzing";
      case "waiting":
        return "waiting";
      default:
        return "idle";
    }
  }

  private shellEscape(s: string): string {
    // Simple shell-safe quoting
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}

/** Singleton instance */
export const dmuxManager = new DmuxManager();

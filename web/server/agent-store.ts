import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProfile, AgentProfileCreateInput, AgentExecution } from "./agent-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const CAMPFIRE_DIR = join(homedir(), ".campfire");
const AGENTS_DIR = join(CAMPFIRE_DIR, "agents");
const RUNS_DIR = join(CAMPFIRE_DIR, "agent-runs");

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function profilePath(id: string): string {
  return join(AGENTS_DIR, `${id}.json`);
}

function runsPath(agentId: string): string {
  return join(RUNS_DIR, `${agentId}.jsonl`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

// ─── Agent Profile CRUD ─────────────────────────────────────────────────────

export function listAgents(): AgentProfile[] {
  ensureDir(AGENTS_DIR);
  try {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json"));
    const agents: AgentProfile[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(AGENTS_DIR, file), "utf-8");
        agents.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return agents;
  } catch {
    return [];
  }
}

export function getAgent(id: string): AgentProfile | null {
  ensureDir(AGENTS_DIR);
  try {
    const raw = readFileSync(profilePath(id), "utf-8");
    return JSON.parse(raw) as AgentProfile;
  } catch {
    return null;
  }
}

export function createAgent(data: AgentProfileCreateInput): AgentProfile {
  if (!data.name?.trim()) throw new Error("Agent name is required");
  if (!data.prompt?.trim()) throw new Error("Agent prompt is required");
  if (!data.cwd?.trim()) throw new Error("Agent working directory is required");

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Agent name must contain alphanumeric characters");

  ensureDir(AGENTS_DIR);
  if (existsSync(profilePath(id))) {
    throw new Error(`An agent with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const agent: AgentProfile = {
    ...data,
    id,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    cwd: data.cwd.trim(),
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    totalRuns: 0,
  };
  writeFileSync(profilePath(id), JSON.stringify(agent, null, 2), "utf-8");
  return agent;
}

export function updateAgent(
  id: string,
  updates: Partial<AgentProfile>,
): AgentProfile | null {
  ensureDir(AGENTS_DIR);
  const existing = getAgent(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Agent name must contain alphanumeric characters");

  if (newId !== id && existsSync(profilePath(newId))) {
    throw new Error(`An agent with a similar name already exists ("${newId}")`);
  }

  const agent: AgentProfile = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    createdAt: existing.createdAt,
  };

  if (newId !== id) {
    try { unlinkSync(profilePath(id)); } catch { /* ok */ }
  }

  writeFileSync(profilePath(newId), JSON.stringify(agent, null, 2), "utf-8");
  return agent;
}

export function deleteAgent(id: string): boolean {
  ensureDir(AGENTS_DIR);
  if (!existsSync(profilePath(id))) return false;
  try {
    unlinkSync(profilePath(id));
    return true;
  } catch {
    return false;
  }
}

// ─── Execution History ──────────────────────────────────────────────────────

export function appendExecution(execution: AgentExecution): void {
  ensureDir(RUNS_DIR);
  appendFileSync(runsPath(execution.agentId), JSON.stringify(execution) + "\n", "utf-8");
}

export function updateExecution(
  agentId: string,
  sessionId: string,
  updates: Partial<AgentExecution>,
): void {
  const executions = listExecutions(agentId);
  const idx = executions.findIndex((e) => e.sessionId === sessionId);
  if (idx < 0) return;
  executions[idx] = { ...executions[idx], ...updates };
  ensureDir(RUNS_DIR);
  const content = executions.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(runsPath(agentId), content, "utf-8");
}

export function listExecutions(agentId: string, limit = 50): AgentExecution[] {
  ensureDir(RUNS_DIR);
  try {
    const raw = readFileSync(runsPath(agentId), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const executions: AgentExecution[] = [];
    for (const line of lines) {
      try { executions.push(JSON.parse(line)); } catch { /* skip */ }
    }
    executions.sort((a, b) => b.startedAt - a.startedAt);
    return executions.slice(0, limit);
  } catch {
    return [];
  }
}

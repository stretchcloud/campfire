import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface Prompt {
  id: string;
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

const PROMPTS_FILE = join(homedir(), ".companion", "prompts.json");

function ensureDir(): void {
  mkdirSync(dirname(PROMPTS_FILE), { recursive: true });
}

function loadAll(): Prompt[] {
  try {
    if (!existsSync(PROMPTS_FILE)) return [];
    const raw = readFileSync(PROMPTS_FILE, "utf-8");
    return JSON.parse(raw) as Prompt[];
  } catch {
    return [];
  }
}

function saveAll(prompts: Prompt[]): void {
  ensureDir();
  writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2), "utf-8");
}

/** Returns true if the prompt should be visible in the given cwd. */
export function visibleForCwd(prompt: Prompt, cwd?: string): boolean {
  if (prompt.scope === "global") return true;
  if (!cwd || !prompt.projectPath) return false;
  return cwd.startsWith(prompt.projectPath);
}

export function listPrompts(opts?: { cwd?: string }): Prompt[] {
  const all = loadAll();
  if (!opts?.cwd) return all;
  return all.filter((p) => visibleForCwd(p, opts.cwd));
}

export function getPrompt(id: string): Prompt | undefined {
  return loadAll().find((p) => p.id === id);
}

export function createPrompt(
  name: string,
  content: string,
  scope: "global" | "project",
  projectPath?: string,
): Prompt {
  const all = loadAll();
  const prompt: Prompt = {
    id: randomUUID(),
    name,
    content,
    scope,
    projectPath: scope === "project" ? projectPath : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  all.push(prompt);
  saveAll(all);
  return prompt;
}

export function updatePrompt(
  id: string,
  updates: Partial<Pick<Prompt, "name" | "content" | "scope" | "projectPath">>,
): Prompt | undefined {
  const all = loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return undefined;
  all[idx] = {
    ...all[idx],
    ...updates,
    updatedAt: Date.now(),
  };
  saveAll(all);
  return all[idx];
}

export function deletePrompt(id: string): boolean {
  const all = loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveAll(all);
  return true;
}

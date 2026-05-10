import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { BackendType, BrowserIncomingMessage } from "./session-types.js";
import * as gitUtils from "./git-utils.js";
import { getRace, saveRace, type RaceEntry, type RaceResult } from "./race-store.js";

interface StartRaceOptions {
  prompt: string;
  backends: BackendType[];
  repoRoot: string;
  baseBranch?: string;
  modelByBackend?: Partial<Record<BackendType, string>>;
}

const POLL_MS = 1000;
const ENTRY_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitSafe(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

function extractAssistantText(messages: BrowserIncomingMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    for (const block of msg.message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

function findResult(messages: BrowserIncomingMessage[], afterIndex: number) {
  const result = messages.slice(afterIndex).find((msg) => msg.type === "result");
  return result?.type === "result" ? result.data : null;
}

function collectMetrics(worktreePath: string, startedAt: number, costUsd: number): RaceEntry["metrics"] {
  const changedFiles = collectChangedFiles(worktreePath);
  const numstat = gitSafe(["diff", "--numstat"], worktreePath);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of numstat.split(/\r?\n/)) {
    const [added, removed] = line.split(/\s+/);
    const addNum = Number(added);
    const removeNum = Number(removed);
    if (Number.isFinite(addNum)) linesAdded += addNum;
    if (Number.isFinite(removeNum)) linesRemoved += removeNum;
  }
  return {
    wallClockMs: Date.now() - startedAt,
    costUsd,
    filesChanged: changedFiles.length,
    linesAdded,
    linesRemoved,
  };
}

export function collectChangedFiles(worktreePath: string): string[] {
  const changed = gitSafe(["diff", "--name-only"], worktreePath).split(/\r?\n/).filter(Boolean);
  const staged = gitSafe(["diff", "--name-only", "--cached"], worktreePath).split(/\r?\n/).filter(Boolean);
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard"], worktreePath).split(/\r?\n/).filter(Boolean);
  return Array.from(new Set([...changed, ...staged, ...untracked])).sort();
}

export class RaceController {
  private readonly active = new Map<string, { cancelled: boolean }>();

  constructor(
    private readonly launcher: CliLauncher,
    private readonly wsBridge: WsBridge,
  ) {}

  startRace(options: StartRaceOptions): RaceResult {
    if (!options.prompt.trim()) throw new Error("prompt is required");
    if (options.backends.length < 2) throw new Error("At least two backends are required");

    const repoInfo = gitUtils.getRepoInfo(options.repoRoot);
    const baseBranch = options.baseBranch || repoInfo?.currentBranch || repoInfo?.defaultBranch || "main";
    const raceId = randomUUID();
    const race: RaceResult = {
      raceId,
      prompt: options.prompt,
      repoRoot: options.repoRoot,
      baseBranch,
      status: "running",
      createdAt: Date.now(),
      entries: [],
    };
    saveRace(race);
    void this.runRace(raceId, options);
    return race;
  }

  async cancelRace(raceId: string): Promise<RaceResult | null> {
    const race = getRace(raceId);
    if (!race) return null;
    const active = this.active.get(raceId);
    if (active) active.cancelled = true;
    await Promise.all(race.entries.map((entry) => this.launcher.kill(entry.sessionId).catch(() => false)));
    for (const entry of race.entries) {
      gitUtils.removeWorktree(race.repoRoot, entry.worktreePath, { force: true, branchToDelete: entry.branch });
      if (entry.status === "running" || entry.status === "pending") entry.status = "failed";
    }
    race.status = "cancelled";
    race.completedAt = Date.now();
    saveRace(race);
    return race;
  }

  pickWinner(raceId: string, sessionId: string): RaceResult | null {
    const race = getRace(raceId);
    if (!race) return null;
    const winner = race.entries.find((entry) => entry.sessionId === sessionId);
    if (!winner) throw new Error("Winner session is not part of this race");

    git(["merge", "--no-ff", winner.branch], race.repoRoot);
    race.winnerId = sessionId;
    race.status = "completed";
    race.completedAt = Date.now();

    for (const entry of race.entries) {
      if (entry.sessionId !== sessionId) {
        gitUtils.removeWorktree(race.repoRoot, entry.worktreePath, { force: true, branchToDelete: entry.branch });
      }
    }
    saveRace(race);
    return race;
  }

  private async runRace(raceId: string, options: StartRaceOptions): Promise<void> {
    const control = { cancelled: false };
    this.active.set(raceId, control);
    const race = getRace(raceId);
    if (!race) return;

    try {
      const entries = options.backends.map((backendType) => this.createEntry(race, backendType, options));
      race.entries = entries;
      saveRace(race);
      await Promise.all(entries.map((entry) => this.runEntry(raceId, entry, options.prompt, control)));
      const latest = getRace(raceId);
      if (latest && latest.status === "running") {
        latest.status = latest.entries.some((entry) => entry.status === "failed" || entry.status === "timeout") ? "failed" : "completed";
        latest.completedAt = Date.now();
        saveRace(latest);
      }
    } catch (err) {
      const latest = getRace(raceId) ?? race;
      latest.status = "failed";
      latest.completedAt = Date.now();
      latest.error = err instanceof Error ? err.message : String(err);
      saveRace(latest);
    } finally {
      this.active.delete(raceId);
    }
  }

  private createEntry(race: RaceResult, backendType: BackendType, options: StartRaceOptions): RaceEntry {
    const branch = `race-${backendType}-${race.raceId.slice(0, 8)}`;
    const wt = gitUtils.ensureWorktree(race.repoRoot, branch, {
      baseBranch: race.baseBranch,
      createBranch: true,
      forceNew: true,
    });
    const session = this.launcher.launch({
      cwd: wt.worktreePath,
      backendType,
      model: options.modelByBackend?.[backendType],
      permissionMode: "bypassPermissions",
      orchestrationRole: "race_entry",
      worktreeInfo: {
        isWorktree: true,
        repoRoot: race.repoRoot,
        branch,
        actualBranch: wt.actualBranch,
        worktreePath: wt.worktreePath,
      },
    });
    this.wsBridge.markSessionOrchestration(session.sessionId, {
      role: "race_entry",
      detectedEnvironment: session.detectedEnvironment,
    });
    return {
      id: randomUUID(),
      sessionId: session.sessionId,
      backendType,
      model: options.modelByBackend?.[backendType],
      worktreePath: wt.worktreePath,
      branch: wt.actualBranch,
      status: "pending",
      startedAt: Date.now(),
    };
  }

  private async runEntry(raceId: string, entry: RaceEntry, prompt: string, control: { cancelled: boolean }): Promise<void> {
    entry.status = "running";
    entry.startedAt = Date.now();
    this.updateEntry(raceId, entry);

    try {
      await this.waitForConnection(entry.sessionId, 20_000);
      const session = this.wsBridge.getSession(entry.sessionId);
      const startIndex = session?.messageHistory.length ?? 0;
      this.wsBridge.injectUserMessage(entry.sessionId, prompt);
      const result = await this.waitForResult(entry.sessionId, startIndex, control);
      const finalSession = this.wsBridge.getSession(entry.sessionId);
      entry.completedAt = Date.now();
      entry.status = result.is_error ? "failed" : "completed";
      entry.error = result.is_error ? result.errors?.join("\n") || result.result || "Race entry failed" : undefined;
      entry.outputSummary = extractAssistantText((finalSession?.messageHistory ?? []) as BrowserIncomingMessage[]).slice(0, 1000);
      entry.filesChanged = collectChangedFiles(entry.worktreePath);
      entry.metrics = collectMetrics(entry.worktreePath, entry.startedAt, result.total_cost_usd || finalSession?.state.total_cost_usd || 0);
    } catch (err) {
      entry.completedAt = Date.now();
      entry.status = err instanceof Error && err.message.includes("Timed out") ? "timeout" : "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      entry.filesChanged = collectChangedFiles(entry.worktreePath);
      entry.metrics = collectMetrics(entry.worktreePath, entry.startedAt, 0);
    }
    this.updateEntry(raceId, entry);
  }

  private updateEntry(raceId: string, entry: RaceEntry): void {
    const race = getRace(raceId);
    if (!race) return;
    race.entries = race.entries.map((existing) => existing.id === entry.id ? entry : existing);
    saveRace(race);
  }

  private async waitForConnection(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.wsBridge.isCliConnected(sessionId)) return;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for race session ${sessionId} to connect.`);
  }

  private async waitForResult(sessionId: string, startIndex: number, control: { cancelled: boolean }) {
    const deadline = Date.now() + ENTRY_TIMEOUT_MS;
    while (Date.now() < deadline && !control.cancelled) {
      const session = this.wsBridge.getSession(sessionId);
      const result = session ? findResult(session.messageHistory as BrowserIncomingMessage[], startIndex) : null;
      if (result) return result;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for race session ${sessionId} to finish.`);
  }
}

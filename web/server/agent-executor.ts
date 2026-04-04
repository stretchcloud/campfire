import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { AgentProfile, AgentExecution } from "./agent-types.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import * as agentStore from "./agent-store.js";
import * as envManager from "./env-manager.js";
import * as sessionNames from "./session-names.js";
import { getSettings } from "./settings-manager.js";

function resolveEnvVars(agent: AgentProfile): Record<string, string> | undefined {
  let envVars: Record<string, string> | undefined;
  if (agent.envSlug) {
    const env = envManager.getEnv(agent.envSlug);
    if (env) envVars = env.variables;
  }
  if (agent.env) {
    envVars = { ...envVars, ...agent.env };
  }
  // Auto-inject provider tokens from global settings (if not already set)
  const settings = getSettings();
  if (agent.backendType === "claude" && settings.claudeOAuthToken && !envVars?.["CLAUDE_CODE_OAUTH_TOKEN"]) {
    envVars = { ...envVars, CLAUDE_CODE_OAUTH_TOKEN: settings.claudeOAuthToken };
  }
  if (agent.backendType === "codex" && settings.openaiApiKey && !envVars?.["OPENAI_API_KEY"]) {
    envVars = { ...envVars, OPENAI_API_KEY: settings.openaiApiKey };
  }
  if (settings.anthropicApiKey && !envVars?.["ANTHROPIC_API_KEY"]) {
    envVars = { ...envVars, ANTHROPIC_API_KEY: settings.anthropicApiKey };
  }
  return envVars;
}

function resolvePrompt(template: string, input?: string): string {
  if (!input) return template;
  if (template.includes("{{input}}")) return template.replaceAll("{{input}}", input);
  return template + "\n\n" + input;
}

function resolveCodexSandbox(agent: AgentProfile): "danger-full-access" | "workspace-write" | undefined {
  if (agent.backendType !== "codex") return undefined;
  return agent.permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write";
}

const MAX_CONSECUTIVE_FAILURES = 5;
const CLI_CONNECT_TIMEOUT_MS = 30_000;
const CLI_CONNECT_POLL_MS = 500;

export class AgentExecutor {
  private readonly timers = new Map<string, Cron>();
  private readonly launcher: CliLauncher;
  private readonly wsBridge: WsBridge;

  constructor(launcher: CliLauncher, wsBridge: WsBridge) {
    this.launcher = launcher;
    this.wsBridge = wsBridge;
  }

  /** Start all enabled scheduled agents. Called once at server startup. */
  startAll(): void {
    const agents = agentStore.listAgents();
    let scheduled = 0;
    for (const agent of agents) {
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        this.scheduleAgent(agent);
        scheduled++;
      }
    }
    if (scheduled > 0) {
      console.log(`[agent-executor] Scheduled ${scheduled} agent(s)`);
    }
  }

  /** Schedule or reschedule a single agent's cron trigger. */
  scheduleAgent(agent: AgentProfile): void {
    this.unscheduleAgent(agent.id);

    const schedule = agent.triggers?.schedule;
    if (!schedule?.enabled || !schedule.expression) return;

    try {
      if (schedule.recurring) {
        const timer = new Cron(schedule.expression, () => {
          this.executeAgent(agent.id, { trigger: "schedule" }).catch((err) => {
            console.error(`[agent-executor] Scheduled run of "${agent.name}" failed:`, err);
          });
        });
        this.timers.set(agent.id, timer);
      } else {
        const runAt = new Date(schedule.expression);
        if (runAt.getTime() <= Date.now()) return;
        const timer = new Cron(runAt, () => {
          this.executeAgent(agent.id, { trigger: "schedule" }).catch((err) => {
            console.error(`[agent-executor] One-shot agent "${agent.name}" failed:`, err);
          });
          agentStore.updateAgent(agent.id, {
            triggers: {
              ...agent.triggers,
              schedule: { ...schedule, enabled: false },
            },
          });
          this.timers.delete(agent.id);
        });
        this.timers.set(agent.id, timer);
      }
    } catch (err) {
      console.error(`[agent-executor] Invalid schedule for "${agent.name}":`, err);
    }
  }

  /** Stop cron timer for an agent. */
  unscheduleAgent(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      timer.stop();
      this.timers.delete(agentId);
    }
  }

  /** Execute an agent: create a session, inject the prompt, track execution. */
  async executeAgent(
    agentId: string,
    opts: { input?: string; trigger?: "manual" | "webhook" | "schedule"; force?: boolean } = {},
  ): Promise<AgentExecution> {
    const agent = agentStore.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    if (!agent.enabled && !opts.force) throw new Error(`Agent "${agent.name}" is disabled`);

    // Overlap prevention
    if (agent.lastSessionId && this.launcher.isAlive(agent.lastSessionId)) {
      throw new Error(`Agent "${agent.name}" is already running (${agent.lastSessionId})`);
    }

    console.log(`[agent-executor] Executing agent "${agent.name}" (${agentId}) [${opts.trigger || "manual"}]`);

    const execution: AgentExecution = {
      executionId: randomUUID(),
      agentId,
      sessionId: "",
      input: opts.input,
      trigger: opts.trigger || "manual",
      startedAt: Date.now(),
    };

    try {
      const envVars = resolveEnvVars(agent);

      // Launch session via CliLauncher (works for ALL backends)
      const sessionInfo = this.launcher.launch({
        model: agent.model,
        permissionMode: agent.permissionMode,
        cwd: agent.cwd,
        env: envVars,
        backendType: agent.backendType,
        codexInternetAccess: agent.backendType === "codex" ? (agent.codexInternetAccess ?? true) : undefined,
        codexSandbox: resolveCodexSandbox(agent),
      });

      execution.sessionId = sessionInfo.sessionId;

      // Set session name with agent icon
      const label = `${agent.icon || "\u{1F916}"} ${agent.name}`;
      sessionNames.setName(sessionInfo.sessionId, label);

      // Wait for CLI to connect
      await this.waitForCLIConnection(sessionInfo.sessionId);

      // Resolve prompt and inject with agent prefix for traceability
      const resolvedPrompt = resolvePrompt(agent.prompt, opts.input);
      const fullPrompt = `[agent:${agent.id} ${agent.name}]\n\n${resolvedPrompt}`;
      this.wsBridge.injectUserMessage(sessionInfo.sessionId, fullPrompt);

      // Update agent tracking
      agentStore.updateAgent(agentId, {
        lastRunAt: Date.now(),
        lastSessionId: sessionInfo.sessionId,
        totalRuns: agent.totalRuns + 1,
        consecutiveFailures: 0,
      });

      execution.success = true;
      agentStore.appendExecution(execution);

      return execution;
    } catch (err) {
      console.error(`[agent-executor] Agent "${agent.name}" failed:`, err);
      execution.error = err instanceof Error ? err.message : String(err);
      execution.completedAt = Date.now();
      agentStore.appendExecution(execution);

      const failures = agent.consecutiveFailures + 1;
      const updates: Partial<AgentProfile> = {
        consecutiveFailures: failures,
        lastRunAt: Date.now(),
      };

      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        updates.enabled = false;
        this.unscheduleAgent(agentId);
        console.warn(`[agent-executor] Agent "${agent.name}" disabled after ${failures} consecutive failures`);
      }

      agentStore.updateAgent(agentId, updates);
      throw err;
    }
  }

  /** Manual trigger (bypasses enabled check). */
  executeAgentManually(agentId: string, input?: string): void {
    this.executeAgent(agentId, { input, trigger: "manual", force: true }).catch((err) => {
      console.error(`[agent-executor] Manual execution of agent "${agentId}" failed:`, err);
    });
  }

  /** Get next scheduled run time for an agent. */
  getNextRunTime(agentId: string): Date | null {
    const timer = this.timers.get(agentId);
    if (!timer) return null;
    return timer.nextRun() ?? null;
  }

  /** Check if an agent's last session is still alive. */
  isRunning(agentId: string): boolean {
    const agent = agentStore.getAgent(agentId);
    if (!agent?.lastSessionId) return false;
    return this.launcher.isAlive(agent.lastSessionId);
  }

  /** Graceful shutdown: stop all timers. */
  destroy(): void {
    for (const [, timer] of this.timers) {
      timer.stop();
    }
    this.timers.clear();
  }

  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) return;
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }
    throw new Error(`CLI process did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }
}

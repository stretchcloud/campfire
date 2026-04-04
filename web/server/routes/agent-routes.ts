import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as agentStore from "../agent-store.js";

export function registerAgentRoutes(api: Hono, deps: RouteDeps): void {
  const { agentExecutor } = deps;

  // ─── List all agents (enriched with runtime state) ──────────────────────
  api.get("/agents", (c) => {
    const agents = agentStore.listAgents();
    const enriched = agents.map((a) => ({
      ...a,
      isRunning: agentExecutor?.isRunning(a.id) ?? false,
      nextRunAt: agentExecutor?.getNextRunTime(a.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  // ─── Get single agent ───────────────────────────────────────────────────
  api.get("/agents/:id", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({
      ...agent,
      isRunning: agentExecutor?.isRunning(agent.id) ?? false,
      nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null,
    });
  });

  // ─── Create agent ──────────────────────────────────────────────────────
  api.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const agent = agentStore.createAgent({
        name: body.name || "",
        description: body.description || "",
        icon: body.icon,
        backendType: body.backendType || "claude",
        model: body.model || "",
        permissionMode: body.permissionMode || "bypassPermissions",
        cwd: body.cwd || "",
        prompt: body.prompt || "",
        triggers: body.triggers,
        envSlug: body.envSlug,
        env: body.env,
        mcpServers: body.mcpServers,
        codexInternetAccess: body.codexInternetAccess,
        enabled: body.enabled ?? true,
      });
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      }
      return c.json(agent, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 400);
    }
  });

  // ─── Update agent ──────────────────────────────────────────────────────
  api.put("/agents/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const EDITABLE = [
        "name", "description", "icon", "backendType", "model", "permissionMode",
        "cwd", "prompt", "triggers", "envSlug", "env", "mcpServers",
        "codexInternetAccess", "enabled",
      ] as const;
      const allowed: Record<string, unknown> = {};
      for (const key of EDITABLE) {
        if (key in body) allowed[key] = body[key];
      }
      const agent = agentStore.updateAgent(id, allowed);
      if (!agent) return c.json({ error: "Agent not found" }, 404);

      // Reschedule if ID changed or schedule updated
      if (agent.id !== id) agentExecutor?.unscheduleAgent(id);
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      } else {
        agentExecutor?.unscheduleAgent(agent.id);
      }
      return c.json(agent);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 400);
    }
  });

  // ─── Delete agent ──────────────────────────────────────────────────────
  api.delete("/agents/:id", (c) => {
    const id = c.req.param("id");
    agentExecutor?.unscheduleAgent(id);
    const deleted = agentStore.deleteAgent(id);
    if (!deleted) return c.json({ error: "Agent not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Toggle enabled ────────────────────────────────────────────────────
  api.post("/agents/:id/toggle", (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const updated = agentStore.updateAgent(id, { enabled: !agent.enabled });
    if (updated?.enabled && updated.triggers?.schedule?.enabled) {
      agentExecutor?.scheduleAgent(updated);
    } else {
      agentExecutor?.unscheduleAgent(id);
    }
    return c.json(updated);
  });

  // ─── Run agent manually ────────────────────────────────────────────────
  api.post("/agents/:id/run", async (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      const execution = await agentExecutor?.executeAgent(id, {
        input: body.input,
        trigger: "manual",
        force: true,
      });
      return c.json({
        ok: true,
        executionId: execution?.executionId,
        sessionId: execution?.sessionId,
      });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
    }
  });

  // ─── Execution history ─────────────────────────────────────────────────
  api.get("/agents/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(agentStore.listExecutions(id));
  });

  // ─── Export agent (portable JSON) ──────────────────────────────────────
  api.get("/agents/:id/export", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const { id: _id, createdAt: _ca, updatedAt: _ua, totalRuns: _tr,
      consecutiveFailures: _cf, lastRunAt: _lr, lastSessionId: _ls,
      ...exportData } = agent;
    return c.json(exportData);
  });

  // ─── Import agent ──────────────────────────────────────────────────────
  api.post("/agents/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const agent = agentStore.createAgent({
        ...body,
        enabled: false,
      });
      return c.json(agent, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 400);
    }
  });

  // ─── Webhook trigger ───────────────────────────────────────────────────
  api.post("/agents/:id/webhook", async (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    if (!agent.triggers?.webhook?.enabled) return c.json({ error: "Webhook not enabled" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      const execution = await agentExecutor?.executeAgent(id, {
        input: typeof body.input === "string" ? body.input : JSON.stringify(body),
        trigger: "webhook",
      });
      return c.json({
        ok: true,
        executionId: execution?.executionId,
        sessionId: execution?.sessionId,
      });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
    }
  });
}

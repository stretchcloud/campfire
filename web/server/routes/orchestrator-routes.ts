import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import type { Pipeline, PipelineStage } from "../orchestrator-types.js";
import {
  listPipelines, getPipeline, savePipeline, deletePipeline,
  listRuns, getRun, deleteRun,
} from "../orchestrator-store.js";
import { executePipeline, cancelRun, isRunActive } from "../orchestrator-executor.js";

export function registerOrchestratorRoutes(api: Hono, deps: RouteDeps): void {
  // ─── Pipelines CRUD ──────────────────────────────────────────────────

  api.get("/orchestrator/pipelines", (c) => {
    return c.json(listPipelines());
  });

  api.get("/orchestrator/pipelines/:id", (c) => {
    const pipeline = getPipeline(c.req.param("id"));
    if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);
    return c.json(pipeline);
  });

  api.post("/orchestrator/pipelines", async (c) => {
    const body = await c.req.json<{ name: string; description?: string; cwd: string; stages: Omit<PipelineStage, "id">[] }>();
    if (!body.name || !body.cwd || !body.stages?.length) {
      return c.json({ error: "name, cwd, and stages are required" }, 400);
    }

    const pipeline: Pipeline = {
      id: randomUUID(),
      name: body.name,
      description: body.description,
      cwd: body.cwd,
      stages: body.stages.map((s) => ({ ...s, id: randomUUID() })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    savePipeline(pipeline);
    return c.json(pipeline, 201);
  });

  api.put("/orchestrator/pipelines/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getPipeline(id);
    if (!existing) return c.json({ error: "Pipeline not found" }, 404);

    const body = await c.req.json<Partial<Pipeline>>();
    const updated: Pipeline = {
      ...existing,
      name: body.name || existing.name,
      description: body.description ?? existing.description,
      cwd: body.cwd || existing.cwd,
      stages: body.stages || existing.stages,
      updatedAt: Date.now(),
    };

    savePipeline(updated);
    return c.json(updated);
  });

  api.delete("/orchestrator/pipelines/:id", (c) => {
    const ok = deletePipeline(c.req.param("id"));
    if (!ok) return c.json({ error: "Pipeline not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Runs ────────────────────────────────────────────────────────────

  api.get("/orchestrator/runs", (c) => {
    const pipelineId = c.req.query("pipeline_id");
    return c.json(listRuns(pipelineId || undefined));
  });

  api.get("/orchestrator/runs/:id", (c) => {
    const run = getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(run);
  });

  api.delete("/orchestrator/runs/:id", (c) => {
    const ok = deleteRun(c.req.param("id"));
    if (!ok) return c.json({ error: "Run not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Execute a pipeline ──────────────────────────────────────────────

  api.post("/orchestrator/pipelines/:id/run", async (c) => {
    const pipeline = getPipeline(c.req.param("id"));
    if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

    // Create session helper that uses the existing launcher
    const createSession = async (opts: {
      cwd: string;
      backend: string;
      model?: string;
      permissionMode?: string;
      prompt?: string;
    }) => {
      try {
        const info = deps.launcher.launch({
          cwd: opts.cwd,
          backendType: (opts.backend || "claude") as "claude" | "codex",
          model: opts.model,
          permissionMode: opts.permissionMode,
        });
        const sessionId = info.sessionId;

        // Wait for CLI to connect (max 15s)
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const session = deps.wsBridge.getSession(sessionId);
          if (session?.cliSocket || session?.adapter) {
            // Send the prompt
            if (opts.prompt) {
              deps.wsBridge.injectUserMessage(sessionId, opts.prompt);
            }
            return { sessionId };
          }
        }
        return null;
      } catch {
        return null;
      }
    };

    // Session status helper — checks launcher state + session history for completion
    const getSessionStatus = (sessionId: string) => {
      const launchInfo = deps.launcher.getSession(sessionId);
      const session = deps.wsBridge.getSession(sessionId);
      if (!launchInfo && !session) return null;

      // Determine status from launcher state
      const launcherState = launchInfo?.state || "starting";
      let status = "running";
      if (launcherState === "exited") {
        status = "idle";
      } else if (session) {
        // Check if there's a recent result message (indicates turn completed)
        const history = session.messageHistory;
        const lastEntry = history[history.length - 1] as Record<string, unknown> | undefined;
        if (lastEntry?.type === "result") {
          status = "idle";
        }
      }

      // Extract last assistant message text
      let lastMessage = "";
      if (session) {
        const assistantMsgs = session.messageHistory.filter(
          (m: Record<string, unknown>) => (m as { type?: string }).type === "assistant",
        );
        const lastMsg = assistantMsgs[assistantMsgs.length - 1] as
          | { message?: { content?: unknown } }
          | undefined;
        if (lastMsg?.message?.content) {
          const content = lastMsg.message.content;
          if (typeof content === "string") {
            lastMessage = content;
          } else if (Array.isArray(content)) {
            lastMessage = (content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text!)
              .join("\n");
          }
        }
      }

      return {
        status,
        cost: session?.state.total_cost_usd || 0,
        lastMessage,
      };
    };

    // Execute asynchronously — return the run ID immediately
    const runPromise = executePipeline(pipeline, createSession, getSessionStatus);

    // Return early with the run (in pending state initially, then running)
    const earlyRun = await Promise.race([
      runPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);

    if (earlyRun) {
      return c.json(earlyRun, 201);
    }

    // Run started but not yet complete — get the ID from the store
    const runs = listRuns(pipeline.id);
    const latest = runs[0];
    if (latest) {
      return c.json(latest, 202);
    }

    return c.json({ error: "Failed to start pipeline run" }, 500);
  });

  // Cancel a running pipeline
  api.post("/orchestrator/runs/:id/cancel", (c) => {
    const runId = c.req.param("id");
    if (!isRunActive(runId)) {
      return c.json({ error: "Run is not active" }, 400);
    }
    const ok = cancelRun(runId);
    return c.json({ ok });
  });
}

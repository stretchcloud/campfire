import type { Hono } from "hono";
import { execFileSync } from "node:child_process";
import type { RouteDeps } from "./route-deps.js";
import type { BackendType } from "../session-types.js";
import { RaceController } from "../race-controller.js";
import { deleteRace, getRace, listRaces } from "../race-store.js";

const VALID_BACKENDS = new Set<BackendType>(["claude", "codex", "goose", "aider", "openhands", "openclaw", "opencode"]);

export function registerRaceRoutes(api: Hono, deps: RouteDeps): void {
  const controller = new RaceController(deps.launcher, deps.wsBridge);

  api.post("/races", async (c) => {
    const body = await c.req.json<{
      prompt?: string;
      backends?: string[];
      repoRoot?: string;
      baseBranch?: string;
      modelByBackend?: Partial<Record<BackendType, string>>;
      envSlug?: string;
      env?: Record<string, string>;
      cascade?: boolean;
    }>().catch(() => ({} as {
      prompt?: string;
      backends?: string[];
      repoRoot?: string;
      baseBranch?: string;
      modelByBackend?: Partial<Record<BackendType, string>>;
      envSlug?: string;
      env?: Record<string, string>;
      cascade?: boolean;
    }));

    const prompt = body.prompt?.trim() || "";
    const backends = (body.backends ?? []).filter((backend: string): backend is BackendType => VALID_BACKENDS.has(backend as BackendType));
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    if (backends.length < 2) return c.json({ error: "Select at least two valid backends" }, 400);
    if (!body.repoRoot) return c.json({ error: "repoRoot is required" }, 400);

    try {
      const race = controller.startRace({
        prompt,
        backends,
        repoRoot: body.repoRoot,
        baseBranch: body.baseBranch,
        modelByBackend: body.modelByBackend,
        envSlug: body.envSlug,
        env: body.env,
        cascade: body.cascade === true,
      });
      return c.json(race, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.get("/races", (c) => c.json(listRaces()));

  api.get("/races/:id", (c) => {
    const race = getRace(c.req.param("id"));
    if (!race) return c.json({ error: "Race not found" }, 404);
    return c.json(race);
  });

  api.get("/races/:id/entries/:entryId/diff", (c) => {
    const race = getRace(c.req.param("id"));
    if (!race) return c.json({ error: "Race not found" }, 404);
    const entry = race.entries.find((item) => item.id === c.req.param("entryId"));
    if (!entry) return c.json({ error: "Race entry not found" }, 404);
    try {
      const diff = execFileSync("git", ["diff", "--", "."], {
        cwd: entry.worktreePath,
        encoding: "utf-8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return c.json({ diff, files: entry.filesChanged ?? [] });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.post("/races/:id/pick", async (c) => {
    const body = await c.req.json<{ sessionId?: string }>().catch(() => ({} as { sessionId?: string }));
    if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
    try {
      const race = controller.pickWinner(c.req.param("id"), body.sessionId);
      if (!race) return c.json({ error: "Race not found" }, 404);
      return c.json(race);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.post("/races/:id/cancel", async (c) => {
    const race = await controller.cancelRace(c.req.param("id"));
    if (!race) return c.json({ error: "Race not found" }, 404);
    return c.json(race);
  });

  api.delete("/races/:id", (c) => {
    const ok = deleteRace(c.req.param("id"));
    if (!ok) return c.json({ error: "Race not found" }, 404);
    return c.json({ ok: true });
  });
}

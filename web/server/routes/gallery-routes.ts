import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as galleryStore from "../gallery-store.js";
import * as galleryVotes from "../gallery-votes.js";
import type { GalleryFilter } from "../gallery-types.js";
import type { BackendType } from "../session-types.js";
import * as settingsManager from "../settings-manager.js";
import * as clawhubExport from "../clawhub-export.js";

// ─── Public Replay Token Store ──────────────────────────────────────────────
const publicReplayTokens = new Map<string, { sessionId: string; createdAt: number }>();

function generatePublicReplayToken(sessionId: string): string {
  for (const [token, entry] of publicReplayTokens) {
    if (entry.sessionId === sessionId) return token;
  }
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
  publicReplayTokens.set(token, { sessionId, createdAt: Date.now() });
  return token;
}

function resolvePublicReplayToken(token: string): string | null {
  const entry = publicReplayTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > 30 * 24 * 60 * 60 * 1000) {
    publicReplayTokens.delete(token);
    return null;
  }
  return entry.sessionId;
}

export function registerGalleryRoutes(api: Hono, deps: RouteDeps): void {
  const { launcher, wsBridge, sessionStore } = deps;

  api.get("/gallery", (c) => {
    const filter: GalleryFilter = {};
    const backend = c.req.query("backend");
    if (backend) filter.backend = backend as BackendType;
    const minCost = c.req.query("minCost");
    if (minCost) filter.minCost = Number(minCost);
    const maxCost = c.req.query("maxCost");
    if (maxCost) filter.maxCost = Number(maxCost);
    const tags = c.req.query("tags");
    if (tags) filter.tags = tags.split(",").filter(Boolean);
    const featured = c.req.query("featured");
    if (featured === "true") filter.featuredOnly = true;
    const sortBy = c.req.query("sortBy");
    if (sortBy) filter.sortBy = sortBy as GalleryFilter["sortBy"];
    const sortOrder = c.req.query("sortOrder");
    if (sortOrder) filter.sortOrder = sortOrder as "asc" | "desc";
    return c.json(galleryStore.listEntries(filter));
  });

  api.get("/gallery/:id", (c) => {
    const entry = galleryStore.getEntry(c.req.param("id"));
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    return c.json(entry);
  });

  api.post("/gallery", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { sessionId, name, description, tags } = body;
    if (!sessionId || !name) {
      return c.json({ error: "sessionId and name are required" }, 400);
    }
    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const entry = galleryStore.createEntry(
        { sessionId, name, description: description || "", tags: tags || [] },
        {
          backendType: session.backendType,
          model: session.model,
          totalCostUsd: wsBridge.getSession(sessionId)?.state.total_cost_usd,
          totalLinesAdded: session.totalLinesAdded,
          totalLinesRemoved: session.totalLinesRemoved,
          numTurns: wsBridge.getSession(sessionId)?.state.num_turns,
          repoRoot: session.repoRoot,
          durationMs: Date.now() - session.createdAt,
        },
      );
      return c.json(entry, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  api.put("/gallery/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const entry = galleryStore.updateEntry(id, body);
      if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
      return c.json(entry);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  api.delete("/gallery/:id", (c) => {
    const id = c.req.param("id");
    const deleted = galleryStore.deleteEntry(id);
    if (!deleted) return c.json({ error: "Gallery entry not found" }, 404);
    galleryVotes.removeEntryVotes(id);
    return c.json({ ok: true });
  });

  api.post("/gallery/:id/vote", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "anonymous";
    const voterId = galleryVotes.getVoterHash(ip);
    const direction = body.direction === -1 ? -1 : 1;
    const newTotal = galleryVotes.recordVote(id, voterId, direction as 1 | -1);
    galleryStore.updateEntry(id, { votes: newTotal });
    return c.json({ votes: newTotal });
  });

  api.post("/gallery/:id/feature", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    const updated = galleryStore.updateEntry(id, { featured: !entry.featured });
    return c.json(updated);
  });

  // ─── ClawHub Integration ────────────────────────────────────────────
  api.get("/clawhub/status", (c) => {
    return c.json({ available: clawhubExport.checkClawHubAvailable() });
  });

  api.post("/gallery/:id/export-clawhub", async (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed. Run: npm install -g clawhub" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const result = clawhubExport.exportToClawHub(entry, {
      campfireBaseUrl: body.campfireBaseUrl,
      prompt: body.prompt,
      dryRun: body.dryRun === true,
    });
    if (result.success) {
      return c.json({ ok: true, skillDir: result.skillDir, output: result.output });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  api.get("/gallery/:id/skill-preview", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    const markdown = clawhubExport.generateSkillMd(entry, {
      campfireBaseUrl: c.req.query("baseUrl"),
    });
    return c.json({ markdown });
  });

  api.get("/clawhub/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);
    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed" }, 400);
    }
    const results = clawhubExport.searchClawHub(query);
    return c.json(results);
  });

  api.post("/clawhub/install", async (c) => {
    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const slug = body.slug;
    if (!slug) return c.json({ error: "slug is required" }, 400);
    const result = clawhubExport.installClawHubSkill(slug);
    if (result.success) {
      return c.json({ ok: true, output: result.output });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  // ─── Moltbook Integration ──────────────────────────────────────────
  api.get("/moltbook/status", async (c) => {
    const { moltbookApiKey } = settingsManager.getSettings();
    const moltbook = await import("../moltbook-client.js");
    const status = await moltbook.checkMoltbookStatus(moltbookApiKey);
    return c.json(status);
  });

  api.post("/gallery/:id/post-moltbook", async (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    const { moltbookApiKey } = settingsManager.getSettings();
    if (!moltbookApiKey) {
      return c.json({ error: "Moltbook API key not configured. Add it in Settings." }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const baseUrl = body.campfireBaseUrl || `http://localhost:3456`;
    const replayUrl = `${baseUrl}/#/replay/session/${entry.sessionId}`;
    const costStr = entry.totalCostUsd > 0 ? `$${entry.totalCostUsd.toFixed(2)}` : "free";
    const durationMin = Math.round(entry.durationMs / 60_000);
    const content = [
      entry.description || `Session: ${entry.name}`,
      "",
      `**Backend:** ${entry.backendType} | **Model:** ${entry.model} | **Cost:** ${costStr} | **Duration:** ${durationMin}m | **Turns:** ${entry.numTurns}`,
      "",
      entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    const moltbook = await import("../moltbook-client.js");
    const result = await moltbook.postToMoltbook({
      apiKey: moltbookApiKey,
      title: entry.name,
      content,
      replayUrl,
      submolt: body.submolt || "general",
    });
    if (result.ok) {
      return c.json({ ok: true, postUrl: result.postUrl, postId: result.postId });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  // ─── Public Replay ────────────────────────────────────────────────
  api.post("/gallery/:id/public-link", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    const token = generatePublicReplayToken(entry.sessionId);
    return c.json({ token, url: `/#/public-replay/${token}` });
  });

  api.get("/public-replay/:token", (c) => {
    const token = c.req.param("token");
    const sessionId = resolvePublicReplayToken(token);
    if (!sessionId) {
      return c.json({ error: "Invalid or expired replay link" }, 404);
    }
    const persisted = sessionStore.load(sessionId);
    if (!persisted) return c.json({ error: "Session data not found" }, 404);
    const entries = galleryStore.listEntries();
    const galleryEntry = entries.find((e) => e.sessionId === sessionId);
    return c.json({
      messages: persisted.messageHistory || [],
      state: persisted.state || null,
      gallery: galleryEntry
        ? {
            name: galleryEntry.name,
            description: galleryEntry.description,
            backendType: galleryEntry.backendType,
            model: galleryEntry.model,
            totalCostUsd: galleryEntry.totalCostUsd,
            durationMs: galleryEntry.durationMs,
            numTurns: galleryEntry.numTurns,
            tags: galleryEntry.tags,
          }
        : null,
    });
  });
}

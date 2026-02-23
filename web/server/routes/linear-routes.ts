import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { getSettings } from "../settings-manager.js";
import * as linearProjectManager from "../linear-project-manager.js";
import * as sessionLinearIssues from "../session-linear-issues.js";

export function registerLinearRoutes(api: Hono, _deps: RouteDeps): void {
  api.get("/linear/connection", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ connected: false });
    }
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `query { viewer { id name email } teams { nodes { id key name } } }`,
        }),
      });
      const data = await res.json() as { data?: { viewer?: { name: string; email: string }; teams?: { nodes: Array<{ id: string; key: string; name: string }> } }; errors?: unknown[] };
      if (data.errors || !data.data?.viewer) {
        return c.json({ connected: false });
      }
      return c.json({
        connected: true,
        viewer: data.data.viewer,
        teams: data.data.teams?.nodes ?? [],
      });
    } catch {
      return c.json({ connected: false });
    }
  });

  api.get("/linear/issues", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    const query = c.req.query("query") ?? "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 50);
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `
            query SearchIssues($query: String!, $first: Int!) {
              issueSearch(query: $query, first: $first) {
                nodes {
                  id
                  identifier
                  title
                  url
                  state { name }
                  team { id key name }
                }
              }
            }
          `,
          variables: { query, first: limit },
        }),
      });
      const data = await res.json() as { data?: { issueSearch?: { nodes: unknown[] } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ issues: data.data?.issueSearch?.nodes ?? [] });
    } catch (e) {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  api.get("/linear/teams", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `query { teams { nodes { id key name } } }`,
        }),
      });
      const data = await res.json() as { data?: { teams?: { nodes: unknown[] } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ teams: data.data?.teams?.nodes ?? [] });
    } catch {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  api.get("/linear/team/:id/states", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    const teamId = c.req.param("id");
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `
            query TeamStates($teamId: String!) {
              team(id: $teamId) {
                states { nodes { id name type position } }
              }
            }
          `,
          variables: { teamId },
        }),
      });
      const data = await res.json() as { data?: { team?: { states?: { nodes: unknown[] } } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ states: data.data?.team?.states?.nodes ?? [] });
    } catch {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  api.get("/linear/projects", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `query { projects { nodes { id name state } } }`,
        }),
      });
      const data = await res.json() as { data?: { projects?: { nodes: unknown[] } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ projects: data.data?.projects?.nodes ?? [] });
    } catch {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  api.post("/linear/issues/:id/transition", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    const issueId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { stateId } = body;
    if (!stateId) return c.json({ error: "stateId is required" }, 400);
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `
            mutation TransitionIssue($issueId: String!, $stateId: String!) {
              issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                success
                issue { id identifier state { name } }
              }
            }
          `,
          variables: { issueId, stateId },
        }),
      });
      const data = await res.json() as { data?: { issueUpdate?: { success: boolean; issue?: unknown } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ ok: data.data?.issueUpdate?.success ?? false, issue: data.data?.issueUpdate?.issue });
    } catch {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  // ─── Project-repo mapping ──────────────────────────────────────────
  api.get("/linear/project-mapping", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (repoRoot) {
      const mapping = linearProjectManager.getProjectForRepo(repoRoot);
      return c.json({ mapping });
    }
    return c.json({ mappings: linearProjectManager.listMappings() });
  });

  api.post("/linear/project-mapping", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, teamId, teamKey, teamName, projectId, projectName } = body;
    if (!repoRoot || !teamId || !teamKey || !teamName) {
      return c.json({ error: "repoRoot, teamId, teamKey, and teamName are required" }, 400);
    }
    const mapping = linearProjectManager.setProjectForRepo(repoRoot, {
      teamId, teamKey, teamName, projectId, projectName,
    });
    return c.json({ mapping });
  });

  api.delete("/linear/project-mapping", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot } = body;
    if (!repoRoot) return c.json({ error: "repoRoot is required" }, 400);
    const removed = linearProjectManager.removeProjectMapping(repoRoot);
    if (!removed) return c.json({ error: "No mapping found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Session-issue linking ──────────────────────────────────────────
  api.post("/linear/session/:id/link-issue", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { issueId, identifier, title, url, state, teamKey } = body;
    if (!issueId || !identifier || !title) {
      return c.json({ error: "issueId, identifier, and title are required" }, 400);
    }
    const linked = sessionLinearIssues.linkIssueToSession(sessionId, {
      issueId, identifier, title, url: url || "", state: state || "", teamKey: teamKey || "",
    });
    return c.json({ linked });
  });

  api.get("/linear/session/:id/issue", (c) => {
    const sessionId = c.req.param("id");
    const issue = sessionLinearIssues.getLinkedIssue(sessionId);
    return c.json({ issue });
  });
}

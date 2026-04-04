import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { discoverCommandsAndSkills, readCommandContent } from "../commands-discovery.js";

// Cache for CLI-reported slash commands (populated on first request)
let cachedCliCommands: string[] | null = null;
let fetchingCliCommands = false;

function findCommandsFromSessions(wsBridge: RouteDeps["wsBridge"]): string[] | null {
  const sessions = wsBridge.getAllSessions();
  for (const session of sessions) {
    if (session.slash_commands && session.slash_commands.length > 0) {
      return session.slash_commands;
    }
  }
  return null;
}

async function fetchCommandsViaTempSession(launcher: RouteDeps["launcher"], wsBridge: RouteDeps["wsBridge"]): Promise<string[]> {
  const tempSession = launcher.launch({
    permissionMode: "default",
    cwd: process.cwd(),
    backendType: "claude",
  });

  const startTime = Date.now();
  let commands: string[] = [];
  while (Date.now() - startTime < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    const allSessions = wsBridge.getAllSessions();
    const tempState = allSessions.find((s) => s.session_id === tempSession.sessionId);
    if (tempState?.slash_commands && tempState.slash_commands.length > 0) {
      commands = tempState.slash_commands;
      break;
    }
  }

  await launcher.kill(tempSession.sessionId).catch(() => {});
  return commands;
}

export function registerCommandsRoutes(api: Hono, deps: RouteDeps): void {
  const { launcher, wsBridge } = deps;

  // Discover custom commands and skills for a given working directory
  api.get("/commands", (c) => {
    const cwd = c.req.query("cwd") || undefined;
    return c.json(discoverCommandsAndSkills(cwd));
  });

  // Read a specific command's full content
  api.get("/commands/read", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const content = readCommandContent(path);
    if (content === null) return c.json({ error: "File not found" }, 404);
    return c.json({ path, content });
  });

  // Get slash commands from the CLI (dynamic, not hardcoded).
  // Tries existing sessions first, then spins up a temporary one.
  api.get("/commands/slash", async (c) => {
    // 1. Try existing sessions
    const fromSession = findCommandsFromSessions(wsBridge);
    if (fromSession) {
      cachedCliCommands = fromSession;
      return c.json({ commands: fromSession, source: "session" });
    }

    // 2. Return cache
    if (cachedCliCommands) return c.json({ commands: cachedCliCommands, source: "cache" });

    // 3. Wait if another request is already fetching
    if (fetchingCliCommands) {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (cachedCliCommands) return c.json({ commands: cachedCliCommands, source: "cache" });
      }
      return c.json({ commands: [], source: "timeout" });
    }

    // 4. Spin up temp session
    fetchingCliCommands = true;
    try {
      const commands = await fetchCommandsViaTempSession(launcher, wsBridge);
      if (commands.length > 0) cachedCliCommands = commands;
      return c.json({ commands, source: commands.length > 0 ? "fetched" : "empty" });
    } catch {
      return c.json({ commands: [], source: "error" });
    } finally {
      fetchingCliCommands = false;
    }
  });
}

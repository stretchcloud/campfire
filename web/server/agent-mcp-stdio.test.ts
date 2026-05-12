import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

let proc: ChildProcessWithoutNullStreams | null = null;

function startServer(env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  proc = spawn("bun", ["server/agent-mcp-stdio.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return proc;
}

function readNdjson(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP response")), 2000);
    child.stdout.on("data", function onData(chunk: Buffer) {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      child.stdout.off("data", onData);
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

afterEach(() => {
  proc?.kill();
  proc = null;
});

describe("agent MCP stdio server", () => {
  it("responds to initialize over newline-delimited JSON-RPC", async () => {
    // Claude Code's dynamic stdio MCP path sends newline-delimited JSON-RPC.
    // A server that only parses Content-Length frames will hang until Claude's
    // MCP connection timeout elapses.
    const child = startServer();

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");

    const response = await readNdjson(child);
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: "campfire-agents" },
      },
    });
  });

  it("lists enabled ask tools over newline-delimited JSON-RPC", async () => {
    // This verifies the tool discovery request returns quickly with the
    // backend-filtered tools that the lead session should see.
    const child = startServer({ CAMPFIRE_AGENT_MCP_BACKENDS: "codex,goose" });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }) + "\n");

    const response = await readNdjson(child);
    const tools = ((response.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
    expect(tools).toEqual(["ask_codex", "ask_goose"]);
  });
});

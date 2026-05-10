#!/usr/bin/env bun
import { generateAgentToolDefinitions } from "./agent-mcp-tools.js";
import type { AgentToolDefinition } from "./agent-mcp-tools.js";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const url = process.env.CAMPFIRE_AGENT_MCP_URL || "http://127.0.0.1:4567/api/internal/agent-mcp";
const token = process.env.CAMPFIRE_AGENT_MCP_TOKEN || "";
const parentSessionId = process.env.CAMPFIRE_PARENT_SESSION_ID || "";
const backends = (process.env.CAMPFIRE_AGENT_MCP_BACKENDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as Array<AgentToolDefinition["backendType"]>;

function send(payload: unknown): void {
  const json = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`);
}

function respond(id: JsonRpcRequest["id"], result: unknown): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id: JsonRpcRequest["id"], code: number, message: string): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function mcpTools() {
  return generateAgentToolDefinitions(backends.length ? backends : undefined).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  }));
}

async function callTool(name: string, input: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await fetch(`${url}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ parentSessionId, toolName: name, input }),
  });
  const data = await res.json() as {
    text?: string;
    filesChanged?: string[];
    costUsd?: number;
    durationMs?: number;
    sessionId?: string;
    error?: string;
  };
  if (!res.ok || data.error) {
    return {
      isError: true,
      content: [{ type: "text", text: data.error || `Agent tool ${name} failed.` }],
    };
  }

  const files = data.filesChanged?.length ? `\n\nFiles changed:\n${data.filesChanged.map((f) => `- ${f}`).join("\n")}` : "";
  const metrics = `\n\nSub-session: ${data.sessionId || "unknown"}\nCost: $${(data.costUsd || 0).toFixed(4)}\nDuration: ${data.durationMs || 0}ms`;
  return {
    content: [{ type: "text", text: `${data.text || "Sub-agent completed without text output."}${files}${metrics}` }],
  };
}

async function handle(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "campfire-agents", version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      respond(req.id, { tools: mcpTools() });
      return;
    case "tools/call": {
      const params = req.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
      if (!name) {
        respondError(req.id, -32602, "Tool name is required.");
        return;
      }
      respond(req.id, await callTool(name, args));
      return;
    }
    default:
      if (req.id !== undefined && req.id !== null) respondError(req.id, -32601, `Unknown method: ${req.method || ""}`);
  }
}

let buffer = Buffer.alloc(0);

function consumeContentLengthFrames(): void {
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf-8");
    buffer = buffer.subarray(start + length);
    try {
      void handle(JSON.parse(body) as JsonRpcRequest);
    } catch (err) {
      process.stderr.write(`campfire-agents MCP parse error: ${err}\n`);
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  consumeContentLengthFrames();
});

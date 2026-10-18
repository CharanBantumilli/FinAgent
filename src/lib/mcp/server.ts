/**
 * Minimal, wire-faithful MCP JSON-RPC handler.
 * Supports: initialize, ping, tools/list, tools/call.
 * Exposed at POST /api/mcp; also used in-process by the engine.
 */

import { callTool, listTools, type ToolCtx } from "./tools";

const PROTOCOL_VERSION = "2024-11-05";

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleRpc(msg: Rpc, ctx: ToolCtx): Promise<object | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "finq-graph-mcp", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: listTools() });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args, ctx);
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (e) {
        return reply({
          content: [
            {
              type: "text",
              text: `tool error: ${e instanceof Error ? e.message : "unknown"}`,
            },
          ],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}

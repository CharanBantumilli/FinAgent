import { handleRpc } from "@/lib/mcp/server";
import { listTools } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

/** MCP streamable-HTTP style endpoint (stateless JSON-RPC). */
export async function GET() {
  return Response.json({
    name: "finq-graph-mcp",
    version: "1.0.0",
    transport: "json-rpc-over-http",
    methods: ["initialize", "ping", "tools/list", "tools/call"],
    tools: listTools(),
  });
}

export async function POST(req: Request) {
  const tenant = req.headers.get("x-tenant") || "desk-1";
  const ctx = { tenant, runId: `mcp-${Date.now()}` };
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  if (Array.isArray(body)) {
    const replies = [];
    for (const msg of body) {
      const r = await handleRpc(msg, ctx);
      if (r) replies.push(r);
    }
    return Response.json(replies);
  }
  const reply = await handleRpc(body, ctx);
  if (!reply) return new Response(null, { status: 202 });
  return Response.json(reply);
}

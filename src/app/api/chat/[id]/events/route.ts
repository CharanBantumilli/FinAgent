import { db } from "@/db";
import { events } from "@/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!Number.isFinite(sessionId) || !runId) {
    return Response.json({ error: "bad params" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), gt(events.id, after)))
    .orderBy(asc(events.id))
    .limit(400);
  return Response.json({ events: rows });
}

import { db } from "@/db";
import { chatMessages, chatSessions } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isFinite(sessionId)) {
    return Response.json({ error: "bad id" }, { status: 400 });
  }
  const session = (
    await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId))
  )[0];
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.id))
    .limit(200);
  return Response.json({ session, messages });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isFinite(sessionId)) {
    return Response.json({ error: "bad id" }, { status: 400 });
  }
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
  return Response.json({ ok: true });
}

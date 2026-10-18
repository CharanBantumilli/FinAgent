import { db } from "@/db";
import { agents } from "@/db/schema";
import { asc } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const rows = await db.select().from(agents).orderBy(asc(agents.id));
  return Response.json({ agents: rows });
}

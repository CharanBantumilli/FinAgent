import { ensureSeed, wipeAll } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode === "wipe") {
    await wipeAll();
    return Response.json({ ok: true, mode: "wipe" });
  }
  await wipeAll();
  await ensureSeed();
  return Response.json({ ok: true, mode: "reseed" });
}

import { graphRun } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key) return Response.json({ error: "key required" }, { status: 400 });
  const r = await graphRun("exploreNeighborhood", { key });
  return Response.json({ result: r.data, mode: r.mode });
}

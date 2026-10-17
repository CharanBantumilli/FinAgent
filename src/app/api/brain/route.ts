import { graphRun } from "@/lib/graph";
import { embeddedStore } from "@/lib/graph/embedded";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const org = await graphRun<unknown[]>("orgOverview", {});
  const decisions = await graphRun<unknown[]>("decisionsAbout", { q: "" });
  const docs = (await embeddedStore.allNodes("global", "Document")).map((d) => d.props);
  const people = (await embeddedStore.allNodes("global", "Person")).map((d) => d.props);
  return Response.json({
    org: org.data,
    decisions: decisions.data,
    documents: docs,
    people,
  });
}

export async function POST(req: Request) {
  await ensureSeed();
  const body = (await req.json()) as Record<string, unknown>;
  const type = String(body.type ?? "");
  if (type === "document") {
    const title = String(body.title ?? "").trim();
    const bodyText = String(body.body ?? "");
    if (!title) return Response.json({ error: "title required" }, { status: 400 });
    const key = `Document:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    const r = await graphRun("ingestDocument", {
      key,
      title,
      body: bodyText,
      date: new Date().toISOString().slice(0, 10),
    });
    return Response.json({ ok: true, result: r.data }, { status: 201 });
  }
  if (type === "decision") {
    const title = String(body.title ?? "").trim();
    if (!title) return Response.json({ error: "title required" }, { status: 400 });
    const key = `Decision:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    const r = await graphRun("recordDecision", { key, ...body });
    return Response.json({ ok: true, result: r.data }, { status: 201 });
  }
  if (type === "person") {
    const name = String(body.name ?? "").trim();
    const team = String(body.team ?? "");
    if (!name) return Response.json({ error: "name required" }, { status: 400 });
    await embeddedStore.upsertNode("global", "Person", `Person:${name}`, {
      name,
      role: String(body.role ?? "Analyst"),
    });
    if (team) {
      const p = await embeddedStore.nodeByKey("global", `Person:${name}`);
      const t = await embeddedStore.nodeByKey("global", `Team:${team}`);
      if (p && t) await embeddedStore.addEdge("global", p.id, t.id, "MEMBER_OF", {});
    }
    return Response.json({ ok: true }, { status: 201 });
  }
  return Response.json({ error: "unknown type" }, { status: 400 });
}

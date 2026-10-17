import { graphStatus, graphRun } from "@/lib/graph";
import { embeddedStore } from "@/lib/graph/embedded";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const status = await graphStatus();
  const overview = await graphRun<{
    byLabel: Record<string, number>;
    byType: Record<string, number>;
    total: number;
    edgeTotal: number;
  }>("graphOverview");

  // viz sample (embedded compatibility mode serves the same shapes)
  const nodes = (await embeddedStore.allNodes(null)).slice(0, 160);
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = (await embeddedStore.allEdges(null))
    .filter((e) => idSet.has(e.src) && idSet.has(e.dst))
    .slice(0, 300);
  const idToIndex = new Map(nodes.map((n, i) => [n.id, i]));

  return Response.json({
    status,
    overview: overview.data,
    viz: {
      nodes: nodes.map((n) => ({
        key: n.key,
        label: n.label,
        name: String(n.props.ticker ?? n.props.name ?? n.props.title ?? n.key),
        props: n.props,
      })),
      edges: edges.map((e) => ({
        from: idToIndex.get(e.src),
        to: idToIndex.get(e.dst),
        type: e.type,
      })),
    },
  });
}

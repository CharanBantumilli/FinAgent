import { db } from "@/db";
import { graphEdges, graphNodes, type GraphNodeRow } from "@/db/schema";
import { and, eq, ne, type SQL } from "drizzle-orm";
import type { EdgeRec, EmbeddedStore, NodeRec, Params } from "./queries";

function toNode(r: GraphNodeRow): NodeRec {
  return { id: r.id, tenant: r.tenant, label: r.label, key: r.nodeKey, props: r.props };
}

/** Postgres-backed implementation of the graph store (FalkorDB compatibility). */
export const embeddedStore: EmbeddedStore = {
  async allNodes(tenant, label) {
    const conds: SQL[] = [];
    if (tenant) conds.push(eq(graphNodes.tenant, tenant));
    else conds.push(ne(graphNodes.label, "__never__")); // all tenants
    if (label) conds.push(eq(graphNodes.label, label));
    const rows = await db
      .select()
      .from(graphNodes)
      .where(conds.length ? and(...conds) : undefined)
      .limit(5000);
    return rows.map(toNode);
  },

  async allEdges(tenant) {
    // When tenant is null we need ALL edges; when scoped, edges of that tenant
    // plus the shared global graph.
    const rows = tenant
      ? await db
          .select()
          .from(graphEdges)
          .where(eq(graphEdges.tenant, tenant))
          .limit(20000)
      : await db.select().from(graphEdges).limit(20000);
    return rows.map((r) => ({
      id: r.id,
      src: r.src,
      dst: r.dst,
      type: r.type,
      props: r.props,
    }));
  },

  async nodeByKey(tenant, key) {
    const rows = await db
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.tenant, tenant), eq(graphNodes.nodeKey, key)))
      .limit(1);
    return rows[0] ? toNode(rows[0]) : null;
  },

  async upsertNode(tenant, label, key, props) {
    const existing = await db
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.tenant, tenant), eq(graphNodes.nodeKey, key)))
      .limit(1);
    if (existing[0]) {
      const merged = { ...(existing[0].props as Params), ...props };
      const [row] = await db
        .update(graphNodes)
        .set({ props: merged, updatedAt: new Date() })
        .where(eq(graphNodes.id, existing[0].id))
        .returning();
      return toNode(row);
    }
    const [row] = await db
      .insert(graphNodes)
      .values({ tenant, label, nodeKey: key, props })
      .returning();
    return toNode(row);
  },

  async addEdge(tenant, srcId, dstId, type, props) {
    // dedupe exact (src,dst,type)
    const dup = await db
      .select({ id: graphEdges.id })
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.tenant, tenant),
          eq(graphEdges.src, srcId),
          eq(graphEdges.dst, dstId),
          eq(graphEdges.type, type),
        ),
      )
      .limit(1);
    if (dup[0]) return;
    await db.insert(graphEdges).values({ tenant, src: srcId, dst: dstId, type, props });
  },
};

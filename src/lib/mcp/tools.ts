/**
 * MCP tool plane — every capability the agents can select.
 * Tools are exposed over a real MCP JSON-RPC endpoint (/api/mcp)
 * AND consumed in-process by the LangGraph engine through the
 * same registry, so "tool selection via MCP" is literal.
 */

import { z } from "zod";
import { graphRun } from "@/lib/graph";
import { getHistory, getQuote, getQuotes } from "@/lib/market";

export interface ToolCtx {
  tenant: string;
  runId: string;
}

export interface Source {
  id: string;
  label: string;
}

export interface ToolResult {
  summary: string;
  data: unknown;
  sources: Source[];
  graphTouched: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
  jsonSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

/** tiny zod→JSON-schema for our subset */
function toJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    let t = v;
    let optional = false;
    if (t instanceof z.ZodOptional) {
      optional = true;
      t = t.unwrap();
    }
    let desc = "";
    if (t.description) desc = t.description;
    let base: Record<string, unknown>;
    if (t instanceof z.ZodString) base = { type: "string" };
    else if (t instanceof z.ZodNumber) base = { type: "number" };
    else if (t instanceof z.ZodBoolean) base = { type: "boolean" };
    else if (t instanceof z.ZodArray)
      base = {
        type: "array",
        items:
          t.element instanceof z.ZodNumber ? { type: "number" } : { type: "string" },
      };
    else base = { type: "string" };
    if (desc) base.description = desc;
    props[k] = base;
    if (!optional) required.push(k);
  }
  return { type: "object", properties: props, required };
}

function def(
  name: string,
  description: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: Record<string, z.ZodTypeAny>,
  run: ToolDef["run"],
): ToolDef {
  return {
    name,
    description,
    schema: z.object(shape),
    jsonSchema: toJsonSchema(shape),
    run,
  };
}

const TICKER = z.string().describe("Stock ticker, e.g. AAPL");

export const TOOLS: ToolDef[] = [
  def(
    "get_quote",
    "Real-time quote for one or more tickers (persisted into the graph as Quote nodes).",
    { tickers: z.array(z.string()).describe("Tickers, e.g. [\"AAPL\",\"MSFT\"]") },
    async (args) => {
      const quotes = await getQuotes(args.tickers as string[]);
      for (const q of quotes) {
        await graphRun("putQuote", {
          ticker: q.ticker,
          price: q.price,
          changePct: q.changePct,
          ts: q.ts,
          source: q.source,
        });
      }
      return {
        summary: quotes
          .map((q) => `${q.ticker} $${q.price} (${q.changePct >= 0 ? "+" : ""}${q.changePct}%, ${q.source})`)
          .join(" · "),
        data: quotes,
        sources: quotes.map((q, i) => ({
          id: `S${i + 1}`,
          label: `${q.ticker} quote · ${q.source === "stooq-delayed" ? "stooq delayed feed" : "simulated feed"}`,
        })),
        graphTouched: true,
      };
    },
  ),

  def(
    "get_history",
    "Daily close history for a ticker (default 60 sessions).",
    { ticker: TICKER, days: z.number().optional().describe("Lookback days, default 60") },
    async (args) => {
      const h = await getHistory(String(args.ticker), Number(args.days ?? 60));
      const pts = h.points;
      const first = pts[0]?.close ?? 0;
      const last = pts[pts.length - 1]?.close ?? 0;
      const change = first ? ((last - first) / first) * 100 : 0;
      return {
        summary: `${args.ticker} ${pts.length} sessions: ${first} → ${last} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%)`,
        data: h,
        sources: [{ id: "S1", label: `${args.ticker} daily closes · ${h.source}` }],
        graphTouched: false,
      };
    },
  ),

  def(
    "company_profile",
    "Company fundamentals profile from the knowledge graph (searched by name or ticker).",
    { query: z.string().describe("Ticker or company name fragment") },
    async (args) => {
      const q = String(args.query).toUpperCase().replace(/[^A-Z0-9.]/g, "");
      let rows = q.length >= 1 && q.length <= 6
        ? await graphRun("companyProfile", { ticker: q })
        : { data: null };
      let profile = rows.data as Record<string, unknown> | null;
      if (!profile) {
        const found = await graphRun<Record<string, unknown>[]>("searchCompanies", { q: args.query });
        profile = found.data?.[0] ?? null;
      }
      if (!profile)
        return {
          summary: `No company in the knowledge graph matches "${args.query}".`,
          data: null,
          sources: [],
          graphTouched: true,
        };
      return {
        summary: `${profile.name} (${profile.ticker}) — ${profile.sector}; mkt cap ~$${profile.marketCapB}B`,
        data: profile,
        sources: [{ id: "S1", label: "Company node · knowledge graph" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_peers",
    "Graph: competitors + same-sector peers via multi-hop IN_SECTOR traversal.",
    { ticker: TICKER },
    async (args) => {
      const [peers, sector] = await Promise.all([
        graphRun<Record<string, unknown>[]>("peersOf", { ticker: args.ticker }),
        graphRun<Record<string, unknown>[]>("sectorPeers", { ticker: args.ticker }),
      ]);
      return {
        summary: `${args.ticker}: ${peers.data.length} direct rivals, ${sector.data.length} sector peers (2-hop)`,
        data: { rivals: peers.data, sectorPeers: sector.data },
        sources: [
          { id: "S1", label: "COMPETES_WITH traversal" },
          { id: "S2", label: "IN_SECTOR 2-hop traversal" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_supply_chain",
    "Graph: suppliers (upstream) and customers (downstream) via SUPPLIES edges.",
    { ticker: TICKER },
    async (args) => {
      const r = await graphRun<{ suppliers: unknown[]; customers: unknown[] }[]>(
        "supplyChain",
        { ticker: args.ticker },
      );
      const row = r.data[0] ?? { suppliers: [], customers: [] };
      return {
        summary: `${args.ticker} supply chain: ${row.suppliers.length} suppliers → ${row.customers.length} customers`,
        data: row,
        sources: [{ id: "S1", label: "SUPPLIES graph traversal" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_risk_paths",
    "Track 1 multi-hop action: every company that depends on this one through the supply web (up to 3 hops), with readable chains.",
    { ticker: TICKER },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("riskPropagation", {
        ticker: args.ticker,
      });
      return {
        summary: `${args.ticker} disruption propagates to ${r.data.length} dependent companies within 3 hops`,
        data: r.data,
        sources: [{ id: "S1", label: "SUPPLIES*1..3 variable-length traversal" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_path",
    "Graph: shortest relationship path between two companies (explainability).",
    { a: z.string(), b: z.string() },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("pathBetween", {
        a: args.a,
        b: args.b,
      });
      return {
        summary: r.data.length
          ? `${args.a} ↔ ${args.b}: ${r.data[0].hops} hop(s)`
          : `No path found between ${args.a} and ${args.b}`,
        data: r.data,
        sources: [{ id: "S1", label: "shortestPath(..)-style BFS" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_centrality",
    "Graph algorithm: degree centrality ranking of the most connected companies.",
    {},
    async () => {
      const r = await graphRun<Record<string, unknown>[]>("centrality", {});
      return {
        summary: `Most connected: ${r.data.slice(0, 3).map((c) => c.ticker).join(", ")}`,
        data: r.data,
        sources: [{ id: "S1", label: "degree centrality over full graph" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_decisions",
    "Company Brain: decisions matching a topic, each traced to source documents and deciders (provenance).",
    { topic: z.string() },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("decisionsAbout", {
        q: args.topic,
      });
      return {
        summary: `${r.data.length} decision(s) found about "${args.topic}"`,
        data: r.data,
        sources: [
          { id: "S1", label: "Decision nodes" },
          { id: "S2", label: "DERIVED_FROM document provenance" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_who_knows",
    "Company Brain: who owns/knows what — people linked to teams, projects, docs about a topic.",
    { topic: z.string() },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("whoKnows", {
        q: args.topic,
      });
      return {
        summary: `${r.data.length} ownership/expertise link(s) for "${args.topic}"`,
        data: r.data,
        sources: [
          { id: "S1", label: "MEMBER_OF / LEADS / WORKS_ON / AUTHORED edges" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_org",
    "Company Brain: org overview — teams, members, projects, and who leads what.",
    {},
    async () => {
      const r = await graphRun<Record<string, unknown>[]>("orgOverview", {});
      return {
        summary: `${r.data.length} teams on the org graph`,
        data: r.data,
        sources: [{ id: "S1", label: "org graph (Team/Person/Project)" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_ingest_document",
    "Company Brain: ingest a document into the graph; auto-links mentions of known companies.",
    {
      title: z.string(),
      body: z.string(),
    },
    async (args, ctx) => {
      const key = `Document:${String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
      const r = await graphRun<{ mentioned: string[] }>("ingestDocument", {
        key,
        title: args.title,
        body: args.body,
        ingestedBy: ctx.runId,
        date: new Date().toISOString().slice(0, 10),
      });
      return {
        summary: `Ingested "${args.title}" — linked mentions: ${r.data.mentioned.join(", ") || "none"}`,
        data: r.data,
        sources: [{ id: "S1", label: `Document node ${key}` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_record_decision",
    "Company Brain: record a decision with rationale; auto-links companies, source docs, decider.",
    {
      title: z.string(),
      rationale: z.string(),
      decidedBy: z.string().optional(),
      sources: z.array(z.string()).optional(),
    },
    async (args) => {
      const key = `Decision:${String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
      const r = await graphRun<{ mentioned: string[] }>("recordDecision", {
        key,
        ...args,
      });
      return {
        summary: `Decision recorded: "${args.title}" (mentions: ${r.data.mentioned.join(", ") || "—"})`,
        data: r.data,
        sources: [{ id: "S1", label: `Decision node ${key}` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "memory_recall",
    "Track 2: recall across sessions — episodic (past messages) + semantic/procedural memory for this tenant.",
    { query: z.string() },
    async (args, ctx) => {
      const [episodic, semantic] = await Promise.all([
        graphRun<Record<string, unknown>[]>("recallEpisodes", {
          tenant: ctx.tenant,
          q: args.query,
        }),
        graphRun<Record<string, unknown>[]>("recallMemory", {
          tenant: ctx.tenant,
          q: args.query,
        }),
      ]);
      const q = String(args.query).trim().toLowerCase();
      const eps = episodic.data.filter(
        (e) => String(e.content ?? "").trim().toLowerCase() !== q,
      );
      return {
        summary: `Recall "${args.query}": ${eps.length} episode(s), ${semantic.data.length} memory item(s)`,
        data: { episodic: eps, semantic: semantic.data },
        sources: [
          { id: "S1", label: "Episodic memory (Episode nodes)" },
          { id: "S2", label: "Semantic/procedural memory (Memory nodes)" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "memory_store",
    "Track 2: persist a fact ('semantic') or a how-to ('procedural') into long-term graph memory for this tenant.",
    {
      text: z.string(),
      kind: z.string().describe("semantic | procedural"),
      topic: z.string().optional(),
    },
    async (args, ctx) => {
      const kind = String(args.kind).toLowerCase().includes("proc")
        ? "procedural"
        : "semantic";
      const key = `Memory:${ctx.tenant}:${Buffer.from(String(args.text)).toString("base64url").slice(0, 40)}`;
      const r = await graphRun<{ confidence: number }>("putMemory", {
        key,
        tenant: ctx.tenant,
        kind,
        text: args.text,
        topic: args.topic ?? "",
        ts: Date.now(),
      });
      return {
        summary: `Stored ${kind} memory (confidence ${r.data.confidence})`,
        data: r.data,
        sources: [{ id: "S1", label: `Memory node (${kind})` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "list_procedures",
    "Track 2: list procedural memory — how the desk does things.",
    {},
    async (_args, ctx) => {
      const r = await graphRun<Record<string, unknown>[]>("listMemory", {
        tenant: ctx.tenant,
        kind: "procedural",
      });
      return {
        summary: `${r.data.length} procedure(s) in memory`,
        data: r.data,
        sources: [{ id: "S1", label: "Memory nodes (kind=procedural)" }],
        graphTouched: true,
      };
    },
  ),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  }));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  const parsed = t.schema.safeParse(args);
  const clean = parsed.success ? parsed.data : args;
  return t.run(clean as Record<string, unknown>, ctx);
}

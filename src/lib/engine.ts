/**
 * FINQ engine — a LangGraph StateGraph multi-agent pipeline.
 *
 *   START → supervisor ──► memory(recall)
 *                    └──► market ─► graph ─► brain   (conditional, per plan)
 *                          └──────────────► synthesize → scribe → END
 *
 * - Tool selection goes through the MCP tool plane (literal MCP).
 * - Every node hands off via shared state + graph/telemetry events.
 * - Memory is recalled before specialists run and scribed after.
 * - The LLM (LangChain ChatOllama) refines routing and prose when
 *   a local runtime is up; a deterministic policy router and
 *   template synthesizer carry the desk otherwise.
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { db } from "@/db";
import { agents, chatMessages, events } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { callTool, listTools, type Source } from "./mcp/tools";
import { graphRun } from "./graph";
import { chatJson, chatText, ollamaUp } from "./llm";
import { ensureSeed } from "./seed";

/* ------------------------------ state ------------------------------ */

export interface Action {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface Artifact {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  sources: Source[];
}

export interface EngineInput {
  question: string;
  tenant: string;
  sessionId: number;
  runId: string;
}

const DeskState = Annotation.Root({
  question: Annotation<string>(),
  tenant: Annotation<string>(),
  sessionId: Annotation<number>(),
  runId: Annotation<string>(),
  llm: Annotation<boolean>(),
  routeReason: Annotation<string>(),
  plan: Annotation<string[]>(),
  actions: Annotation<Action[]>(),
  recalled: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  artifacts: Annotation<Artifact[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  answer: Annotation<string>(),
  sources: Annotation<Source[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

type Desk = typeof DeskState.State;

/* --------------------------- telemetry ----------------------------- */

async function emit(
  runId: string,
  sessionId: number,
  agent: string,
  kind: string,
  content: string,
) {
  await db.insert(events).values({ runId, sessionId, agent, kind, content });
}

async function bumpAgent(key: string) {
  await db
    .update(agents)
    .set({ runs: sql`${agents.runs} + 1` })
    .where(eq(agents.key, key));
}

/* ------------------------- intent parsing -------------------------- */

const NAME_MAP: Record<string, string> = {
  apple: "AAPL", microsoft: "MSFT", nvidia: "NVDA", alphabet: "GOOGL",
  google: "GOOGL", amazon: "AMZN", meta: "META", facebook: "META",
  tesla: "TSLA", amd: "AMD", intel: "INTC", broadcom: "AVGO",
  tsmc: "TSM", tsm: "TSM", "taiwan semi": "TSM", asml: "ASML",
  oracle: "ORCL", salesforce: "CRM", netflix: "NFLX", disney: "DIS",
  jpmorgan: "JPM", "jp morgan": "JPM", chase: "JPM", exxon: "XOM",
  boeing: "BA", ge: "GE", palantir: "PLTR", coinbase: "COIN",
};

const TICKER_BLACKLIST = new Set(
  "A I IT IS AT US VS AND OR THE FOR TO OF IN ON BY AN AS BE DO WE MY ME NO NOT OK IF SO WHY WHO WHAT HOW WHEN ITS USD CFO CEO IPO ETF AI EV GDP ALL ANY CAN ARE WAS HAS HAD YOU YOUR OUR THEIR THIS THAT WITH FROM ABOUT INTO OVER AFTER".split(" "),
);

function extractTickers(question: string): string[] {
  const found: string[] = [];
  // explicit cashtags / uppercase symbols
  for (const m of question.matchAll(/\$?\b\b\b\b([A-Z]{1,5})\b/g)) {
    const t = m[1];
    if (!TICKER_BLACKLIST.has(t)) found.push(t);
  }
  const lower = question.toLowerCase();
  for (const [name, t] of Object.entries(NAME_MAP)) {
    if (lower.includes(name)) found.push(t);
  }
  return [...new Set(found)].slice(0, 5);
}

const TOPIC_STOP = new Set(
  "why did we decide to what when how who whom whose owns own is are the a an our on about tell me show list give please of for in at by and or vs with was were do does did it its this that company companies stock stocks decision decisions would should could can will shall look like walk through map out check review assess evaluate whats let lets".split(" "),
);

function topicWords(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOP.has(w))
    .slice(0, 4)
    .join(" ");
}

interface PlanOut {
  plan: string[];
  actions: Action[];
  reason: string;
}

function heuristicRoute(question: string, tickers: string[]): PlanOut {
  const q = question.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => q.includes(w));
  // topic = significant words INCLUDING ticker mentions, trigger phrases stripped
  const topic = topicWords(question) || question.slice(0, 60);
  const actions: Action[] = [];
  const plan = new Set<string>();
  const add = (a: Action) => {
    actions.push(a);
    plan.add(a.agent);
  };
  const t0 = tickers[0] ?? "";

  // --- memory ops
  if (has("remember that", "remember this", "note that", "store this", "keep in mind")) {
    add({
      agent: "memory",
      tool: "memory_store",
      args: {
        text: question.replace(/^.*?remember(?:\s+that|\s+this)?/i, "").trim() || question,
        kind: "semantic",
        topic: topic.slice(0, 60),
      },
      why: "user asked to persist a fact",
    });
  }
  if (has("how do we", "our procedure", "playbook", "procedures")) {
    add({ agent: "memory", tool: "list_procedures", args: {}, why: "procedural memory requested" });
  }
  if (has("what do you remember", "did i tell you", "did we note", "what did i say", "our note", "recall what", "do you remember")) {
    add({ agent: "memory", tool: "memory_recall", args: { query: topic }, why: "explicit memory recall" });
  }

  // --- brain ops
  if (has("ingest", "add document", "add this document") || q.startsWith("document:")) {
    const parts = question.split("|");
    add({
      agent: "brain",
      tool: "brain_ingest_document",
      args: {
        title: (parts[0].replace(/^.*?(ingest|document:)/i, "").trim() || "Untitled note").slice(0, 90),
        body: parts[1]?.trim() || question,
      },
      why: "document ingest requested",
    });
  } else if (has("record decision", "log decision", "we decided to", "decision:")) {
    add({
      agent: "brain",
      tool: "brain_record_decision",
      args: {
        title: question.replace(/^.*?(record decision|log decision|decision:)/i, "").trim().split("because")[0].slice(0, 90) || topic.slice(0, 90),
        rationale: question.split(/because/i)[1]?.trim() || question,
      },
      why: "decision capture requested",
    });
  }
  if (has("who owns", "who leads", "who is responsible", "who knows", "expert on", "who should i", "point person", "who works")) {
    add({ agent: "brain", tool: "brain_who_knows", args: { topic: topic || q }, why: "ownership/expertise lookup" });
  }
  if (has("org chart", "team structure", "who is on the team", "our teams", "org overview", "company structure")) {
    add({ agent: "brain", tool: "brain_org", args: {}, why: "org overview requested" });
  }
  if (has("why did we decide", "when did we decide", "our decision", "decisions on", "decision on", "decision log", "provenance", "rationale behind")) {
    add({ agent: "brain", tool: "brain_decisions", args: { topic: topic || t0 || q }, why: "decision provenance lookup" });
  }

  // --- graph ops
  if (t0 && has("supply chain", "supplier", "suppliers", "customer of", "upstream", "downstream")) {
    add({ agent: "graph", tool: "graph_supply_chain", args: { ticker: t0 }, why: "supply chain traversal" });
  }
  if (t0 && has("risk", "exposure", "contagion", "ripple", "fraud", "shock", "depends on", "dependent", "blow up", "blows up", "collapse")) {
    add({ agent: "graph", tool: "graph_risk_paths", args: { ticker: t0 }, why: "multi-hop risk propagation" });
    if (!actions.some((a) => a.tool === "graph_supply_chain"))
      add({ agent: "graph", tool: "graph_supply_chain", args: { ticker: t0 }, why: "risk context" });
  }
  if (t0 && has("competitor", "peers", "rivals", "rivalry", "landscape")) {
    add({ agent: "graph", tool: "graph_peers", args: { ticker: t0 }, why: "peer traversal" });
  }
  if (tickers.length >= 2 && has("connect", "path", "relationship between", "related", "link")) {
    add({ agent: "graph", tool: "graph_path", args: { a: tickers[0], b: tickers[1] }, why: "shortest path explainability" });
  }
  if (has("most connected", "most important", "systemic", "centrality", "who matters most")) {
    add({ agent: "graph", tool: "graph_centrality", args: {}, why: "graph algorithm" });
  }

  // --- market ops
  const wantsQuote = has("price", "quote", "trading at", "worth", "stock", "value", "how much", "level") || tickers.length > 0;
  const wantsHistory = has("history", "trend", "chart", "performance", "past", "month", "ytd", "momentum");
  if (tickers.length > 0 && (wantsQuote || wantsHistory)) {
    add({ agent: "market", tool: "get_quote", args: { tickers }, why: "fresh quotes" });
    if (wantsHistory)
      add({ agent: "market", tool: "get_history", args: { ticker: t0, days: 60 }, why: "60-session trend" });
  }

  // --- profile cover
  if (t0 && (actions.length === 0 || has("tell me about", "what is", "overview", "details", "profile", "fundamentals", "about"))) {
    add({ agent: "graph", tool: "company_profile", args: { query: t0 }, why: "graph profile" });
    if (!actions.some((a) => a.tool === "get_quote"))
      add({ agent: "market", tool: "get_quote", args: { tickers: [t0] }, why: "context quote" });
    if (!actions.some((a) => a.tool === "graph_peers"))
      add({ agent: "graph", tool: "graph_peers", args: { ticker: t0 }, why: "peer context" });
  }

  // --- last resorts
  if (actions.length === 0) {
    if (t0) {
      add({ agent: "graph", tool: "company_profile", args: { query: t0 }, why: "default profile" });
      add({ agent: "market", tool: "get_quote", args: { tickers: [t0] }, why: "default quote" });
    } else {
      add({ agent: "memory", tool: "memory_recall", args: { query: topic || question }, why: "memory-first fallback" });
      add({ agent: "brain", tool: "brain_org", args: {}, why: "org context fallback" });
    }
  }

  // memory recall is always part of the plan (runs first)
  const exec = ["market", "graph", "brain"].filter((a) => plan.has(a));
  return {
    plan: ["memory", ...exec, "synthesize"],
    actions,
    reason: "policy router (keyword + entity extraction)",
  };
}

async function llmRoute(question: string, tickers: string[], base: PlanOut): Promise<PlanOut> {
  try {
    const tools = listTools()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");
    const out = await chatJson<{ actions?: { tool: string; args: Record<string, unknown>; why?: string }[] }>({
      system:
        "You are the supervisor of a financial desk. Choose which MCP tools to call to answer the user. Reply ONLY with JSON: {\"actions\":[{\"tool\":\"name\",\"args\":{...},\"why\":\"short\"}]}. Pick between 1 and 6 actions. Tickers must be uppercase.",
      prompt: `User question: "${question}"\nDetected tickers: ${tickers.join(", ") || "none"}\n\nAvailable tools:\n${tools}`,
      temperature: 0.1,
    });
    const acts = (out.actions ?? [])
      .filter((a) => a && typeof a.tool === "string")
      .slice(0, 6)
      .map((a) => ({
        agent: agentForTool(a.tool),
        tool: a.tool,
        args: a.args ?? {},
        why: a.why ?? "llm plan",
      }));
    if (acts.length === 0) throw new Error("empty plan");
    const planAgents = ["memory", ...[...new Set(acts.map((a) => a.agent))], "synthesize"];
    return { plan: planAgents, actions: acts, reason: "LLM supervisor (ChatOllama)" };
  } catch {
    return base;
  }
}

function agentForTool(tool: string): string {
  if (tool.startsWith("get_")) return "market";
  if (tool.startsWith("graph_") || tool === "company_profile") return "graph";
  if (tool.startsWith("brain_")) return "brain";
  return "memory";
}

/* ------------------------------ nodes ------------------------------ */

async function supervisorNode(s: Desk): Promise<Partial<Desk>> {
  const state = s as EngineInput & { llm: boolean };
  await ensureSeed();
  const tickers = extractTickers(state.question);
  const heuristic = heuristicRoute(state.question, tickers);
  const { up } = await ollamaUp();
  const routed = up ? await llmRoute(state.question, tickers, heuristic) : heuristic;
  await emit(
    state.runId,
    state.sessionId,
    "ORCHESTRA",
    "route",
    `PLAN [${routed.plan.join(" → ")}] :: ${routed.reason}${tickers.length ? ` · entities: ${tickers.join(", ")}` : ""}`,
  );
  await bumpAgent("supervisor");
  return { plan: routed.plan, actions: routed.actions, llm: up, routeReason: routed.reason };
}

async function memoryNode(s: Desk): Promise<Partial<Desk>> {
  const recalled: string[] = [];
  await emit(s.runId, s.sessionId, "ARCHIVE", "handoff", "ORCHESTRA → ARCHIVE :: recall before reasoning");
  try {
    const r = await callTool(
      "memory_recall",
      { query: s.question.slice(0, 200) },
      { tenant: s.tenant, runId: s.runId },
    );
    const data = r.data as { episodic: { content: string }[]; semantic: { text: string; kind: string; confidence: number }[] };
    for (const e of data.episodic.slice(0, 3)) recalled.push(`episode: ${e.content.slice(0, 140)}`);
    for (const m of data.semantic.slice(0, 4)) recalled.push(`${m.kind}: ${m.text.slice(0, 140)}`);
    await emit(s.runId, s.sessionId, "ARCHIVE", "tool", `memory_recall :: ${r.summary}`);
  } catch (e) {
    await emit(s.runId, s.sessionId, "ARCHIVE", "error", `recall failed: ${msg(e)}`);
  }
  await bumpAgent("memory");
  return { recalled };
}

async function runAgentTools(s: Desk, agent: string): Promise<Artifact[]> {
  const mine = s.actions.filter((a) => a.agent === agent);
  const artifacts: Artifact[] = [];
  for (const a of mine) {
    const t0 = Date.now();
    try {
      const r = await callTool(a.tool, a.args, { tenant: s.tenant, runId: s.runId });
      await emit(
        s.runId,
        s.sessionId,
        agentName(agent),
        "tool",
        `MCP ${a.tool}(${shortArgs(a.args)}) → ${r.summary} [${Date.now() - t0}ms]`,
      );
      artifacts.push({ agent, tool: a.tool, args: a.args, summary: r.summary, data: r.data, sources: r.sources });
    } catch (e) {
      await emit(s.runId, s.sessionId, agentName(agent), "error", `MCP ${a.tool} failed: ${msg(e)}`);
    }
  }
  await bumpAgent(agent);
  return artifacts;
}

function agentName(a: string): string {
  return { market: "TICKER", graph: "TOPOLOGY", brain: "PROVENANCE" }[a] ?? a.toUpperCase();
}

function shortArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 80);
}

async function marketNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "TICKER", "handoff", "ARCHIVE → TICKER :: market plane via MCP");
  return { artifacts: await runAgentTools(s, "market") };
}

async function graphNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "TOPOLOGY", "handoff", "ARCHIVE → TOPOLOGY :: cypher traversals via MCP");
  return { artifacts: await runAgentTools(s, "graph") };
}

async function brainNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "PROVENANCE", "handoff", "ARCHIVE → PROVENANCE :: company brain via MCP");
  return { artifacts: await runAgentTools(s, "brain") };
}

/* --------------------------- synthesis ----------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isArr = (d: any): d is any[] => Array.isArray(d);

function renderQuotes(data: unknown[]): string {
  const rows = data
    .map((q) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const x = q as any;
      if (!x?.ticker) return null;
      const dir = Number(x.changePct) >= 0 ? "▲" : "▼";
      return `| ${x.ticker} | $${Number(x.price).toFixed(2)} | ${dir} ${Math.abs(Number(x.changePct)).toFixed(2)}% | ${x.source} |`;
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return [
    "### Live quotes",
    "| Ticker | Last | Session chg | Feed |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function synthDeterministic(s: Desk): { answer: string; sources: Source[] } {
  const parts: string[] = [];
  // stable source numbering: flatten first, cite by true index
  const flat: Source[] = [];
  const citeIdx = new Map<Artifact, number[]>();
  for (const a of s.artifacts) {
    citeIdx.set(a, a.sources.map((_, i) => flat.length + i + 1));
    flat.push(...a.sources);
  }
  const cite = (art: Artifact) => (citeIdx.get(art) ?? []).map((n) => `[S${n}]`).join(" ");

  for (const art of s.artifacts) {
    const d = art.data;
    switch (art.tool) {
      case "get_quote":
        if (isArr(d)) parts.push(renderQuotes(d));
        break;
      case "get_history": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pts = (d as any)?.points ?? [];
        if (pts.length) {
          const first = pts[0].close, last = pts[pts.length - 1].close;
          const min = Math.min(...pts.map((p: { close: number }) => p.close));
          const max = Math.max(...pts.map((p: { close: number }) => p.close));
          parts.push(
            `### 60-session trend\n${s.actions.find((a) => a.tool === "get_history")?.args?.ticker}: $${first} → **$${last}** (range $${min} – $${max}) ${cite(art)}\n`,
          );
        }
        break;
      }
      case "company_profile": {
        if (d) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = d as any;
          parts.push(
            `### ${p.name} (${p.ticker})\n${p.description}\n\n| Field | Value |\n| --- | --- |\n| Sector | ${p.sector} · ${p.industry} |\n| Market cap | ~$${p.marketCapB}B |\n| Employees | ~${Number(p.employees).toLocaleString()} |\n| Founded | ${p.founded} |\n${cite(art)}`,
          );
        } else parts.push(`_${art.summary}_`);
        break;
      }
      case "graph_peers": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rivals = (d as any)?.rivals ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sector = (d as any)?.sectorPeers ?? [];
        if (rivals.length)
          parts.push(`### Direct rivals (COMPETES_WITH)\n${rivals.map((r: { name: string; ticker: string; arena: string }) => `- **${r.name} (${r.ticker})** — arena: ${r.arena}`).join("\n")}`);
        if (sector.length)
          parts.push(`### Sector peers (2-hop via IN_SECTOR)\n${sector.map((r: { name: string; ticker: string }) => `${r.ticker}`).join(" · ")} ${cite(art)}`);
        break;
      }
      case "graph_supply_chain": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (isArr(d) ? d[0] : d) as any;
        const sup = row?.suppliers ?? [], cus = row?.customers ?? [];
        if (sup.length || cus.length) {
          parts.push(
            `### Supply web ${cite(art)}\n**Suppliers (upstream):**\n${sup.map((x: { ticker: string; name: string; component: string; criticality: number }) => `- **${x.ticker}** (${x.name}) — ${x.component} · criticality ${x.criticality}`).join("\n") || "- none on graph"}\n\n**Customers (downstream):**\n${cus.map((x: { ticker: string; name: string; component: string }) => `- **${x.ticker}** (${x.name}) — ${x.component}`).join("\n") || "- none on graph"}`,
          );
        }
        break;
      }
      case "graph_risk_paths": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Contagion map — who depends on this name ${cite(art)}\n${d.slice(0, 8).map((r: { readable: string; hops: number }) => `- \`${r.readable}\` (${r.hops} hop${r.hops > 1 ? "s" : ""})`).join("\n")}\n\n**Desk action:** hedges and exposure checks should prioritize the ${d.filter((x: { hops: number }) => x.hops === 1).length} first-order dependent(s) shown above.`,
          );
        } else parts.push("_No downstream dependents on the graph._");
        break;
      }
      case "graph_path": {
        if (isArr(d) && d.length)
          parts.push(`### Relationship path ${cite(art)}\n\`${d[0].readable}\`\n\n_${d[0].hops} hop(s) — every hop is a stated relationship edge._`);
        else parts.push("_No relationship path found between those two names on the graph._");
        break;
      }
      case "graph_centrality": {
        if (isArr(d)) {
          parts.push(
            `### Most connected companies (degree centrality) ${cite(art)}\n${d.slice(0, 6).map((c: { ticker: string; name: string; degree: number }, i: number) => `${i + 1}. **${c.ticker}** — ${c.degree} edges (${c.name})`).join("\n")}`,
          );
        }
        break;
      }
      case "brain_decisions": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Decision provenance ${cite(art)}\n${d.map((x: { title: string; date: string; status: string; rationale: string; sources: string[]; deciders: string[]; tickers: string[] }) => `**${x.title}** _(${x.date} · ${x.status})_\n${x.rationale}\n- decided by: ${x.deciders.join(", ") || "—"} · mentions: ${x.tickers.join(", ") || "—"}\n- derived from: ${x.sources.map((t: string) => `“${t}”`).join(", ") || "no documents linked (unprovenanced!)"}`).join("\n\n")}`,
          );
        } else parts.push("_No decisions found on that topic in the company brain._");
        break;
      }
      case "brain_who_knows": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Who owns / knows ${cite(art)}\n${d.map((x: { person: string; role: string; via: string; thing: string }) => `- **${x.person}** (${x.role}) — ${x.via.replace(/_/g, " ")} → ${x.thing}`).join("\n")}`,
          );
        } else parts.push("_Nobody formally connected to that topic yet — consider assigning an owner via the Brain page._");
        break;
      }
      case "brain_org": {
        if (isArr(d)) {
          parts.push(
            `### Org graph ${cite(art)}\n${d.map((t: { team: string; focus: string; members: string[]; projects: { name: string; status: string; lead: string | null }[] }) => `**${t.team}** — ${t.focus}\n- members: ${t.members.join(", ") || "—"}\n${t.projects.map((p) => `- project: ${p.name} (${p.status}${p.lead ? ` · lead ${p.lead}` : ""})`).join("\n")}`).join("\n\n")}`,
          );
        }
        break;
      }
      case "brain_ingest_document":
      case "brain_record_decision":
      case "memory_store":
        parts.push(`### Written to graph\n${art.summary} ${cite(art)}`);
        break;
      case "memory_recall": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eps = (d as any)?.episodic ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sem = (d as any)?.semantic ?? [];
        if (eps.length || sem.length) {
          const lines: string[] = [];
          for (const m of sem)
            lines.push(`- [${m.kind} · confidence ${m.confidence ?? 1}] ${m.text}`);
          for (const e of eps)
            lines.push(`- [${e.role} · past session] ${String(e.content).slice(0, 180)}`);
          parts.push(`### From memory ${cite(art)}\n${lines.join("\n")}`);
        } else parts.push("_Nothing in memory matches that yet._");
        break;
      }
      case "list_procedures": {
        if (isArr(d) && d.length)
          parts.push(
            `### Desk procedures (procedural memory) ${cite(art)}\n${d.map((p: { text: string }, i: number) => `${i + 1}. ${p.text}`).join("\n")}`,
          );
        else parts.push("_No procedures stored yet._");
        break;
      }
      default:
        parts.push(`_${art.summary}_`);
    }
  }

  if (s.recalled.length) {
    parts.unshift(
      `### Recalled from memory (Track 2)\n${s.recalled.map((r) => `- ${r}`).join("\n")}\n`,
    );
  }

  const trace = s.artifacts.map((a) => `${agentName(a.agent)}.${a.tool}`).join(" → ");
  parts.push(
    `---\n**Reasoning trace:** ORCHESTRA.route → ARCHIVE.recall${trace ? ` → ${trace}` : ""} → DESK-WRITER.synthesize · routed by _${s.routeReason}_`,
  );

  const body = parts.filter(Boolean).join("\n\n");
  return { answer: body || "I could not assemble anything for that — try a ticker, a company name, or \"who owns...\".", sources: flat };
}

async function synthesizeNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "DESK-WRITER", "handoff", "specialists → DESK-WRITER :: composing answer");
  const { answer, sources } = synthDeterministic(s);

  let final = answer;
  if (s.llm && s.artifacts.length) {
    try {
      const brief = await chatText({
        system:
          "You are a buy-side desk writer. Three sentences max, decisive, no hype. Lead with the number, then the relationship insight, then the action. Do not repeat the tables.",
        prompt: `Question: "${s.question}"\nArtifact summaries:\n${s.artifacts.map((a) => `- ${a.summary}`).join("\n")}`,
        temperature: 0.3,
        maxTokens: 220,
      });
      final = `### Desk view\n${brief.trim()}\n\n${answer}`;
    } catch {
      /* LLM optional */
    }
  }

  // flatten + renumber sources
  const flat: Source[] = [];
  for (const a of s.artifacts) flat.push(...a.sources);
  const srcBlock = flat.length
    ? `\n\n**Sources**\n${flat.map((x, i) => `[S${i + 1}] ${x.label}`).join("\n")}`
    : "";

  await emit(s.runId, s.sessionId, "DESK-WRITER", "answer", `answer composed :: ${flat.length} sources, ${s.artifacts.length} tool artifacts`);
  await bumpAgent("synth");
  return { answer: final + srcBlock, sources: flat };
}

async function scribeNode(s: Desk): Promise<Partial<Desk>> {
  // Track 2: persist episodic nodes (both turns) for the tenant
  const ts = Date.now();
  await graphRun("putEpisode", {
    key: `Episode:${s.runId}:a`,
    tenant: s.tenant,
    sessionId: s.sessionId,
    role: "assistant",
    content: s.answer.slice(0, 1500),
    ts,
  });
  await emit(s.runId, s.sessionId, "ARCHIVE", "memory", `episode stored :: session ${s.sessionId} (tenant ${s.tenant})`);
  return {};
}

/* ---------------------------- compile ------------------------------ */

function nextStep(s: Desk): string {
  const remaining = ["market", "graph", "brain"].filter((a) =>
    s.actions.some((act) => act.agent === a),
  );
  // order-preserving: market → graph → brain → synthesize
  for (const a of ["market", "graph", "brain"] as const) {
    if (remaining.includes(a) && !s.artifacts.some((art) => art.agent === a)) return a;
  }
  return "synthesize";
}

const workflow = new StateGraph(DeskState)
  .addNode("supervisor", supervisorNode)
  .addNode("memory", memoryNode)
  .addNode("market", marketNode)
  .addNode("graph", graphNode)
  .addNode("brain", brainNode)
  .addNode("synthesize", synthesizeNode)
  .addNode("scribe", scribeNode)
  .addEdge(START, "supervisor")
  .addEdge("supervisor", "memory")
  .addConditionalEdges("memory", nextStep, {
    market: "market",
    graph: "graph",
    brain: "brain",
    synthesize: "synthesize",
  })
  .addConditionalEdges("market", nextStep, {
    graph: "graph",
    brain: "brain",
    synthesize: "synthesize",
    market: "market",
  })
  .addConditionalEdges("graph", nextStep, {
    brain: "brain",
    synthesize: "synthesize",
    market: "market",
    graph: "graph",
  })
  .addConditionalEdges("brain", nextStep, {
    synthesize: "synthesize",
    market: "market",
    graph: "graph",
    brain: "brain",
  })
  .addEdge("synthesize", "scribe")
  .addEdge("scribe", END);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const compiled: any = workflow.compile();

export async function runEngine(input: EngineInput): Promise<{ answer: string }> {
  const out = (await compiled.invoke({
    ...input,
    recalled: [],
    artifacts: [],
    sources: [],
  })) as Desk;
  return { answer: out.answer };
}

/** Persist assistant message at the end of a run (called by the API). */
export async function saveAssistant(
  sessionId: number,
  runId: string,
  answer: string,
  sources: Source[],
) {
  await db.insert(chatMessages).values({
    sessionId,
    role: "assistant",
    content: answer,
    sources,
    runId,
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : "unknown";
}

# FinAGENT — Graph-Centred Autonomous Finance OS

A multi-agent financial desk where **FalkorDB is the brain**. Real-time
quotes, multi-hop relationship reasoning, persistent per-tenant agent memory,
and a fully provenanced company brain — orchestrated with **LangGraph +
LangChain**, tools selected through **MCP**.

```
        ┌─────────────────────── FalkorDB (Cypher) ────────────────────────┐
        │  Company─COMPETES_WITH─Company   Person─MEMBER_OF─Team          │
        │  Company─SUPPLIES→Company        Project─OWNED_BY→Team          │
        │  Fund─OWNS→Company               Decision─DERIVED_FROM→Document │
        │  Company─HAS_QUOTE→Quote         Memory / Episode (per tenant)  │
        └──────────────────────────────────────────────────────────────────┘
 user ─► ORCHESTRA ─► ARCHIVE (recall) ─► TICKER ─► TOPOLOGY ─► PROVENANCE
          (route)        (memory)          market     graph        brain
                            └──────────► DESK-WRITER (synthesize) ─► ARCHIVE (scribe)
                                   every tool call goes through MCP /api/mcp
```

## The three tracks

**Track 1 — Agents that act on connected data.** TOPOLOGY runs catalogued
Cypher as agent tools: competitor traversal, supply-chain expansion,
variable-length **contagion mapping** (`SUPPLIES*1..3`), shortest-path
explainability, and degree-centrality ranking. Actions are proposed from what
the graph shows (e.g. "hedge first-order dependents") and every result lists
the readable chain.

**Track 2 — Agent memory & coordination.** ARCHIVE writes every turn as an
`Episode` node, facts as `Memory` (semantic, deduped, confidence-counted) and
playbooks as procedural memory. All of it is per-tenant, shared across
agents via the engine's state handoffs, recalled **before** every answer.

**Track 3 — Company Brain.** People, teams, projects, documents and decisions
live in the same graph. PROVENANCE answers "who owns X", "who knows about Y",
and "why did we decide Z" with `DECIDED_BY` / `DERIVED_FROM` / `MENTIONS`
chains — ingest a doc and its company mentions auto-link.

## Run it

```bash
npm install
npx drizzle-kit push
npm run dev          # or build && start
```

Open http://localhost:3000 — the desk seeds itself: 6 agents, 20 companies,
funds, supply web, org brain, desk procedures.

### FalkorDB is the mind — already real on first boot

FalkorDB is the desk's required mind: every company, edge, quote, memory
and decision executes as Cypher on a real engine. Boot ladder:

1. **FALKORDB LIVE** — configured server (`FALKORDB_URL` / docker below)
2. **FALKORDB LITE** — auto-booted embedded real FalkorDB engine
   (`falkordblite`, vendored rootless Redis 8, persisted to `.data/falkordb`)
3. **DEGRADED** — Postgres compat store, emergency-only, red label

Fresh x86_64 Linux clone? Vendor the portable engine once:
`./scripts/bootstrap-falkordb.sh` (no sudo). Production/shared desk:

```bash
docker compose up -d falkordb       # or: docker run -p 6379:6379 falkordb/falkordb:latest
```

Save the endpoint in **Settings** (or `FALKORDB_URL`) and the server takes
priority automatically.

### Optional LLM plane

Start `ollama serve` + `ollama pull llama3.1:8b`. The supervisor's routing
and the desk-writer's summary then come from a local model via LangChain
`ChatOllama`; offline, a deterministic policy router and template
synthesizer carry the desk.

## MCP tool plane

`POST /api/mcp` — JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`),
stateless, per-tenant via `x-tenant` header. Sixteen tools including
`get_quote`, `graph_risk_paths`, `graph_supply_chain`, `brain_decisions`,
`memory_store`, `brain_ingest_document`. The LangGraph engine consumes the
identical registry in-process — tool selection is literally through MCP.

## CLI

```bash
node cli/finq.js status
node cli/finq.js ask "If TSMC blows up, who gets hurt?"
node cli/finq.js quote AAPL NVDA TSM
node cli/finq.js decide "Increase AMD" "CoWoS signals improving" --by "Mira Chen"
node cli/finq.js remember "Our NVDA stop-loss is 8% below cost"
node cli/finq.js mcp-call graph_peers '{"ticker":"AAPL"}'
```

## Stack

Next.js (App Router) · Drizzle + PostgreSQL · FalkorDB (`falkordb` client,
embedded compat fallback) · `@langchain/langgraph` StateGraph engine ·
`@langchain/ollama` ChatOllama · zod-typed MCP tools · stooq real-time(delayed)
quotes with simulated fallback · zero-dependency Node CLI.

# FINQ//DESK — Complete Setup Guide

A FalkorDB-centred, multi-agent financial research desk:
real-time quotes, multi-hop graph reasoning, persistent agent memory,
and a fully provenanced company brain. LangGraph + LangChain + MCP.

This guide takes you from zero to a fully verified installation in
roughly 10 minutes. Sections marked **optional** activate live mode —
everything works without them in clearly-labelled fallback modes.

---

## 0. What you are installing

| Plane | Technology | Required? | Behavior |
| --- | --- | --- | --- |
| App server | Next.js 16 (App Router) | ✅ | — |
| System tables | PostgreSQL + Drizzle ORM | ✅ | plumbing only (roster, threads, telemetry) |
| **Knowledge graph = THE MIND** | **FalkorDB (Cypher)** | **yes — auto-provisioned** | Boot ladder: configured server → auto-booted embedded real FalkorDB engine (FalkorDBLite, persisted to `.data/falkordb`) → loudly-labeled degraded store |
| LLM router/prose | Ollama + LangChain ChatOllama | optional | Deterministic policy router + template synthesis |
| Market data | stooq.com delayed quotes | optional | Deterministic simulated feed (labeled `simulated`) |

---

## 1. Prerequisites

- **Node.js ≥ 20.9** and npm (`node -v` to check)
- **Docker** (easiest path for PostgreSQL and FalkorDB) or native installs
- Git

## 2. Get the code and install dependencies

```bash
git clone <your-repo-url> finq-desk
cd finq-desk
npm install
```

## 3. Provide PostgreSQL

Any PostgreSQL ≥ 14 works. Quickest with Docker:

```bash
docker run -d --name finq-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app_db \
  -p 5432:5432 postgres:16
```

## 4. Configure environment

Create `.env` in the project root (values shown are the defaults used
when the variables are absent):

```bash
# required — the platform's system tables (agents, sessions, messages, events)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db

# optional — live graph runtime (falls back to embedded mode if unreachable)
FALKORDB_URL=redis://localhost:6379

# optional — local LLM plane (falls back to deterministic router if offline)
OLLAMA_BASE_URL=http://localhost:11434
```

> The FalkorDB endpoint can also be changed later from **Settings →
> FalkorDB graph runtime** — the DB-stored value takes precedence over env.

## 5. Create the database schema

```bash
npx drizzle-kit push
```

Expected output: `[✓] Changes applied`.

> Re-installing over an older version of this project? If drizzle asks
> about conflicting renames, either answer with `+` (create) or reset:
> `psql $DATABASE_URL -c "DROP TABLE IF EXISTS agents,missions,tasks,events,settings,chat_sessions,chat_messages,graph_nodes,graph_edges CASCADE;"` then push again.

## 6. Start the platform

Development:

```bash
npm run dev
```

Production:

```bash
npm run build && npm start
```

Open **http://localhost:3000**.

## 7. First boot — the desk seeds itself

The first request to any stats/agents endpoint triggers `ensureSeed()`:

- **6 agents** — ORCHESTRA (supervisor), ARCHIVE (memory), TICKER
  (market), TOPOLOGY (graph), PROVENANCE (brain), DESK-WRITER (synthesis)
- **20 companies + 6 sectors + 3 funds** with `COMPETES_WITH`, `SUPPLIES`,
  `IN_SECTOR`, `OWNS` edges (≈51 nodes, 115+ edges)
- **Company brain** — 6 people, 3 teams, 3 projects, 4 documents, 3
  fully-provenanced decisions
- **Procedural memory** — 3 desk policies

Verify with the status bar (top of the Console) or:

```bash
node cli/finq.js status
```

You should see `graph size  51+ nodes · 115+ edges` and
`graph  EMBEDDED MODE` (or `FALKORDB LIVE` after step 8).

## 8. FalkorDB is the mind (auto-provisioned, already real)

FalkorDB is **not optional** in this project — the knowledge graph is the
desk's mind: supply chains, contagion maps, agent memory, and the company
brain execute as Cypher on a real FalkorDB engine. Boot ladder:

```
1. FALKORDB LIVE ... configured server at FALKORDB_URL (docker / cloud)
2. FALKORDB LITE ... auto-booted embedded REAL FalkorDB engine via
                     falkordblite (bundled module + vendored Redis 8),
                     persisted to .data/falkordb — zero config
3. DEGRADED ........ Postgres compat store, emergency-only, red label
```

On any plain machine, first boot lands at level 2 automatically: the
embedded engine boots in ~200 ms and persists across restarts.
**No system Redis needed** — `scripts/bootstrap-falkordb.sh` has already
vendored a portable rootless Redis 8 (run it once on fresh clones:

```bash
./scripts/bootstrap-falkordb.sh   # idempotent, no sudo, x86_64 linux
```

For a production/shared desk, run the full server — it takes priority:

```bash
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest
```

Then either save `redis://localhost:6379` in **Settings** (persists in DB,
auto re-probes) or set `FALKORDB_URL` and restart. Status bar flips to
`FALKORDB LIVE`. Sanity-check directly:

```bash
redis-cli GRAPH.QUERY finq "MATCH (n) RETURN head(labels(n)), count(n)"
```

> Graph name is **`finq`**. After connecting a production server, use
> **Settings → Burn & reseed desk** to repopulate it. The `DEGRADED`
> label means no real engine could start at all — check Settings for the
> driver error.

## 9. Optional: local LLM plane

Routing and executive summaries become model-generated:

```bash
# install from https://ollama.com, then:
ollama serve
ollama pull llama3.1:8b
```

No restart needed — the engine probes Ollama per question; the
`LLM` indicator in the status bar turns green.

## 10. Verify the three tracks (5 commands)

```bash
export FINQ_API=http://localhost:3000

# Track 1 — multi-hop action on connected data
node cli/finq.js ask "If TSMC blows up, who gets hurt?"

# Track 2 — persistent memory across sessions
node cli/finq.js remember "Our NVDA stop-loss is 8% below cost basis"
node cli/finq.js ask "What do you remember about our NVDA stop-loss?"

# Track 3 — company brain provenance
node cli/finq.js ask "Why did we decide to overweight NVDA?"
node cli/finq.js ask "Who owns the AI Capex Tracker?"
```

Each answer ends with a **reasoning trace** (which agent called which
MCP tool) and a numbered **sources** block.

## 11. The CLI

Zero dependencies, Node ≥ 18:

```bash
node cli/finq.js status                              # platform report
node cli/finq.js ask "<question>"                    # full agent pipeline
node cli/finq.js quote AAPL NVDA TSM                 # real-time quotes
node cli/finq.js history NVDA --days 90              # sparkline trend
node cli/finq.js brain                               # org + decisions + docs
node cli/finq.js ingest "<title>" "<body>"           # document → graph
node cli/finq.js decide "<title>" "<rationale>" --by "Mira Chen"
node cli/finq.js memory --kind procedural
node cli/finq.js tools                               # MCP manifest
node cli/finq.js mcp-call graph_peers '{"ticker":"AAPL"}'
```

`FINQ_API` overrides the target (default `http://localhost:3000`).

## 12. Web UI tour

| Page | What it shows |
| --- | --- |
| **Console** `/` | Chat with the whole desk. Live engine trace per answer, session threads per tenant, quick prompts. |
| **Brain** `/brain` | Org graph, decision provenance, document corpus; ingest docs, record decisions, add people. |
| **Graph** `/graph` | Interactive constellation explorer + node inspector with neighborhood walks. |
| **Memory** `/memory` | Episodic / semantic / procedural drawers per tenant, plus manual memory writes. |
| **Agents** `/agents` | The six agents, their MCP tools, the LangGraph execution topology. |
| **Guide** `/setup` | This guide, with a live system checklist. |
| **Settings** `/settings` | FalkorDB endpoint, MCP endpoint docs, CLI reference, danger zone (reseed/wipe). |

## 13. Attach an external MCP client

Endpoint: `http://localhost:3000/api/mcp`
Transport: stateless JSON-RPC over HTTP
Tenant header: `x-tenant` (default `desk-1`)

Handshake:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

List tools: `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
Call a tool:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' -H 'x-tenant: desk-1' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graph_risk_paths","arguments":{"ticker":"TSM"}}}'
```

16 tools ship: `get_quote`, `get_history`, `company_profile`,
`graph_peers`, `graph_supply_chain`, `graph_risk_paths`, `graph_path`,
`graph_centrality`, `brain_decisions`, `brain_who_knows`, `brain_org`,
`brain_ingest_document`, `brain_record_decision`, `memory_recall`,
`memory_store`, `list_procedures`.

## 14. Tenancy

Every memory node is tenant-scoped.

- **Web UI:** change the tenant in the left rail of the Console
  (persisted in localStorage, isolates threads + memory).
- **CLI:** `--tenant my-desk` on any command.
- **MCP:** `x-tenant` header.

Use one tenant per user, fund, or strategy — recall never crosses tenants.

## 15. Reset

- **UI:** Settings → *Burn & reseed desk* (full rebuild) or *Purge everything*.
- **API:** `POST /api/admin {"mode":"reseed"}` or `{"mode":"wipe"}`.

## 16. Troubleshooting

| Symptom | Cause → Fix |
| --- | --- |
| `FALKORDB EMBEDDED (amber)` | Server not reachable at the configured URL. Start the container (step 8); the platform keeps working meanwhile. |
| `LLM OFF` | Ollama not running at `OLLAMA_BASE_URL`. The desk uses the deterministic policy router — everything still works. |
| Quotes say `simulated` | Outbound network to stooq.com is blocked; quotes become deterministic and clearly labeled. |
| `drizzle-kit push` interactive conflict | Old tables from a previous template. Drop them (step 5 note) then push again. |
| `npm run build` fails type-check | Run `npx next typegen` once, then `npx tsc --noEmit` to see the real error. |
| Port 3000 busy | `PORT=3001 npm run dev` → set `FINQ_API=http://localhost:3001` for the CLI. |
| Health check | `curl localhost:3000/api/health` should return `{"ok":true,"service":"agentco"}`. |

## 17. Production checklist

1. `npm run build && npm start` (or a process manager / container)
2. Set `DATABASE_URL`, `FALKORDB_URL`, `OLLAMA_BASE_URL` in the environment
3. `npx drizzle-kit push` against the production database
4. Confirm `FALKORDB LIVE` in the status bar and run the step-10 checks
5. Restrict or proxy `/api/admin` if the deployment is shared

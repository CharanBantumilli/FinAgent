from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from falkordb import FalkorDB
from ingest_company import build_company_graph
from main import run_finagent_query

app = FastAPI(title="FinGraph Sentinel API")
db = FalkorDB(host="localhost", port=6379)
graph = db.select_graph("fin_company_brain")


class ChatRequest(BaseModel):
    question: str
    ticker: str = "GOOGL"
    tenant: str = "investor_memory_tenant_1"


@app.get("/", response_class=HTMLResponse)
def serve_ui():
    return Path("index.html").read_text(encoding="utf-8")


@app.post("/api/chat")
def chat_with_agent(req: ChatRequest):
    answer = run_finagent_query(req.question, req.ticker, req.tenant)
    return {"answer": answer}


@app.get("/api/analyze/{ticker}")
def analyze_company(ticker: str, tenant: str = "investor_memory_tenant_1", refresh: bool = False):
    ticker = ticker.upper().strip()
    memory_graph = db.select_graph(tenant)

    comp_res = graph.query(
        "MATCH (c:Company {ticker: $ticker}) RETURN c.name, c.price, c.market_cap, c.sector, c.summary",
        {"ticker": ticker},
    ).result_set

    if not comp_res or refresh:
        build_company_graph(ticker, user_id=tenant)
        comp_res = graph.query(
            "MATCH (c:Company {ticker: $ticker}) RETURN c.name, c.price, c.market_cap, c.sector, c.summary",
            {"ticker": ticker},
        ).result_set

    c_name, c_price, c_mcap, c_sector, c_summary = comp_res[0]

    nodes = {}
    edges = []

    def add_node(node_id, label, group, track, title=""):
        if node_id not in nodes:
            nodes[node_id] = {"id": node_id, "label": label, "group": group, "track": track, "title": title}

    add_node(f"COMP_{ticker}", f"{ticker}\n(${c_price:,.2f})", "company", "all", f"{c_name} | Sector: {c_sector}")

    # Track 1: Shareholders & Supply Chain Counterparties
    q_exp = """
    MATCH (c:Company {ticker: $ticker})-[rel]->(partner:Company)
    OPTIONAL MATCH (inst:Institution)-[h:HOLDS_SHARES]->(c)
    WHERE h.invalid_at IS NULL
    RETURN coalesce(inst.name, 'Institutional Float'), coalesce(h.pct, 0.0), type(rel), partner.ticker
    ORDER BY h.pct DESC
    LIMIT 10
    """
    track1_exposure = []
    for r in graph.query(q_exp, {"ticker": ticker}).result_set:
        holder, pct, rel_type, partner = r[0], r[1], r[2], r[3]
        holder_id = f"INST_{holder[:18]}"
        partner_id = f"PART_{partner}"

        add_node(holder_id, f"{holder[:16]}...\n({pct}%)", "shareholder", "track1", f"Institutional Holder: {holder} ({pct}%)")
        add_node(partner_id, f"{partner}\n(Partner)", "partner", "track1", f"Supply/Revenue Counterparty: {partner}")

        edges.append({"from": holder_id, "to": f"COMP_{ticker}", "label": "HOLDS_SHARES", "track": "track1"})
        edges.append({"from": f"COMP_{ticker}", "to": partner_id, "label": rel_type, "track": "track1"})

        track1_exposure.append({
            "holder": holder,
            "pct": pct,
            "rel": rel_type,
            "partner": partner,
            "path": f"({holder}) ➔ [{ticker}] ➔ [:{rel_type}] ➔ ({partner})",
        })

    # Track 3: Executives, Business Units & SEC Filing Lineage
    q_exec = "MATCH (e:Executive)-[:LEADS_COMPANY]->(c:Company {ticker: $ticker}) RETURN e.name, e.title LIMIT 4"
    executives = []
    for r in graph.query(q_exec, {"ticker": ticker}).result_set:
        eid = f"EXEC_{r[0]}"
        add_node(eid, f"👔 {r[0]}", "executive", "track3", f"Role: {r[1]}")
        edges.append({"from": eid, "to": f"COMP_{ticker}", "label": "LEADS", "track": "track3"})
        executives.append({"name": r[0], "title": r[1]})

    q_sec = """
    MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
    OPTIONAL MATCH (dec)-[:SUPERSEDES]->(old:FilingDecision)
    RETURN DISTINCT bu.name, dec.id, dec.summary, old.id
    """
    sec_filings = []
    for r in graph.query(q_sec, {"ticker": ticker}).result_set:
        bu_name, dec_id, dec_sum, old_id = r[0], r[1], r[2], r[3]
        bu_id = f"BU_{bu_name}"
        d_id = f"DEC_{dec_id}"
        add_node(bu_id, f"🏢 {bu_name.replace(ticker + ' ', '')}", "unit", "track3", bu_name)
        add_node(d_id, f"📜 {dec_id}", "filing", "track3", f"Guidance: {dec_sum}")
        edges.append({"from": f"COMP_{ticker}", "to": bu_id, "label": "OPERATES_UNIT", "track": "track3"})
        edges.append({"from": d_id, "to": bu_id, "label": "GOVERNS_UNIT", "track": "track3"})

        if old_id:
            old_node_id = f"DEC_{old_id}"
            add_node(old_node_id, f"📜 {old_id}\n(Superseded)", "filing_old", "track3", "Superseded Historical Filing")
            edges.append({"from": d_id, "to": old_node_id, "label": "SUPERSEDES", "track": "track3"})

        sec_filings.append({"unit": bu_name, "active_id": dec_id, "summary": dec_sum, "old_id": old_id})

    # Track 1 + 3 Multi-Hop Catalyst Trace
    q_trace = """
    MATCH (cat:SocialCatalyst)-[:IMPACTS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
    MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu)
    OPTIONAL MATCH (dec)-[:SUPERSEDES]->(old_dec:FilingDecision)
    RETURN cat.id, cat.sentiment, cat.source, cat.title, bu.name, dec.id, old_dec.id
    LIMIT 6
    """
    catalysts = []
    for r in graph.query(q_trace, {"ticker": ticker}).result_set:
        cid, sent, src, title, bu_name, dec_id, old_id = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
        cat_node_id = f"CAT_{cid}"
        add_node(cat_node_id, f"📡 {sent}\n({src[:12]})", f"catalyst_{sent.lower()}", "track1", title)
        edges.append({"from": cat_node_id, "to": f"BU_{bu_name}", "label": "IMPACTS_UNIT", "track": "track1"})
        catalysts.append({
            "sentiment": sent,
            "source": src,
            "title": title,
            "unit": bu_name,
            "filing": dec_id,
            "superseded": old_id,
        })

    # Track 2: Multi-Agent Memory & Coordination Handoffs
    q_mem = """
    MATCH (u:Investor {id: $uid})-[:HAD_EPISODE]->(ep:Episode)
    MATCH (ep)-[:SPAWNED_TASK]->(t:AgentTask)-[:DEPENDS_ON]->(pre:AgentTask)
    WHERE pre.status = 'completed'
    RETURN ep.ticker, ep.price_at_check, ep.summary, t.agent, t.status, collect(pre.agent)
    ORDER BY ep.ts DESC
    LIMIT 5
    """
    episodes = []
    for idx, r in enumerate(memory_graph.query(q_mem, {"uid": tenant}).result_set):
        ep_ticker, ep_price, ep_sum, next_ag, status, pre_ags = r[0], r[1], r[2], r[3], r[4], r[5]
        if idx == 0:
            ep_node_id = f"MEM_EP_{ep_ticker}"
            ag_node_id = f"AG_{next_ag}"
            add_node(ep_node_id, f"🧠 Episode\n({ep_ticker} @ ${ep_price:,.0f})", "memory", "track2", ep_sum)
            add_node(ag_node_id, f"🤖 {next_ag}", "agent", "track2", f"Status: {status}")
            edges.append({"from": ep_node_id, "to": f"COMP_{ticker}", "label": "TRACKS_TICKER", "track": "track2"})
            edges.append({"from": ep_node_id, "to": ag_node_id, "label": "HANDOFF_UNLOCKED", "track": "track2"})
        episodes.append({
            "ticker": ep_ticker,
            "price": ep_price,
            "summary": ep_sum,
            "next_agent": next_ag,
            "status": status,
            "completed_agents": pre_ags,
        })

    unique_edges = list({f"{e['from']}->{e['to']}:{e['label']}": e for e in edges}.values())

    return {
        "company": {
            "ticker": ticker,
            "name": c_name,
            "price": c_price,
            "market_cap": c_mcap,
            "sector": c_sector,
            "summary": c_summary,
        },
        "tenant": tenant,
        "graph": {"nodes": list(nodes.values()), "edges": unique_edges},
        "track1_exposure": track1_exposure[:6],
        "track2_episodes": episodes,
        "track3_executives": executives,
        "track3_filings": sec_filings,
        "catalysts": catalysts,
    }
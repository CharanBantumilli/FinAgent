"""FinGraph Sentinel API.  Run: uvicorn server:app --reload"""
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

import queries as Q
from graphdb import ALLOWED_TENANTS, DEFAULT_TENANT, InvalidInput, company_graph, normalize_ticker, normalize_tenant, tenant_graph
from ingest_company import UnknownTicker, build_company_graph

log = logging.getLogger("fingraph.server")
ROOT = Path(__file__).resolve().parent
REFRESH_COOLDOWN = int(os.getenv("REFRESH_COOLDOWN_SECONDS", "120"))  # protects upstream APIs from repeated refreshes

app = FastAPI(title="FinGraph Sentinel API")


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    ticker: str = "GOOGL"
    tenant: str = DEFAULT_TENANT


def _guard(fn):
    """Run fn and translate known failures into clean HTTP errors instead of 500 stack traces."""
    try:
        return fn()
    except InvalidInput as e:
        raise HTTPException(400, str(e))
    except UnknownTicker as e:
        raise HTTPException(404, str(e))
    except HTTPException:
        raise
    except Exception as e:
        name = type(e).__name__
        if "Connection" in name or "Timeout" in name:
            raise HTTPException(503, "FalkorDB is not reachable. Is the container running (docker ps)?")
        log.exception("unhandled error")
        raise HTTPException(500, f"{name}: {e}")


@app.get("/", response_class=HTMLResponse)
def serve_ui():
    return (ROOT / "index.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health():
    def check():
        company_graph().query("RETURN 1")
        return {"status": "ok", "falkordb": "reachable", "company_graph": os.getenv("COMPANY_GRAPH", "fin_company_brain")}
    return _guard(check)


@app.get("/api/tenants")
def tenants():
    return {"tenants": ALLOWED_TENANTS, "default": DEFAULT_TENANT}


@app.post("/api/chat")
def chat_with_agent(req: ChatRequest):
    def run():
        from main import run_finagent_query  # imported lazily: LangGraph is heavy and optional for the rest of the API
        return {"answer": run_finagent_query(req.question, normalize_ticker(req.ticker), normalize_tenant(req.tenant))}
    return _guard(run)


def _company_row(graph, ticker):
    rows = graph.query(Q.Q_COMPANY, {"ticker": ticker}).result_set
    return rows[0] if rows else None


@app.post("/api/harvest/{ticker}")
def harvest(ticker: str, tenant: str = DEFAULT_TENANT, force: bool = False):
    """Run the 4-agent pipeline (writes to FalkorDB). POST because it changes state and calls external APIs."""
    def run():
        t, tn = normalize_ticker(ticker), normalize_tenant(tenant)
        row = _company_row(company_graph(), t)
        if row and not force and row[6] and time.time() - int(row[6]) < REFRESH_COOLDOWN:
            return {"ticker": t, "skipped": True, "reason": f"refreshed less than {REFRESH_COOLDOWN}s ago"}
        return build_company_graph(t, user_id=tn)
    return _guard(run)


@app.get("/api/analyze/{ticker}")
def analyze_company(ticker: str, tenant: str = DEFAULT_TENANT, refresh: bool = False):
    """Read-only view of the graph (auto-harvests only if the company has never been loaded)."""
    return _guard(lambda: _analyze(ticker, tenant, refresh))


def _analyze(ticker, tenant, refresh):
    ticker, tenant = normalize_ticker(ticker), normalize_tenant(tenant)
    graph, memory_graph = company_graph(), tenant_graph(tenant)
    row = _company_row(graph, ticker)
    if not row or (refresh and (not row[6] or time.time() - int(row[6]) >= REFRESH_COOLDOWN)):
        build_company_graph(ticker, user_id=tenant)
        row = _company_row(graph, ticker)
    c_name, c_price, c_mcap, c_sector, c_summary, c_src, c_updated = row
    c_price = c_price or 0.0

    nodes, edges = {}, []

    def add_node(node_id, label, group, track, title=""):
        nodes.setdefault(node_id, {"id": node_id, "label": label, "group": group, "track": track, "title": title})

    comp_id = f"COMP_{ticker}"
    add_node(comp_id, f"{ticker}\n(${c_price:,.2f})", "company", "all", f"{c_name} | Sector: {c_sector} | Data: {c_src}")

    # ---- Track 1: shared-shareholder contagion across supply-chain links
    exposure = []
    for rel_type, partner, holder, pct_c, pct_p, _ in graph.query(Q.Q_EXPOSURE, {"ticker": ticker}).result_set:
        partner_id = f"PART_{partner}"
        add_node(partner_id, f"{partner}\n(Partner)", "partner", "track1", f"Supply/Revenue Counterparty: {partner}")
        edges.append({"from": comp_id, "to": partner_id, "label": rel_type, "track": "track1"})
        if holder:
            hid = f"INST_{holder}"
            add_node(hid, f"{holder[:16]}...\n({pct_c}%)", "shareholder", "track1", f"Institutional holder: {holder}")
            edges.append({"from": hid, "to": comp_id, "label": "HOLDS_SHARES", "track": "track1"})
            edges.append({"from": hid, "to": partner_id, "label": "HOLDS_SHARES", "track": "track1"})
            path = f"({holder}) holds [{ticker}] and [{partner}], linked by [:{rel_type}]"
        else:
            path = f"[{ticker}] ➔ [:{rel_type}] ➔ ({partner}); no shared institutional holder in graph"
        exposure.append({"holder": holder or "-", "pct": pct_c, "partner_pct": pct_p, "rel": rel_type,
                         "partner": partner, "shared": bool(holder), "path": path})

    # ---- Track 3: executives, units, filings, lineage
    executives = []
    for name, title in graph.query(Q.Q_EXECUTIVES, {"ticker": ticker}).result_set:
        eid = f"EXEC_{name}"
        add_node(eid, f"👔 {name}", "executive", "track3", f"Role: {title}")
        edges.append({"from": eid, "to": comp_id, "label": "LEADS", "track": "track3"})
        executives.append({"name": name, "title": title})

    sec_filings = []
    for bu_name, dec_id, dec_sum, old_id, url, form, filed, src in graph.query(Q.Q_SEC_UNITS, {"ticker": ticker}).result_set:
        bu_id, d_id = f"BU_{bu_name}", f"DEC_{dec_id}"
        add_node(bu_id, f"🏢 {bu_name.replace(ticker + ' ', '')}", "unit", "track3", f"{bu_name} (illustrative segment)")
        add_node(d_id, f"📜 {form or ''} {filed or ''}", "filing", "track3", f"{dec_sum} | source: {src}")
        edges.append({"from": comp_id, "to": bu_id, "label": "OPERATES_UNIT", "track": "track3"})
        edges.append({"from": d_id, "to": bu_id, "label": "GOVERNS_UNIT", "track": "track3"})
        sec_filings.append({"unit": bu_name, "active_id": dec_id, "summary": dec_sum, "old_id": old_id,
                            "url": url, "form": form, "filed_at": filed, "source": src})

    lineage = []
    for fid, form, filed, url, src, old_id in graph.query(Q.Q_LINEAGE, {"ticker": ticker}).result_set:
        lineage.append({"id": fid, "form": form, "filed_at": filed, "url": url, "source": src, "supersedes": old_id})
    superseded = {f["supersedes"] for f in lineage if f["supersedes"]}
    for f in lineage:
        add_node(f"DEC_{f['id']}", f"📜 {f['form']} {f['filed_at']}" + ("\n(Superseded)" if f["id"] in superseded else ""),
                 "filing_old" if f["id"] in superseded else "filing", "track3", f"{f['form']} filed {f['filed_at']} | source: {f['source']}")
        if f["supersedes"]:
            edges.append({"from": f"DEC_{f['id']}", "to": f"DEC_{f['supersedes']}", "label": "SUPERSEDES", "track": "track3"})

    # ---- Track 1 + 3 bridge: catalyst -> unit -> governing filing
    catalysts = []
    for cid, sent, src, title, bu_name, dec_id, old_id, url in graph.query(Q.Q_TRACE, {"ticker": ticker}).result_set:
        cat_id = f"CAT_{cid}"
        add_node(cat_id, f"📡 {sent}\n({src[:12]})", f"catalyst_{sent.lower()}", "track1", title)
        edges.append({"from": cat_id, "to": f"BU_{bu_name}", "label": "IMPACTS_UNIT", "track": "track1"})
        catalysts.append({"sentiment": sent, "source": src, "title": title, "unit": bu_name,
                          "filing": dec_id, "superseded": old_id, "filing_url": url})

    # ---- Track 2: this tenant's memory graph
    episodes = []
    for idx, (ep_ticker, ep_price, ep_sum, next_ag, status, pre_ags) in enumerate(
            memory_graph.query(Q.Q_MEMORY, {"uid": tenant}).result_set):
        if idx == 0:
            add_node(f"MEM_EP_{ep_ticker}", f"🧠 Episode\n({ep_ticker} @ ${(ep_price or 0):,.0f})", "memory", "track2", ep_sum)
            add_node(f"AG_{next_ag}", f"🤖 {next_ag}", "agent", "track2", f"Status: {status}")
            if ep_ticker == ticker:
                edges.append({"from": f"MEM_EP_{ep_ticker}", "to": comp_id, "label": "TRACKS_TICKER", "track": "track2"})
            edges.append({"from": f"MEM_EP_{ep_ticker}", "to": f"AG_{next_ag}", "label": "HANDOFF_UNLOCKED", "track": "track2"})
        episodes.append({"ticker": ep_ticker, "price": ep_price or 0, "summary": ep_sum, "next_agent": next_ag,
                         "status": status, "completed_agents": pre_ags})
    interactions = [{"ticker": t, "question": q, "ts": ts}
                    for t, q, ts in memory_graph.query(Q.Q_INTERACTIONS, {"uid": tenant}).result_set]

    return {
        "company": {"ticker": ticker, "name": c_name, "price": c_price, "market_cap": c_mcap, "sector": c_sector,
                    "summary": c_summary, "data_source": c_src, "last_updated": c_updated},
        "tenant": tenant,
        "graph": {"nodes": list(nodes.values()), "edges": list({f"{e['from']}>{e['to']}:{e['label']}": e for e in edges}.values())},
        "track1_exposure": exposure[:8],
        "actions": propose_actions(ticker, catalysts, exposure),
        "track2_episodes": episodes,
        "track2_interactions": interactions,
        "track3_executives": executives,
        "track3_filings": sec_filings,
        "track3_lineage": lineage,
        "catalysts": catalysts,
    }


def propose_actions(ticker, catalysts, exposure):
    """Track 1 'acts on what the graph shows': deterministic, explainable follow-ups derived from graph facts."""
    shared = [e for e in exposure if e["shared"]]
    holders = sorted({e["holder"] for e in shared})[:3]
    partners = sorted({e["partner"] for e in shared})
    actions = []
    for c in catalysts:
        if c["sentiment"] != "BEARISH":
            continue
        text = f"Review {c['unit']}: bearish headline from {c['source']}."
        if holders:
            text += f" Shared holders ({', '.join(holders)}) also hold {', '.join(partners)}: check contagion through those links."
        actions.append({"priority": "high" if holders else "medium", "text": text, "evidence": c["title"]})
    if not actions and not shared:
        actions.append({"priority": "info", "text": f"No bearish catalysts or shared-holder exposure found for {ticker}.", "evidence": ""})
    return actions[:5]

from langchain_core.tools import tool
from falkordb import FalkorDB
from ingest_company import build_company_graph

db = FalkorDB(host="localhost", port=6379)
graph = db.select_graph("fin_company_brain")


@tool
def harvest_company_graph_tool(ticker: str, tenant_id: str = "investor_memory_tenant_1") -> str:
    """Harvests live Yahoo Finance stock data, institutional shareholders, supply-chain dependencies, and news/social catalysts into FalkorDB for a given stock ticker."""
    info = build_company_graph(ticker.upper().strip(), user_id=tenant_id)
    return (
        f"Harvested {info['name']} ({info['ticker']}) at ${info['price']} into FalkorDB "
        f"with {info['catalysts_count']} live catalysts and recorded episodic memory in {tenant_id}."
    )


@tool
def query_contagion_and_sec_brain(ticker: str) -> str:
    """Track 1 & Track 3 Tool: Traverses FalkorDB to find how live news/social catalysts hit internal business divisions, which SEC filing governs them, and institutional shareholder supply-chain exposure."""
    ticker = ticker.upper().strip()

    q_contagion = """
    MATCH (cat:SocialCatalyst)-[:IMPACTS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
    MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu)
    OPTIONAL MATCH (dec)-[:SUPERSEDES]->(old_dec:FilingDecision)
    RETURN cat.sentiment, cat.source, cat.title, bu.name, dec.id, dec.summary, old_dec.id
    LIMIT 5
    """
    cat_rows = graph.query(q_contagion, {"ticker": ticker}).result_set

    q_exp = """
    MATCH (c:Company {ticker: $ticker})-[rel]->(partner:Company)
    OPTIONAL MATCH (inst:Institution)-[h:HOLDS_SHARES]->(c)
    WHERE h.invalid_at IS NULL
    RETURN coalesce(inst.name, 'Institutional Float'), coalesce(h.pct, 0.0), type(rel), partner.ticker
    ORDER BY h.pct DESC
    LIMIT 6
    """
    exp_rows = graph.query(q_exp, {"ticker": ticker}).result_set

    lines = [f"=== FalkorDB Multi-Hop Trace for {ticker} ==="]
    lines.append("\n[Track 1 & 3: Catalyst -> Business Division -> SEC Filing Lineage]:")
    for r in cat_rows:
        lines.append(f"- [{r[0]} | {r[1]}] '{r[2]}' -> impacts ({r[3]}) -> governed by ({r[4]}: {r[5]}, superseded {r[6]})")

    lines.append("\n[Track 1: Shareholder -> Supply-Chain Exposure]:")
    for r in exp_rows:
        lines.append(f"- ({r[0]}: {r[1]}%) -> [{ticker}] -> [:{r[2]}] -> ({r[3]})")

    return "\n".join(lines)


@tool
def query_tenant_memory_and_handoffs(tenant_id: str = "investor_memory_tenant_1") -> str:
    """Track 2 Tool: Queries the isolated investor tenant graph in FalkorDB for past session episodes and multi-agent task handoff states."""
    mem_graph = db.select_graph(tenant_id)
    q_mem = """
    MATCH (u:Investor {id: $uid})-[:HAD_EPISODE]->(ep:Episode)
    MATCH (ep)-[:SPAWNED_TASK]->(t:AgentTask)-[:DEPENDS_ON]->(pre:AgentTask)
    WHERE pre.status = 'completed'
    RETURN ep.ticker, ep.price_at_check, ep.summary, t.agent, t.status, collect(pre.agent)
    ORDER BY ep.ts DESC
    LIMIT 5
    """
    rows = mem_graph.query(q_mem, {"uid": tenant_id}).result_set
    if not rows:
        return f"No episodes recorded yet in isolated tenant graph '{tenant_id}'."

    lines = [f"=== Track 2 Isolated Tenant Memory ({tenant_id}) ==="]
    for r in rows:
        lines.append(
            f"- Episode on {r[0]} @ ${r[1]}: {r[2]} | Completed upstream: {r[5]} -> Unlocked next agent: {r[3]} ({r[4]})"
        )
    return "\n".join(lines)
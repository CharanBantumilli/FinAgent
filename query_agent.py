from falkordb import FalkorDB

db = FalkorDB(host="localhost", port=6379)
graph = db.select_graph("fin_company_brain")
memory_graph = db.select_graph("investor_memory_tenant_1")


def run_explainable_analysis(ticker: str):
    ticker = ticker.upper()
    print(f"\n=======================================================")
    print(f"🕵️ MULTI-HOP GRAPH X-RAY FOR: {ticker}")
    print(f"=======================================================")

    # 1. TRACK 1 + TRACK 3 QUERY: Social Catalyst -> Company -> Business Unit -> Active 10-Q Decision
    q_contagion = """
    MATCH path = (cat:SocialCatalyst)-[:IMPACTS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
    OPTIONAL MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu)
    WHERE NOT EXISTS { (:FilingDecision)-[:SUPERSEDES]->(dec) }
    RETURN cat.title AS reddit_post,
           cat.sentiment AS sentiment,
           bu.name AS impacted_division,
           dec.id AS active_sec_filing,
           dec.summary AS filing_guidance
    LIMIT 5
    """
    res = graph.query(q_contagion, {"ticker": ticker})
    print("\n📌 [Track 1 & 3] Social Catalyst -> Internal Division -> Active SEC Filing Trace:")
    for row in res.result_set:
        print(f"  • [{row[1]}] Reddit: \"{row[0]}\"")
        print(f"    ↳ Hits Division: {row[2]} | Governed by {row[3]} ({row[4]})")

    # 2. TRACK 1 QUERY: Supply-Chain Counterparties & Exposed Institutional Shareholders
    q_exposure = """
    MATCH (inst:Institution)-[h:HOLDS_SHARES]->(c:Company {ticker: $ticker})-[rel]->(partner:Company)
    WHERE h.invalid_at IS NULL
    RETURN inst.name AS shareholder,
           h.pct AS stake_pct,
           type(rel) AS dependency_type,
           partner.ticker AS counterparty
    ORDER BY h.pct DESC
    LIMIT 6
    """
    res_exp = graph.query(q_exposure, {"ticker": ticker})
    print("\n💸 [Track 1] Shareholder Exposure to Supply-Chain / Partner Links:")
    for row in res_exp.result_set:
        print(f"  • {row[0]} ({row[1]}% stake) -> exposed to {ticker} --[{row[2]}]--> {row[3]}")

    # 3. TRACK 2 QUERY: Check Multi-Agent Task Handoff & Past Session Memory
    q_memory = """
    MATCH (u:Investor {id: 'user_demo_01'})-[:HAD_EPISODE]->(ep:Episode {ticker: $ticker})
    MATCH (ep)-[:SPAWNED_TASK]->(t:AgentTask)
    WHERE NOT EXISTS {
        MATCH (t)-[:DEPENDS_ON]->(prereq:AgentTask)
        WHERE prereq.status <> 'completed'
    }
    RETURN ep.price_at_check, t.agent, t.status
    ORDER BY ep.ts DESC
    LIMIT 1
    """
    res_mem = memory_graph.query(q_memory, {"ticker": ticker})
    print("\n🤖 [Track 2] Multi-Agent Handoff & Persistent Investor Memory:")
    for row in res_mem.result_set:
        print(f"  • Remembered {ticker} price snapshot: ${row[0]} | Unlocked Next Agent: {row[1]} ({row[2]})")


if __name__ == "__main__":
    run_explainable_analysis("GOOGL")
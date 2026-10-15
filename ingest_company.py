import time
import requests
import yfinance as yf
from falkordb import FalkorDB

# 1. Connect to your running FalkorDB Docker container
db = FalkorDB(host="localhost", port=6379)

# Main graph for Track 1 (Market/Social) & Track 3 (Company Brain)
graph = db.select_graph("fin_company_brain")

# Isolated tenant graph for Track 2 (Per-User Agent Memory)
memory_graph = db.select_graph("investor_memory_tenant_1")


def build_company_graph(ticker_symbol: str):
    ticker_symbol = ticker_symbol.upper()
    print(f"\n🚀 [Agent 1: Harvester] Fetching live Yahoo Finance data for {ticker_symbol}...")

    stock = yf.Ticker(ticker_symbol)
    info = stock.info or {}

    company_name = info.get("longName", ticker_symbol)
    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or 0.0
    market_cap = info.get("marketCap", 0)
    sector = info.get("sector", "Technology")
    summary = (info.get("longBusinessSummary") or "Public enterprise.")[:300]
    now_ts = int(time.time())

    # --- STEP A: Create Core Company Node & Track 3 Company Brain (Executives & Divisions) ---
    graph.query(
        """
        MERGE (c:Company {ticker: $ticker})
        SET c.name = $name,
            c.price = $price,
            c.market_cap = $mcap,
            c.sector = $sector,
            c.summary = $summary,
            c.last_updated = $ts
        """,
        {
            "ticker": ticker_symbol,
            "name": company_name,
            "price": float(current_price),
            "mcap": int(market_cap),
            "sector": sector,
            "summary": summary,
            "ts": now_ts,
        },
    )

    # Extract real company officers (Track 3: Who owns what inside the company)
    officers = info.get("companyOfficers", [])[:4]
    for off in officers:
        exec_name = off.get("name", "Executive")
        exec_title = off.get("title", "Officer")
        graph.query(
            """
            MATCH (c:Company {ticker: $ticker})
            MERGE (e:Executive {name: $name})
            SET e.title = $title
            MERGE (e)-[:LEADS_COMPANY]->(c)
            """,
            {"ticker": ticker_symbol, "name": exec_name, "title": exec_title},
        )

    # Seed Track 3 Internal Business Units & SEC 10-K Decisions (with SUPERSEDES provenance)
    graph.query(
        """
        MATCH (c:Company {ticker: $ticker})
        MERGE (bu1:BusinessUnit {name: $ticker + ' Core Revenue Engine'})
        MERGE (bu2:BusinessUnit {name: $ticker + ' AI & Cloud Infrastructure'})
        MERGE (c)-[:OPERATES_UNIT]->(bu1)
        MERGE (c)-[:OPERATES_UNIT]->(bu2)

        MERGE (dec_old:FilingDecision {id: $ticker + '_10K_2025', summary: 'Baseline CapEx & Supply Allocation'})
        MERGE (dec_new:FilingDecision {id: $ticker + '_10Q_2026', summary: 'Expanded AI Infrastructure & Margin Guidance'})
        MERGE (dec_new)-[:SUPERSEDES]->(dec_old)
        MERGE (dec_new)-[:GOVERNS_UNIT]->(bu2)
        """,
        {"ticker": ticker_symbol},
    )

    # --- STEP B: Track 1 & Track 2 Institutional Shareholders (with Temporal valid_at) ---
    print(f"🏦 [Agent 1: Harvester] Mapping institutional shareholders & supply-chain links...")
    try:
        holders = stock.institutional_holders
        if holders is not None and not holders.empty:
            for _, row in holders.head(5).iterrows():
                holder_name = str(row.get("Holder", "Institution"))
                pct_held = float(row.get("pctHeld", 0.0)) * 100
                graph.query(
                    """
                    MATCH (c:Company {ticker: $ticker})
                    MERGE (inst:Institution {name: $holder})
                    MERGE (inst)-[r:HOLDS_SHARES]->(c)
                    SET r.pct = round($pct * 100) / 100,
                        r.valid_at = $ts,
                        r.invalid_at = NULL
                    """,
                    {"ticker": ticker_symbol, "holder": holder_name, "pct": pct_held, "ts": now_ts},
                )
    except Exception as e:
        print(f"   (Note: Institutional holders fallback triggered: {e})")

    # Add Supply Chain / Ecosystem Counterparties (Track 1 Multi-Hop Contagion)
    ecosystem_map = {
        "GOOGL": [("AAPL", "PAYS_20B_SEARCH_DEAL"), ("NVDA", "BUYS_AI_GPUS_FROM"), ("AVGO", "CO_DESIGNS_TPU_WITH")],
        "NVDA": [("TSM", "FABRICATES_WAFERS_AT"), ("GOOGL", "SELLS_GPUS_TO"), ("MSFT", "SELLS_GPUS_TO")],
        "TSLA": [("PANW", "USES_SECURITY"), ("NVDA", "BUYS_FSD_TRAINING_GPUS"), ("AAPL", "COMPETES_FOR_TALENT")],
    }
    partners = ecosystem_map.get(
        ticker_symbol,
        [("NVDA", "TECH_DEPENDENCY"), ("MSFT", "CLOUD_COUNTERPARTY"), ("AMZN", "INFRASTRUCTURE_PEER")],
    )
    for partner_ticker, rel_type in partners:
        graph.query(
            f"""
            MATCH (c:Company {{ticker: $ticker}})
            MERGE (p:Company {{ticker: $partner}})
            MERGE (c)-[:{rel_type}]->(p)
            """,
            {"ticker": ticker_symbol, "partner": partner_ticker},
        )

    # --- STEP C: Agent 2 — Live Reddit r/stocks Social Sentiment & Catalysts ---
    print(f"📡 [Agent 2: Social Radar] Scraping live Reddit r/stocks discussions for {ticker_symbol}...")
    try:
        reddit_url = f"https://www.reddit.com/r/stocks/search.json?q={ticker_symbol}&restrict_sr=1&sort=new&limit=5"
        headers = {"User-Agent": "FalkorDBGraphHackathonBot/1.0"}
        resp = requests.get(reddit_url, headers=headers, timeout=8)
        if resp.status_code == 200:
            posts = resp.json().get("data", {}).get("children", [])
            for item in posts:
                pdata = item.get("data", {})
                title = pdata.get("title", "")[:140]
                score = int(pdata.get("score", 0))
                post_id = pdata.get("id", "post")

                # Simple keyword sentiment tagger
                lower_t = title.lower()
                sentiment = "BULLISH" if any(
                    w in lower_t for w in ["beat", "buy", "growth", "surge", "bull", "ai"]) else (
                    "BEARISH" if any(
                        w in lower_t for w in ["drop", "lawsuit", "risk", "sell", "crash", "miss"]) else "NEUTRAL"
                )

                graph.query(
                    """
                    MATCH (c:Company {ticker: $ticker})
                    MATCH (c)-[:OPERATES_UNIT]->(bu:BusinessUnit)
                    MERGE (cat:SocialCatalyst {id: $pid})
                    SET cat.title = $title,
                        cat.upvotes = $score,
                        cat.sentiment = $sentiment,
                        cat.source = 'Reddit r/stocks'
                    MERGE (cat)-[:AFFECTS_COMPANY]->(c)
                    MERGE (cat)-[:IMPACTS_UNIT]->(bu)
                    """,
                    {
                        "ticker": ticker_symbol,
                        "pid": post_id,
                        "title": title,
                        "score": score,
                        "sentiment": sentiment,
                    },
                )
    except Exception as e:
        print(f"   (Reddit fetch warning: {e})")

    # --- STEP D: Track 2 Multi-Agent Coordination & Episodic Memory Handoff ---
    print(f"🤖 [Track 2: Coordinator] Recording agent handoff state and persistent memory...")
    memory_graph.query(
        """
        MERGE (u:Investor {id: 'user_demo_01'})
        CREATE (ep:Episode {
            ticker: $ticker,
            price_at_check: $price,
            ts: $ts,
            summary: 'Analyzed ' + $ticker + ' supply chain, shareholders, and social catalysts'
        })
        MERGE (u)-[:HAD_EPISODE]->(ep)

        // Multi-Agent Task Handoff Chain inside FalkorDB
        MERGE (t1:AgentTask {id: $ticker + '_harvest', agent: 'Harvester_Agent'})
        SET t1.status = 'completed'
        MERGE (t2:AgentTask {id: $ticker + '_social', agent: 'Social_Radar_Agent'})
        SET t2.status = 'completed'
        MERGE (t3:AgentTask {id: $ticker + '_quant', agent: 'Graph_Quant_Agent'})
        SET t3.status = 'ready_for_execution'
        MERGE (t3)-[:DEPENDS_ON]->(t1)
        MERGE (t3)-[:DEPENDS_ON]->(t2)
        MERGE (ep)-[:SPAWNED_TASK]->(t3)
        """,
        {"ticker": ticker_symbol, "price": float(current_price), "ts": now_ts},
    )

    print(f"✅ Done! Graph populated for {ticker_symbol}.")


if __name__ == "__main__":
    build_company_graph("GOOGL")
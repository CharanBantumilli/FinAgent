import time
import xml.etree.ElementTree as ET
import requests
import yfinance as yf
from falkordb import FalkorDB

db = FalkorDB(host="localhost", port=6379)
graph = db.select_graph("fin_company_brain")
memory_graph = db.select_graph("investor_memory_tenant_1")


def tag_sentiment(text: str) -> str:
    lower_t = text.lower()
    if any(w in lower_t for w in ["beat", "buy", "growth", "surge", "bull", "ai", "gain", "upgrade", "record", "partner"]):
        return "BULLISH"
    if any(w in lower_t for w in ["drop", "lawsuit", "risk", "sell", "crash", "miss", "antitrust", "delay", "cut", "probe"]):
        return "BEARISH"
    return "NEUTRAL"


def build_company_graph(ticker_symbol: str, user_id: str = "user_demo_01"):
    ticker_symbol = ticker_symbol.upper().strip()
    print(f"\n🚀 [Agent 1: Harvester] Fetching live Yahoo Finance data for {ticker_symbol}...")

    stock = yf.Ticker(ticker_symbol)
    info = stock.info or {}

    company_name = info.get("longName") or info.get("shortName") or ticker_symbol
    current_price = info.get("currentPrice") or info.get("regularMarketPrice") or 0.0
    market_cap = info.get("marketCap") or 0
    sector = info.get("sector") or "Technology"
    summary = (info.get("longBusinessSummary") or "Public enterprise.")[:300]
    now_ts = int(time.time())

    # --- STEP A: Core Company & Track 3 Company Brain (Executives, Units, SEC Decisions) ---
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
        MERGE (dec_new)-[:GOVERNS_UNIT]->(bu1)
        """,
        {"ticker": ticker_symbol},
    )

    # --- STEP B: Track 1 & 2 Institutional Shareholders & Supply Chain ---
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
        print(f"   (Institutional holders note: {e})")

    ecosystem_map = {
        "GOOGL": [("AAPL", "PAYS_20B_SEARCH_DEAL"), ("NVDA", "BUYS_AI_GPUS_FROM"), ("AVGO", "CO_DESIGNS_TPU_WITH")],
        "NVDA": [("TSM", "FABRICATES_WAFERS_AT"), ("GOOGL", "SELLS_GPUS_TO"), ("MSFT", "SELLS_GPUS_TO")],
        "TSLA": [("NVDA", "BUYS_FSD_TRAINING_GPUS"), ("PANW", "USES_INFRASTRUCTURE"), ("AAPL", "COMPETES_IN_AUTONOMY")],
        "AAPL": [("TSM", "FABRICATES_SILICON_AT"), ("GOOGL", "RECEIVES_20B_SEARCH_ROYALTIES"), ("QCOM", "BUYS_5G_MODEMS_FROM")],
        "MSFT": [("NVDA", "BUYS_AZURE_GPUS_FROM"), ("GOOGL", "COMPETES_IN_CLOUD_AI"), ("ORCL", "MULTI_CLOUD_PARTNER")],
    }
    partners = ecosystem_map.get(
        ticker_symbol,
        [("NVDA", "AI_COMPUTE_DEPENDENCY"), ("MSFT", "CLOUD_COUNTERPARTY"), ("AMZN", "INFRASTRUCTURE_PEER")],
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

    # --- STEP C: Agent 2 — Multi-Source Catalysts (Yahoo News + Google News RSS + Reddit) ---
    print(f"📡 [Agent 2: Social & News Radar] Harvesting live market catalysts for {ticker_symbol}...")
    catalysts = []

    # Source 1: Yahoo Finance native news feed
    try:
        for idx, item in enumerate((stock.news or [])[:4]):
            content = item.get("content", {}) if isinstance(item, dict) else {}
            title = item.get("title") or content.get("title") or ""
            if title:
                catalysts.append({
                    "id": f"{ticker_symbol}_yf_{idx}",
                    "title": title[:140],
                    "source": "Yahoo Finance News",
                    "score": 100 - (idx * 10),
                })
    except Exception:
        pass

    # Source 2: Google News Financial RSS (Always works without API keys)
    if len(catalysts) < 3:
        try:
            rss_url = f"https://news.google.com/rss/search?q={ticker_symbol}+stock&hl=en-US&gl=US&ceid=US:en"
            resp = requests.get(rss_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=8)
            if resp.status_code == 200:
                root = ET.fromstring(resp.text)
                for idx, item in enumerate(root.findall(".//item")[:5]):
                    title_el = item.find("title")
                    if title_el is not None and title_el.text:
                        catalysts.append({
                            "id": f"{ticker_symbol}_gnews_{idx}",
                            "title": title_el.text[:140],
                            "source": "Google Finance RSS",
                            "score": 85 - (idx * 5),
                        })
        except Exception as e:
            print(f"   (RSS fallback note: {e})")

    # Source 3: Reddit r/stocks
    try:
        reddit_url = f"https://www.reddit.com/r/stocks/search.json?q={ticker_symbol}&restrict_sr=1&sort=new&limit=3"
        resp = requests.get(reddit_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=6)
        if resp.status_code == 200:
            for item in resp.json().get("data", {}).get("children", []):
                pdata = item.get("data", {})
                if pdata.get("title"):
                    catalysts.append({
                        "id": f"{ticker_symbol}_rd_{pdata.get('id', '0')}",
                        "title": pdata["title"][:140],
                        "source": "Reddit r/stocks",
                        "score": int(pdata.get("score", 10)),
                    })
    except Exception:
        pass

    # Write all discovered catalysts into FalkorDB
    for cat in catalysts[:6]:
        sentiment = tag_sentiment(cat["title"])
        target_unit_suffix = "AI & Cloud Infrastructure" if any(
            k in cat["title"].lower() for k in ["ai", "cloud", "chip", "gpu", "data", "tech"]
        ) else "Core Revenue Engine"

        graph.query(
            """
            MATCH (c:Company {ticker: $ticker})
            MATCH (c)-[:OPERATES_UNIT]->(bu:BusinessUnit {name: $unit_name})
            MERGE (cat:SocialCatalyst {id: $cid})
            SET cat.title = $title,
                cat.upvotes = $score,
                cat.sentiment = $sentiment,
                cat.source = $source
            MERGE (cat)-[:AFFECTS_COMPANY]->(c)
            MERGE (cat)-[:IMPACTS_UNIT]->(bu)
            """,
            {
                "ticker": ticker_symbol,
                "unit_name": f"{ticker_symbol} {target_unit_suffix}",
                "cid": cat["id"],
                "title": cat["title"],
                "score": cat["score"],
                "sentiment": sentiment,
                "source": cat["source"],
            },
        )
    print(f"   ↳ Linked {len(catalysts[:6])} live market/social catalysts into FalkorDB!")

    # --- STEP D: Track 2 Multi-Agent Coordination & Episodic Memory ---
    print(f"🤖 [Track 2: Coordinator] Recording agent handoff state and persistent memory...")
    memory_graph.query(
        """
        MERGE (u:Investor {id: $uid})
        CREATE (ep:Episode {
            ticker: $ticker,
            price_at_check: $price,
            ts: $ts,
            catalysts_found: $cat_count,
            summary: 'Analyzed ' + $ticker + ' supply chain, shareholders, and ' + toString($cat_count) + ' live catalysts'
        })
        MERGE (u)-[:HAD_EPISODE]->(ep)

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
        {
            "uid": user_id,
            "ticker": ticker_symbol,
            "price": float(current_price),
            "ts": now_ts,
            "cat_count": len(catalysts[:6]),
        },
    )

    print(f"✅ Done! Graph populated for {ticker_symbol}.")
    return {
        "ticker": ticker_symbol,
        "name": company_name,
        "price": current_price,
        "catalysts_count": len(catalysts[:6]),
    }


if __name__ == "__main__":
    build_company_graph("GOOGL")
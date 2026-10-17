"""Agent pipeline that builds the company graph.

Four agents, each recorded in the tenant's memory graph with its REAL outcome:
  Harvester_Agent     market data, executives, shareholders, supply-chain links  (yfinance + curated map)
  SEC_Librarian_Agent real 10-K/10-Q filings from SEC EDGAR, linked with SUPERSEDES
  Social_Radar_Agent  headlines (Yahoo, Google News RSS, optional Reddit) tagged with sentiment
  Graph_Quant_Agent   unlocked when the three above completed; closed when the chat agent answers

Every node/edge that is not live data carries a `source` so answers can say where facts came from.
"""
import hashlib
import logging
import math
import os
import re
import threading
import time

import requests
from defusedxml import ElementTree as ET

from graphdb import ALLOWED_TENANTS, DEFAULT_TENANT, company_graph, normalize_ticker
from memory import record_pipeline

log = logging.getLogger("fingraph.ingest")

SEC_HEADERS = {"User-Agent": os.getenv("SEC_USER_AGENT", "FinGraphSentinel hackathon-demo (set SEC_USER_AGENT in .env)")}
WEB_HEADERS = {"User-Agent": "FinGraphSentinel/0.2 (hackathon demo)"}
ENABLE_REDDIT = os.getenv("ENABLE_REDDIT", "0") == "1"           # off by default (Reddit API terms)
ALLOW_SYNTHETIC_FALLBACK = os.getenv("ALLOW_SYNTHETIC_FALLBACK", "1") == "1"


class UnknownTicker(ValueError):
    """Ticker not found by the market-data provider (the API turns this into HTTP 404)."""


# --------------------------------------------------------------------------- pure helpers (unit-tested)
BULL = re.compile(r"\b(beat|beats|buy|growth|surge|surges|bull|bullish|ai|gain|gains|upgrade|upgrades|"
                  r"record|partner|partnership|rally|soar|soars)\b")
BEAR = re.compile(r"\b(drop|drops|lawsuit|risk|sell|sells|crash|miss|misses|antitrust|delay|delays|cut|"
                  r"cuts|probe|fall|falls|plunge|downgrade|warning)\b")
AI_UNIT = re.compile(r"\b(ai|cloud|chip|chips|gpu|gpus|data|tech|semiconductor)\b")


def tag_sentiment(text: str) -> str:
    """Keyword heuristic with WORD boundaries (the old substring check matched 'ai' inside 'said')."""
    low = text.lower()
    bull, bear = len(BULL.findall(low)), len(BEAR.findall(low))
    return "BULLISH" if bull > bear else "BEARISH" if bear > bull else "NEUTRAL"


def unit_suffix(text: str) -> str:
    return "AI & Cloud Infrastructure" if AI_UNIT.search(text.lower()) else "Core Revenue Engine"


def parse_sec_submissions(sub: dict, cik: int, max_10q: int = 3, max_10k: int = 2) -> list:
    """Turn the SEC 'submissions' JSON into [{id, form, filed_at, url, summary}], newest first."""
    rec = (sub.get("filings") or {}).get("recent") or {}
    forms, accs, dates = rec.get("form", []), rec.get("accessionNumber", []), rec.get("filingDate", [])
    docs, descs = rec.get("primaryDocument", []), rec.get("primaryDocDescription", [])
    limits, counts, out = {"10-Q": max_10q, "10-K": max_10k}, {"10-Q": 0, "10-K": 0}, []
    for i, form in enumerate(forms):
        if form in limits and counts[form] < limits[form] and i < len(accs) and i < len(dates):
            doc = docs[i] if i < len(docs) else ""
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accs[i].replace('-', '')}/{doc}" if doc else ""
            desc = f" ({descs[i]})" if i < len(descs) and descs[i] else ""
            out.append({"id": accs[i], "form": form, "filed_at": dates[i], "url": url,
                        "summary": f"{form} filed {dates[i]}{desc}"})
            counts[form] += 1
    return sorted(out, key=lambda f: f["filed_at"], reverse=True)


def supersede_pairs(filings: list) -> list:
    """(newer_id, older_id) pairs: each filing supersedes the previous filing of the SAME form."""
    pairs, by_form = [], {}
    for f in sorted(filings, key=lambda f: f["filed_at"], reverse=True):
        by_form.setdefault(f["form"], []).append(f)
    for group in by_form.values():
        pairs += [(group[i]["id"], group[i + 1]["id"]) for i in range(len(group) - 1)]
    return pairs


# --------------------------------------------------------------------------- data sources
# Clearly-labelled SYNTHETIC numbers, used only when the live provider is unreachable (rate limit/offline)
# so the demo still runs. They are not real quotes. Rule 6: synthetic data is allowed; we label it.
SYNTHETIC_FALLBACK = {
    "GOOGL": ("Alphabet Inc. (synthetic demo)", 180.0, 2_200_000_000_000, "Communication Services"),
    "NVDA": ("NVIDIA Corporation (synthetic demo)", 140.0, 3_400_000_000_000, "Technology"),
    "AAPL": ("Apple Inc. (synthetic demo)", 230.0, 3_500_000_000_000, "Technology"),
    "MSFT": ("Microsoft Corporation (synthetic demo)", 420.0, 3_100_000_000_000, "Technology"),
    "TSLA": ("Tesla, Inc. (synthetic demo)", 250.0, 800_000_000_000, "Consumer Cyclical"),
}
SYNTHETIC_HOLDERS = [("Vanguard Group Inc (synthetic)", 9.0), ("BlackRock Inc. (synthetic)", 7.5),
                     ("State Street Corp (synthetic)", 4.0)]

# Curated demo map of publicly reported relationships. Unknown tickers get NO invented partners.
ECOSYSTEM_MAP = {
    "GOOGL": [("AAPL", "PAYS_20B_SEARCH_DEAL"), ("NVDA", "BUYS_AI_GPUS_FROM"), ("AVGO", "CO_DESIGNS_TPU_WITH")],
    "NVDA": [("TSM", "FABRICATES_WAFERS_AT"), ("GOOGL", "SELLS_GPUS_TO"), ("MSFT", "SELLS_GPUS_TO")],
    "TSLA": [("NVDA", "BUYS_FSD_TRAINING_GPUS"), ("AAPL", "COMPETES_IN_AUTONOMY")],
    "AAPL": [("TSM", "FABRICATES_SILICON_AT"), ("GOOGL", "RECEIVES_20B_SEARCH_ROYALTIES"), ("QCOM", "BUYS_5G_MODEMS_FROM")],
    "MSFT": [("NVDA", "BUYS_AZURE_GPUS_FROM"), ("GOOGL", "COMPETES_IN_CLOUD_AI"), ("ORCL", "MULTI_CLOUD_PARTNER")],
}
REL_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,60}$")  # relationship types are interpolated into Cypher: whitelist them


def fetch_market_data(ticker: str) -> dict:
    stock, info = None, {}
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
        info = stock.info or {}
    except Exception as e:
        log.warning("yfinance unavailable for %s: %s", ticker, e)
    name = info.get("longName") or info.get("shortName")
    price = info.get("currentPrice") or info.get("regularMarketPrice")
    if name or price:
        return {"stock": stock, "data_source": "yfinance", "name": name or ticker, "price": float(price or 0.0),
                "market_cap": int(info.get("marketCap") or 0), "sector": info.get("sector") or "Unknown",
                "summary": (info.get("longBusinessSummary") or "No business summary available.")[:300],
                "officers": (info.get("companyOfficers") or [])[:4]}
    if ALLOW_SYNTHETIC_FALLBACK and ticker in SYNTHETIC_FALLBACK:
        n, p, m, s = SYNTHETIC_FALLBACK[ticker]
        log.warning("Using SYNTHETIC fallback data for %s", ticker)
        return {"stock": None, "data_source": "synthetic_fallback", "name": n, "price": p, "market_cap": m,
                "sector": s, "summary": "Synthetic demo record (live market data was unavailable).", "officers": []}
    raise UnknownTicker(f"No market data found for '{ticker}'")


def fetch_holders(ticker: str, stock, demo_mode: bool) -> list:
    """[(holder_name, pct_percent)] top 5. In demo mode returns clearly-labelled synthetic holders."""
    if demo_mode:
        return list(SYNTHETIC_HOLDERS)
    try:
        if stock is None:
            import yfinance as yf
            stock = yf.Ticker(ticker)
        df = stock.institutional_holders
        if df is None or df.empty:
            return []
        out = []
        for _, row in df.head(5).iterrows():
            pct = float(row.get("pctHeld", 0.0) or 0.0) * 100
            out.append((str(row.get("Holder", "Institution")), 0.0 if math.isnan(pct) else round(pct, 2)))
        return out
    except Exception as e:
        log.warning("holders unavailable for %s: %s", ticker, e)
        return []


_cik_cache = {}


def _cik_for(ticker: str):
    if not _cik_cache:
        r = requests.get("https://www.sec.gov/files/company_tickers.json", headers=SEC_HEADERS, timeout=10)
        r.raise_for_status()
        for v in r.json().values():
            _cik_cache.setdefault(v["ticker"].upper(), int(v["cik_str"]))
    return _cik_cache.get(ticker)


def fetch_sec_filings(ticker: str) -> list:
    """Real filings from SEC EDGAR (public domain). Raises on network failure; [] if not an SEC filer."""
    cik = _cik_for(ticker)
    if not cik:
        return []
    r = requests.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", headers=SEC_HEADERS, timeout=10)
    r.raise_for_status()
    return parse_sec_submissions(r.json(), cik)


def collect_catalysts(ticker: str, stock) -> list:
    items, seen = [], set()

    def add(title, source, score):
        key = title.strip().lower()
        if title.strip() and key not in seen:
            seen.add(key)
            cid = f"{ticker}_{hashlib.sha1(key.encode()).hexdigest()[:10]}"   # stable id: no overwrite on refresh
            items.append({"id": cid, "title": title.strip()[:140], "source": source, "score": score})

    try:
        for idx, item in enumerate(((stock.news if stock else None) or [])[:4]):
            content = item.get("content", {}) if isinstance(item, dict) else {}
            add(item.get("title") or content.get("title") or "", "Yahoo Finance News", 100 - idx * 10)
    except Exception as e:
        log.info("yahoo news: %s", e)
    if len(items) < 3:
        try:
            url = f"https://news.google.com/rss/search?q={ticker}+stock&hl=en-US&gl=US&ceid=US:en"
            resp = requests.get(url, headers=WEB_HEADERS, timeout=8)
            if resp.status_code == 200:
                for idx, it in enumerate(ET.fromstring(resp.content).findall(".//item")[:5]):
                    t = it.find("title")
                    if t is not None and t.text:
                        add(t.text, "Google News RSS", 85 - idx * 5)
        except Exception as e:
            log.info("google rss: %s", e)
    if ENABLE_REDDIT:
        try:
            resp = requests.get(f"https://www.reddit.com/r/stocks/search.json?q={ticker}&restrict_sr=1&sort=new&limit=3",
                                headers=WEB_HEADERS, timeout=6)
            if resp.status_code == 200:
                for child in resp.json().get("data", {}).get("children", []):
                    d = child.get("data", {})
                    add(d.get("title", ""), "Reddit r/stocks", int(d.get("score", 10)))
        except Exception as e:
            log.info("reddit: %s", e)
    return items[:6]


# --------------------------------------------------------------------------- pipeline steps
def step_harvest(g, ticker, m, now):
    g.query("""MERGE (c:Company {ticker: $ticker})
               SET c.name = $name, c.price = $price, c.market_cap = $mcap, c.sector = $sector,
                   c.summary = $summary, c.last_updated = $ts, c.data_source = $src""",
            {"ticker": ticker, "name": m["name"], "price": m["price"], "mcap": m["market_cap"],
             "sector": m["sector"], "summary": m["summary"], "ts": now, "src": m["data_source"]})
    for off in m["officers"]:
        g.query("""MATCH (c:Company {ticker: $ticker})
                   MERGE (e:Executive {name: $name}) SET e.title = $title, e.source = 'yfinance'
                   MERGE (e)-[:LEADS_COMPANY]->(c)""",
                {"ticker": ticker, "name": off.get("name", "Executive"), "title": off.get("title", "Officer")})
    # Business units are an ILLUSTRATIVE two-segment model (no free API provides segments): labelled synthetic.
    g.query("""MATCH (c:Company {ticker: $ticker})
               MERGE (bu1:BusinessUnit {name: $ticker + ' Core Revenue Engine'}) SET bu1.source = 'synthetic_segment'
               MERGE (bu2:BusinessUnit {name: $ticker + ' AI & Cloud Infrastructure'}) SET bu2.source = 'synthetic_segment'
               MERGE (c)-[:OPERATES_UNIT]->(bu1)
               MERGE (c)-[:OPERATES_UNIT]->(bu2)""", {"ticker": ticker})
    demo = m["data_source"] == "synthetic_fallback"
    holders = fetch_holders(ticker, m["stock"], demo)
    upsert_holders(g, ticker, holders, "synthetic_fallback" if demo else "yfinance", now)
    partners = 0
    for partner, rel in ECOSYSTEM_MAP.get(ticker, []):
        if not REL_RE.match(rel):
            continue
        g.query(f"""MATCH (c:Company {{ticker: $ticker}})
                    MERGE (p:Company {{ticker: $partner}})
                    MERGE (c)-[r:{rel}]->(p) SET r.source = 'curated_demo_map'""",
                {"ticker": ticker, "partner": partner})
        upsert_holders(g, partner, fetch_holders(partner, None, demo), "synthetic_fallback" if demo else "yfinance", now)
        partners += 1
    return f"{len(holders)} holders, {partners} partner links, {len(m['officers'])} executives"


def upsert_holders(g, ticker, holders, source, now):
    """Insert/refresh holders; holders that disappeared get invalid_at (temporal edges, not deletes)."""
    if not holders:
        return
    for name, pct in holders:
        g.query("""MATCH (c:Company {ticker: $ticker})
                   MERGE (i:Institution {name: $holder})
                   MERGE (i)-[r:HOLDS_SHARES]->(c)
                   SET r.pct = $pct, r.last_seen = $ts, r.source = $src, r.valid_at = coalesce(r.valid_at, $ts), r.invalid_at = NULL""",
                {"ticker": ticker, "holder": name, "pct": pct, "ts": now, "src": source})
    g.query("""MATCH (:Institution)-[r:HOLDS_SHARES]->(c:Company {ticker: $ticker})
               WHERE r.last_seen < $ts AND r.invalid_at IS NULL
               SET r.invalid_at = $ts""", {"ticker": ticker, "ts": now})


def step_filings(g, ticker, now):
    # Old versions of this project wrote two fake filings per company; remove them if present.
    g.query("MATCH (f:FilingDecision) WHERE f.id IN [$t + '_10K_2025', $t + '_10Q_2026'] DETACH DELETE f", {"t": ticker})
    filings, source = [], "SEC EDGAR"
    try:
        filings = fetch_sec_filings(ticker)
    except Exception as e:
        log.warning("SEC EDGAR unavailable: %s", e)
    if not filings:
        existing = g.query("MATCH (f:FilingDecision)-[:FILED_BY]->(:Company {ticker: $t}) RETURN count(f)", {"t": ticker}).result_set
        if existing and existing[0][0]:
            return f"kept {existing[0][0]} existing filings (SEC EDGAR unavailable)"
        source = "synthetic_placeholder"
        filings = [
            {"id": f"{ticker}_PLACEHOLDER_NEW", "form": "10-Q", "filed_at": "2026-01-01", "url": "",
             "summary": "Placeholder: SEC EDGAR unavailable or not an SEC filer"},
            {"id": f"{ticker}_PLACEHOLDER_OLD", "form": "10-Q", "filed_at": "2025-01-01", "url": "",
             "summary": "Placeholder: earlier filing"},
        ]
    else:
        g.query("""MATCH (f:FilingDecision {source: 'synthetic_placeholder'})-[:FILED_BY]->(:Company {ticker: $t})
                   DETACH DELETE f""", {"t": ticker})
    for f in filings:
        g.query("""MATCH (c:Company {ticker: $ticker})
                   MERGE (f:FilingDecision {id: $id})
                   SET f.form = $form, f.filed_at = $filed, f.summary = $summary, f.url = $url, f.source = $src
                   MERGE (f)-[:FILED_BY]->(c)""",
                {"ticker": ticker, "id": f["id"], "form": f["form"], "filed": f["filed_at"],
                 "summary": f["summary"], "url": f["url"], "src": source})
    for new_id, old_id in supersede_pairs(filings):
        g.query("""MATCH (a:FilingDecision {id: $a}), (b:FilingDecision {id: $b}) MERGE (a)-[:SUPERSEDES]->(b)""",
                {"a": new_id, "b": old_id})
    # The newest periodic filing is the governing company-level disclosure for both (illustrative) units.
    g.query("""MATCH (:FilingDecision)-[r:GOVERNS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(:Company {ticker: $t})
               DELETE r""", {"t": ticker})
    g.query("""MATCH (c:Company {ticker: $t})-[:OPERATES_UNIT]->(bu:BusinessUnit)
               MATCH (f:FilingDecision {id: $id})
               MERGE (f)-[:GOVERNS_UNIT]->(bu)""", {"t": ticker, "id": filings[0]["id"]})
    return f"{len(filings)} filings from {source}"


def step_radar(g, ticker, stock, now):
    catalysts = collect_catalysts(ticker, stock)
    for cat in catalysts:
        g.query("""MATCH (c:Company {ticker: $ticker})-[:OPERATES_UNIT]->(bu:BusinessUnit {name: $unit_name})
                   MERGE (cat:SocialCatalyst {id: $cid})
                   SET cat.title = $title, cat.upvotes = $score, cat.sentiment = $sentiment,
                       cat.source = $source, cat.seen_at = $ts
                   MERGE (cat)-[:AFFECTS_COMPANY]->(c)
                   MERGE (cat)-[:IMPACTS_UNIT]->(bu)""",
                {"ticker": ticker, "unit_name": f"{ticker} {unit_suffix(cat['title'])}", "cid": cat["id"],
                 "title": cat["title"], "score": cat["score"], "sentiment": tag_sentiment(cat["title"]),
                 "source": cat["source"], "ts": now})
    return f"{len(catalysts)} catalysts"


def _run_step(steps, agent, key, fn):
    try:
        detail, status = fn(), "completed"
    except Exception as e:
        log.exception("%s failed", agent)
        detail, status = f"{type(e).__name__}: {e}", "failed"
    steps.append({"agent": agent, "key": key, "status": status, "detail": detail})


# --------------------------------------------------------------------------- public entry point
_locks, _locks_guard = {}, threading.Lock()


def build_company_graph(ticker_symbol: str, user_id: str = DEFAULT_TENANT):
    """Run the pipeline for one ticker. `user_id` is the tenant (memory graph) that records the run."""
    ticker = normalize_ticker(ticker_symbol)
    tenant = user_id if user_id in ALLOWED_TENANTS else DEFAULT_TENANT
    with _locks_guard:
        lock = _locks.setdefault(ticker, threading.Lock())
    with lock:  # two simultaneous harvests of one ticker would double-write
        return _build(ticker, tenant)


def _build(ticker, tenant):
    g = company_graph()
    now = int(time.time())
    market = fetch_market_data(ticker)  # raises UnknownTicker before anything is written
    steps = []
    _run_step(steps, "Harvester_Agent", "harvest", lambda: step_harvest(g, ticker, market, now))
    _run_step(steps, "SEC_Librarian_Agent", "sec", lambda: step_filings(g, ticker, now))
    _run_step(steps, "Social_Radar_Agent", "social", lambda: step_radar(g, ticker, market["stock"], now))
    record_pipeline(tenant, ticker, market["price"], steps, run_id=f"{ticker}_{now}")
    return {"ticker": ticker, "name": market["name"], "price": market["price"], "data_source": market["data_source"],
            "steps": [{k: s[k] for k in ("agent", "status", "detail")} for s in steps]}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import json
    import sys
    print(json.dumps(build_company_graph(sys.argv[1] if len(sys.argv) > 1 else "GOOGL"), indent=2))

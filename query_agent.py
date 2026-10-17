"""Command-line graph X-ray.  Usage: python query_agent.py [TICKER] [TENANT]"""
import sys

import queries as Q
from graphdb import DEFAULT_TENANT, company_graph, normalize_tenant, normalize_ticker, tenant_graph


def run_explainable_analysis(ticker: str, tenant: str = DEFAULT_TENANT):
    ticker, tenant = normalize_ticker(ticker), normalize_tenant(tenant)
    graph, memory_graph = company_graph(), tenant_graph(tenant)
    print(f"\n{'=' * 55}\nMULTI-HOP GRAPH X-RAY FOR: {ticker}  (tenant: {tenant})\n{'=' * 55}")

    print("\n[Track 1 + 3] Headline -> business unit -> governing filing -> superseded filing:")
    rows = graph.query(Q.Q_TRACE, {"ticker": ticker}).result_set
    if not rows:
        print("  (no catalysts linked yet; run: python ingest_company.py", ticker + ")")
    for _cid, sent, src, title, unit, dec, old, url in rows:
        print(f'  [{sent}] ({src}) "{title}"')
        print(f"    -> {unit} | filing {dec} | replaced {old} | {url or 'no url'}")

    print("\n[Track 1] Shared-shareholder contagion across supply-chain links:")
    for rel, partner, holder, pct_c, pct_p, _ in graph.query(Q.Q_EXPOSURE, {"ticker": ticker}).result_set:
        if holder:
            print(f"  {holder} holds {ticker} ({pct_c}%) and {partner} ({pct_p}%), linked by {rel}")
        else:
            print(f"  {ticker} --[{rel}]--> {partner} (no shared institutional holder in graph)")

    print("\n[Track 2] Agent handoffs and memory for this tenant:")
    for ep_ticker, price, _sum, next_agent, status, done in memory_graph.query(Q.Q_MEMORY, {"uid": tenant}).result_set:
        print(f"  {ep_ticker} @ ${price}: upstream done {done} -> {next_agent} ({status})")
    for t, q, _ts in memory_graph.query(Q.Q_INTERACTIONS, {"uid": tenant}).result_set:
        print(f"  asked about {t}: {q}")


if __name__ == "__main__":
    run_explainable_analysis(sys.argv[1] if len(sys.argv) > 1 else "GOOGL", sys.argv[2] if len(sys.argv) > 2 else DEFAULT_TENANT)

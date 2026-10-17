"""Tests that need no database/network.  Run: python -m pytest -q   (or: python tests/test_pure.py)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import graphdb  # noqa: E402
from ingest_company import parse_sec_submissions, supersede_pairs, tag_sentiment, unit_suffix  # noqa: E402


def raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    return False


def test_sentiment_uses_word_boundaries():
    assert tag_sentiment("He said the chair maintains it") == "NEUTRAL"   # old code: 'ai' inside 'said' -> BULLISH
    assert tag_sentiment("Record growth as AI demand surges") == "BULLISH"
    assert tag_sentiment("Antitrust probe and lawsuit raise risk") == "BEARISH"


def test_unit_routing():
    assert unit_suffix("New GPU cloud deal") == "AI & Cloud Infrastructure"
    assert unit_suffix("Dividend announced") == "Core Revenue Engine"


def test_ticker_validation():
    assert graphdb.normalize_ticker(" googl ") == "GOOGL"
    assert graphdb.normalize_ticker("BRK-B") == "BRK-B"
    for bad in ["", "A B", "GOOGL;DROP", "x" * 12, "1ABC", "../etc"]:
        assert raises(graphdb.InvalidInput, lambda b=bad: graphdb.normalize_ticker(b)), bad


def test_tenant_allow_list():
    assert graphdb.normalize_tenant(None) == graphdb.DEFAULT_TENANT
    assert graphdb.normalize_tenant("hedge_fund_alpha_graph") == "hedge_fund_alpha_graph"
    for bad in ["fin_company_brain", "somebody_elses_graph", "a b", "*"]:
        assert raises(graphdb.InvalidInput, lambda b=bad: graphdb.normalize_tenant(b)), bad


SAMPLE = {"filings": {"recent": {
    "form": ["8-K", "10-Q", "10-Q", "10-K", "10-Q", "10-Q", "10-K"],
    "accessionNumber": ["0-1", "0000000000-26-000003", "0000000000-26-000002", "0000000000-25-000009",
                        "0000000000-25-000008", "0000000000-25-000007", "0000000000-24-000001"],
    "filingDate": ["2026-05-01", "2026-04-20", "2025-10-20", "2025-02-01", "2025-07-20", "2025-04-20", "2024-02-01"],
    "primaryDocument": ["a.htm", "q3.htm", "q2.htm", "k.htm", "q1.htm", "x.htm", "k24.htm"],
    "primaryDocDescription": ["", "10-Q", "10-Q", "10-K", "10-Q", "10-Q", "10-K"]}}}


def test_sec_parsing_and_lineage():
    f = parse_sec_submissions(SAMPLE, 1652044)
    assert [x["form"] for x in f].count("10-Q") == 3 and [x["form"] for x in f].count("10-K") == 2   # 8-K ignored, capped
    assert f[0]["filed_at"] == "2026-04-20"
    assert f[0]["url"] == "https://www.sec.gov/Archives/edgar/data/1652044/000000000026000003/q3.htm"
    pairs = supersede_pairs(f)
    assert ("0000000000-26-000003", "0000000000-26-000002") in pairs           # 10-Q supersedes older 10-Q
    assert all(a != b for a, b in pairs) and len(pairs) == 3                  # 2 for 10-Q chain, 1 for 10-K chain


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)

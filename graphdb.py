"""Single place for FalkorDB connection settings and input validation.

Everything that touches user input (ticker, tenant) goes through normalize_* so a request can never
pick an arbitrary graph name or inject text into a Cypher string.
"""
import os
import re

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is optional at runtime
    pass

COMPANY_GRAPH = os.getenv("COMPANY_GRAPH", "fin_company_brain")
DEFAULT_TENANT = "investor_memory_tenant_1"
# Tenants are an allow-list: each one is its own isolated FalkorDB graph (Track 2 isolation).
ALLOWED_TENANTS = [
    t.strip()
    for t in os.getenv("TENANTS", f"{DEFAULT_TENANT},hedge_fund_alpha_graph,retail_desk_isolated").split(",")
    if t.strip()
]
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}([.\-][A-Z]{1,2})?$")

_db = None


class InvalidInput(ValueError):
    """Raised for a bad ticker or tenant (the API turns this into HTTP 400)."""


def get_db():
    global _db
    if _db is None:
        from falkordb import FalkorDB  # imported lazily so pure helpers/tests work without the driver
        _db = FalkorDB(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            password=os.getenv("FALKORDB_PASSWORD") or None,
        )
    return _db


def company_graph():
    return get_db().select_graph(COMPANY_GRAPH)


def normalize_ticker(value) -> str:
    t = (value or "").strip().upper()
    if not TICKER_RE.match(t):
        raise InvalidInput(f"'{value}' is not a valid ticker symbol")
    return t


def normalize_tenant(value) -> str:
    t = (value or DEFAULT_TENANT).strip()
    if t not in ALLOWED_TENANTS:
        raise InvalidInput(f"Unknown tenant '{value}'. Allowed: {', '.join(ALLOWED_TENANTS)}")
    return t


def tenant_graph(tenant):
    return get_db().select_graph(normalize_tenant(tenant))

"""Health check for FalkorDB. Unlike the old test_connection.py it leaves nothing behind.
Run: python scripts/check_connection.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from graphdb import get_db  # noqa: E402

g = get_db().select_graph("healthcheck_tmp")
g.query("CREATE (:Ping {ok: true})")
print("FalkorDB reachable; rows:", g.query("MATCH (p:Ping) RETURN count(p)").result_set[0][0])
g.delete()
print("temporary graph removed")

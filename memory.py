"""Track 2: per-tenant episodic memory and agent handoffs, stored in the tenant's own FalkorDB graph.

Schema (in graph <tenant>):
  (Investor)-[:HAD_EPISODE]->(Episode)-[:RAN_TASK]->(AgentTask)         pipeline run and its agents
  (Episode)-[:SPAWNED_TASK]->(Quant AgentTask)-[:DEPENDS_ON]->(upstream AgentTask)   the handoff
  (Investor)-[:ASKED]->(Interaction)                                    what this investor asked before
"""
import hashlib
import time

from graphdb import tenant_graph


def record_pipeline(tenant, ticker, price, steps, run_id):
    """Store one harvest run. `steps` = [{agent, key, status, detail}, ...] reflecting what REALLY ran."""
    g = tenant_graph(tenant)
    ts = int(time.time())
    done = [s["agent"] for s in steps if s["status"] == "completed"]
    summary = f"Analyzed {ticker}: {len(done)}/{len(steps)} agents completed"
    g.query(
        """
        MERGE (u:Investor {id: $tenant})
        MERGE (ep:Episode {id: $run_id})
        SET ep.ticker = $ticker, ep.price_at_check = $price, ep.ts = $ts, ep.summary = $summary
        MERGE (u)-[:HAD_EPISODE]->(ep)
        """,
        {"tenant": tenant, "run_id": run_id, "ticker": ticker, "price": float(price or 0), "ts": ts, "summary": summary},
    )
    for s in steps:
        g.query(
            """
            MATCH (ep:Episode {id: $run_id})
            MERGE (t:AgentTask {id: $tid})
            SET t.agent = $agent, t.status = $status, t.detail = $detail, t.finished_at = $ts, t.run_id = $run_id
            MERGE (ep)-[:RAN_TASK]->(t)
            """,
            {"run_id": run_id, "tid": f"{run_id}_{s['key']}", "agent": s["agent"], "status": s["status"],
             "detail": str(s.get("detail", ""))[:200], "ts": ts},
        )
    g.query(
        """
        MATCH (ep:Episode {id: $run_id})
        MERGE (q:AgentTask {id: $qid})
        SET q.agent = 'Graph_Quant_Agent', q.status = 'ready_for_execution', q.run_id = $run_id
        MERGE (ep)-[:SPAWNED_TASK]->(q)
        WITH q
        MATCH (p:AgentTask {run_id: $run_id}) WHERE p.id <> $qid
        MERGE (q)-[:DEPENDS_ON]->(p)
        """,
        {"run_id": run_id, "qid": f"{run_id}_quant"},
    )


def record_interaction(tenant, ticker, question, answer):
    """Remember what was asked and close the Quant agent's task for the latest run of this ticker."""
    g = tenant_graph(tenant)
    ts = int(time.time())
    iid = hashlib.sha1(f"{tenant}{ts}{question}".encode()).hexdigest()[:12]
    g.query(
        """
        MERGE (u:Investor {id: $tenant})
        CREATE (i:Interaction {id: $iid, ticker: $ticker, question: $q, answer_digest: $a, ts: $ts})
        MERGE (u)-[:ASKED]->(i)
        """,
        {"tenant": tenant, "iid": iid, "ticker": ticker, "q": question[:500], "a": answer[:400], "ts": ts},
    )
    g.query(
        """
        MATCH (u:Investor {id: $tenant})-[:HAD_EPISODE]->(ep:Episode {ticker: $ticker})
        WITH ep ORDER BY ep.ts DESC LIMIT 1
        MATCH (ep)-[:SPAWNED_TASK]->(q:AgentTask {agent: 'Graph_Quant_Agent'})
        SET q.status = 'completed', q.finished_at = $ts, q.detail = $detail
        """,
        {"tenant": tenant, "ticker": ticker, "ts": ts, "detail": f"answered: {question[:80]}"},
    )


def recall(tenant, ticker, limit=3):
    """Earlier questions this tenant asked about this ticker (read back into the agent's prompt)."""
    rows = tenant_graph(tenant).query(
        f"""
        MATCH (:Investor {{id: $tenant}})-[:ASKED]->(i:Interaction {{ticker: $ticker}})
        RETURN i.question, i.answer_digest, i.ts
        ORDER BY i.ts DESC LIMIT {int(limit)}
        """,
        {"tenant": tenant, "ticker": ticker},
    ).result_set
    return [{"question": r[0], "answer_digest": r[1], "ts": r[2]} for r in rows]

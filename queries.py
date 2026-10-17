"""All Cypher the product depends on (rule 10: 'the Cypher queries or graph algorithms the product depends on').

server.py, query_agent.py and the LangGraph tools should import from here so the explanation shown
to judges is the same Cypher that actually runs.
"""

# ---- Track 1: connected-data reasoning ---------------------------------------------------------
# Shared-shareholder contagion: an institution that holds BOTH the company and one of its
# supply-chain/revenue counterparties is a channel through which trouble at one reaches the other.
# (Company)-[partner link]->(Partner) and (Institution)-[:HOLDS_SHARES]->(both) is a 3-hop pattern.
Q_EXPOSURE = """
MATCH (c:Company {ticker: $ticker})-[rel]->(p:Company)
OPTIONAL MATCH (i:Institution)-[h1:HOLDS_SHARES]->(c), (i)-[h2:HOLDS_SHARES]->(p)
WHERE h1.invalid_at IS NULL AND h2.invalid_at IS NULL
RETURN type(rel) AS rel_type, p.ticker AS partner, i.name AS holder,
       h1.pct AS pct_in_company, h2.pct AS pct_in_partner,
       coalesce(h1.pct, 0.0) + coalesce(h2.pct, 0.0) AS combined
ORDER BY combined DESC
LIMIT 15
"""

# Catalyst -> business unit -> filing that governs the unit -> the filing it superseded.
Q_TRACE = """
MATCH (cat:SocialCatalyst)-[:IMPACTS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu)
OPTIONAL MATCH (dec)-[:SUPERSEDES]->(old:FilingDecision)
RETURN cat.id, cat.sentiment, cat.source, cat.title, bu.name, dec.id, old.id, dec.url
LIMIT 6
"""

# ---- Track 3: company brain -------------------------------------------------------------------
Q_COMPANY = "MATCH (c:Company {ticker: $ticker}) RETURN c.name, c.price, c.market_cap, c.sector, c.summary, c.data_source, c.last_updated"

Q_EXECUTIVES = "MATCH (e:Executive)-[:LEADS_COMPANY]->(c:Company {ticker: $ticker}) RETURN e.name, e.title LIMIT 4"

# Which filing currently governs each business unit, and which filing did it replace.
Q_SEC_UNITS = """
MATCH (dec:FilingDecision)-[:GOVERNS_UNIT]->(bu:BusinessUnit)<-[:OPERATES_UNIT]-(c:Company {ticker: $ticker})
OPTIONAL MATCH (dec)-[:SUPERSEDES]->(old:FilingDecision)
RETURN DISTINCT bu.name, dec.id, dec.summary, old.id, dec.url, dec.form, dec.filed_at, dec.source
"""

# Full filing lineage: follow SUPERSEDES edges back through earlier filings of the same form.
Q_LINEAGE = """
MATCH (f:FilingDecision)-[:FILED_BY]->(c:Company {ticker: $ticker})
OPTIONAL MATCH (f)-[:SUPERSEDES]->(old:FilingDecision)
RETURN f.id, f.form, f.filed_at, f.url, f.source, old.id
ORDER BY f.filed_at DESC
"""

# ---- Track 2: per-tenant memory + agent handoffs (runs on the tenant's own graph) ---------------
# The Quant agent is unlocked only when upstream agents are 'completed': handoff expressed as edges.
Q_MEMORY = """
MATCH (u:Investor {id: $uid})-[:HAD_EPISODE]->(ep:Episode)
MATCH (ep)-[:SPAWNED_TASK]->(t:AgentTask)-[:DEPENDS_ON]->(pre:AgentTask)
WHERE pre.status = 'completed'
RETURN ep.ticker, ep.price_at_check, ep.summary, t.agent, t.status, collect(pre.agent)
ORDER BY ep.ts DESC
LIMIT 5
"""

Q_INTERACTIONS = """
MATCH (:Investor {id: $uid})-[:ASKED]->(i:Interaction)
RETURN i.ticker, i.question, i.ts
ORDER BY i.ts DESC
LIMIT 5
"""

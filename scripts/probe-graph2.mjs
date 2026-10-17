import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
const tests = {
  decisions: ["MATCH (d:Decision) WHERE size($words) = 0 OR size([w IN $words WHERE toLower(d.title + ' ' + d.rationale) CONTAINS w]) >= $minHits OPTIONAL MATCH (d)-[:DERIVED_FROM]->(doc:Document) OPTIONAL MATCH (per:Person)-[:DECIDED]->(d) OPTIONAL MATCH (d)-[:MENTIONS]->(c:Company) WITH d, collect(DISTINCT doc.title) AS sources, collect(DISTINCT per.name) AS deciders, collect(DISTINCT c.ticker) AS tickers RETURN {title: d.title, date: d.date, rationale: d.rationale, status: d.status, sources: sources, deciders: deciders, tickers: tickers} AS row", { words: ["overweight"], minHits: 1 }],
  org: ["MATCH (t:Team) OPTIONAL MATCH (per:Person)-[:MEMBER_OF]->(t) OPTIONAL MATCH (pr:Project)-[:OWNED_BY]->(t) OPTIONAL MATCH (lead:Person)-[:LEADS]->(pr) WITH t, collect(DISTINCT per.name) AS members, collect(DISTINCT {name: pr.name, status: pr.status, lead: lead.name}) AS projects RETURN {team: t.name, focus: t.focus, members: members, projects: projects} AS row", {}],
  labels: ["MATCH (n) RETURN head(labels(n)) AS lab, count(n) AS cnt", {}],
};
for (const [k, [text, params]] of Object.entries(tests)) {
  try { const r = await g.query(text, { params }); console.log("OK", k, "→", JSON.stringify(r.data).slice(0, 300)); }
  catch (e) { console.log("FAIL", k, "→", String(e.message).slice(0, 300)); }
}
await lite.close();

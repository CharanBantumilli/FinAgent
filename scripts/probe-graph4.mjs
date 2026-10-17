import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
const tries = [
  ["link empty props", "MATCH (a {key: $src}), (b {key: $dst}) MERGE (a)-[r:MENTIONS]->(b) SET r += $props RETURN a.key AS row", { src: "Document:q3-investment-committee-memo", dst: "Company:NVDA", props: {} }],
  ["link no SET", "MATCH (a {key: $src}), (b {key: $dst}) MERGE (a)-[r:DERIVED_FROM]->(b) RETURN a.key AS row", { src: "Decision:overweight-nvda-position", dst: "Document:q3-investment-committee-memo", props: {} }],
  ["link props filled", "MATCH (a {key: $src}), (b {key: $dst}) MERGE (a)-[r:DECIDED]->(b) SET r += $props RETURN a.key AS row", { src: "Person:Mira Chen", dst: "Decision:overweight-nvda-position", props: { seeded: true } }],
];
for (const [k, text, params] of tries) {
  try { const r = await g.query(text, { params }); console.log("OK", k, "→", JSON.stringify(r.data).slice(0, 120)); }
  catch (e) { console.log("FAIL", k, "→", String(e.message).slice(0, 200)); }
}
const r2 = await g.query("MATCH (d:Decision {title:'Overweight NVDA position'})-[r]-(x) RETURN type(r) AS t, head(labels(x)) AS l LIMIT 10");
console.log("decision edges now →", JSON.stringify(r2.data));
await lite.close();

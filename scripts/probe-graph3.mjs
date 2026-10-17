import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
for (const q of [
  ["edge types", "MATCH ()-[r]->() RETURN type(r) AS t, count(r) AS c"],
  ["decision edges", "MATCH (d:Decision {title:'Overweight NVDA position'})-[r]-(x) RETURN type(r) AS t, head(labels(x)) AS l LIMIT 10"],
  ["doc edges", "MATCH (d:Document)-[r:MENTIONS]->(c) RETURN count(r) AS c"],
]) {
  try { const r = await g.query(q[1]); console.log(q[0], "→", JSON.stringify(r.data).slice(0, 400)); }
  catch (e) { console.log(q[0], "ERR", e.message); }
}
await lite.close();

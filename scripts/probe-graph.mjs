import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
for (const q of [
  ["labels", "MATCH (n) RETURN head(labels(n)) AS lab, count(n) AS cnt"],
  ["decision sample", "MATCH (d:Decision) RETURN properties(d) AS row LIMIT 2"],
  ["row form", "MATCH (d:Document) RETURN d.key AS row LIMIT 2"],
  ["team", "MATCH (t:Team) RETURN properties(t) AS row LIMIT 1"],
]) {
  try { const r = await g.query(q[1]); console.log(q[0], "→", JSON.stringify(r.data).slice(0, 220)); }
  catch (e) { console.log(q[0], "ERR", e.message); }
}
await lite.close();

import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
const q = async (label, text, params = {}) => {
  try { const r = await g.query(text, { params }); console.log(label, "→", JSON.stringify(r.data).slice(0, 260)); }
  catch (e) { console.log(label, "ERR", e.message); }
};
await q("edges by type", "MATCH ()-[r]->() RETURN type(r) AS t, count(r) AS c");
await q("ASML outgoing", "MATCH (a:Company {ticker:'ASML'})-[r]-(b) RETURN type(r) AS t, b.ticker AS d");
await q("varlen plain", "MATCH path = (sup:Company {ticker:'ASML'})-[:SUPPLIES*1..3]->(dep:Company) RETURN dep.ticker AS t, length(path) AS h");
await q("decision edges", "MATCH (d:Decision)-[r]-(x) RETURN type(r) AS t, count(r) AS c");
await lite.close();

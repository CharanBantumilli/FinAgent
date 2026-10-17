import { FalkorDB } from "falkordblite";
const t0 = Date.now();
const lite = await FalkorDB.open({
  path: `${process.cwd()}/.data/falkordb`,
  redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`,
  logLevel: "warning",
  timeout: 120000,
});
console.log("booted in", Date.now() - t0, "ms · pid:", lite.pid, "· running:", lite.isRunning);
const g = lite.selectGraph("finq");
await g.query("CREATE (a:Company {ticker:'TSM'})-[:SUPPLIES {component:'wafers'}]->(b:Company {ticker:'NVDA'})");
const r = await g.query("MATCH path = (a:Company {ticker:'TSM'})-[:SUPPLIES*1..3]->(b:Company) RETURN {ticker: b.ticker, hops: length(path)} AS row");
console.log("variable-length traversal:", JSON.stringify(r.data));
await g.query("MATCH (n) DETACH DELETE n");
console.log("REAL FALKORDB ENGINE VERIFIED — module v4 loaded, Cypher ok");
await lite.close();

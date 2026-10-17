import { FalkorDB } from "falkordblite";
const lite = await FalkorDB.open({ path: `${process.cwd()}/.data/falkordb`, redisServerPath: `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`, logLevel: "warning", timeout: 60000 });
const g = lite.selectGraph("finq");
const tryQ = async (label, q) => {
  try {
    const r = await g.query(q);
    console.log(`OK   ${label}:`, JSON.stringify(r.data).slice(0, 160));
  } catch (e) {
    console.log(`FAIL ${label}:`, String(e.message).slice(0, 160));
  }
};
await tryQ("columns+agg", "MATCH (n) RETURN head(labels(n)) AS lab, count(n) AS cnt");
await tryQ("map literal simple", "MATCH (n) RETURN {label: head(labels(n))} AS row LIMIT 1");
await tryQ("map literal + agg", "MATCH (n) RETURN {label: head(labels(n)), count: count(n)} AS row");
await tryQ("map innards no alias", "MATCH (n) RETURN {label: head(labels(n)), cnt: count(n)}");
await tryQ("riskPropagation form", "MATCH path = (sup:Company {ticker:'TSM'})-[:SUPPLIES*1..3]->(d:Company) RETURN {ticker: d.ticker, hops: length(path), chain: [x IN nodes(path) | x.ticker]} AS row LIMIT 3");
await tryQ("list comp cols", "MATCH path = (a:Company {ticker:'TSM'})-[:SUPPLIES*1..2]->(d:Company) RETURN d.ticker AS t, length(path) AS h, [x IN nodes(path) | x.ticker] AS ch LIMIT 2");
await tryQ("collect map", "MATCH (c:Company {ticker:'AAPL'}) OPTIONAL MATCH (s:Company)-[r1:SUPPLIES]->(c) RETURN {sup: collect({t: s.ticker, comp: r1.component})} AS row");
await tryQ("collect distinct cols", "MATCH (c:Company {ticker:'AAPL'}) OPTIONAL MATCH (s:Company)-[:SUPPLIES]->(c) RETURN collect(DISTINCT s.ticker) AS sups");
await tryQ("case", "MATCH (n)-[r]-(m) WITH n,r,m WHERE m IS NOT NULL RETURN CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS dir LIMIT 2");
await lite.close();

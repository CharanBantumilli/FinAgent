/**
 * Market data plane — real-time(-ish) quotes.
 *
 * Primary source: stooq.com delayed quotes (no API key required).
 * When the network feed is unreachable, a deterministic synthetic
 * walk keeps the desk demoable, clearly labeled `simulated`.
 * Fresh quotes are persisted into the graph as Quote nodes so
 * every answer traces back to graph state.
 */

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  ts: number;
  source: "stooq-delayed" | "simulated";
}

export interface HistoryPoint {
  date: string;
  close: number;
}

const BASE_PRICES: Record<string, number> = {
  AAPL: 232, MSFT: 428, NVDA: 138, GOOGL: 178, AMZN: 205, META: 585,
  TSLA: 248, JPM: 242, XOM: 118, AMD: 122, INTC: 21, AVGO: 172,
  TSM: 195, ASML: 690, ORCL: 175, CRM: 330, NFLX: 900, DIS: 112,
  BA: 158, GE: 178, PLTR: 66, COIN: 265,
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function syntheticQuote(ticker: string): Quote {
  const base = BASE_PRICES[ticker] ?? 50 + (hash(ticker) % 40000) / 100;
  const bucket = Math.floor(Date.now() / 60_000); // moves minute to minute
  const r1 = ((hash(`${ticker}:${bucket}`) % 2000) - 1000) / 1000; // -1..1
  const r2 = ((hash(`${ticker}:d:${Math.floor(bucket / 1440)}`) % 2000) - 1000) / 1000;
  const drift = Math.sin(bucket / 97 + hash(ticker) % 7) * 0.004;
  const price = Math.max(1, base * (1 + r1 * 0.006 + drift));
  const changePct = r1 * 1.4 + r2 * 0.8;
  return {
    ticker,
    price: Math.round(price * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    volume: 5_000_000 + (hash(ticker + bucket) % 40_000_000),
    ts: Date.now(),
    source: "simulated",
  };
}

async function stooqQuote(ticker: string): Promise<Quote | null> {
  try {
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const csv = (await res.text()).trim();
    const line = csv.split("\n").pop() ?? "";
    const cols = line.split(",");
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = Number(cols[6]);
    const open = Number(cols[3]);
    if (!Number.isFinite(close) || cols[0] === "N/D" || close === 0) return null;
    const changePct = open ? ((close - open) / open) * 100 : 0;
    return {
      ticker,
      price: close,
      changePct: Math.round(changePct * 100) / 100,
      open,
      high: Number(cols[4]),
      low: Number(cols[5]),
      volume: Number(cols[7]),
      ts: Date.now(),
      source: "stooq-delayed",
    };
  } catch {
    return null;
  }
}

export async function getQuote(ticker: string): Promise<Quote> {
  const t = ticker.toUpperCase();
  const live = await stooqQuote(t);
  return live ?? syntheticQuote(t);
}

export async function getQuotes(tickers: string[]): Promise<Quote[]> {
  return Promise.all(tickers.map((t) => getQuote(t)));
}

export async function getHistory(
  ticker: string,
  days = 60,
): Promise<{ points: HistoryPoint[]; source: Quote["source"] }> {
  const t = ticker.toUpperCase();
  try {
    const url = `https://stooq.com/q/d/l/?s=${t.toLowerCase()}.us&i=d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split("\n").slice(1);
      const pts = lines
        .map((l) => {
          const c = l.split(",");
          return { date: c[0], close: Number(c[4]) };
        })
        .filter((p) => Number.isFinite(p.close))
        .slice(-days);
      if (pts.length > 5) return { points: pts, source: "stooq-delayed" };
    }
  } catch {
    /* fall through */
  }
  // synthetic random walk back from today's synthetic price
  const today = syntheticQuote(t).price;
  const pts: HistoryPoint[] = [];
  let price = today;
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const r = ((hash(`${t}:hist:${d.toISOString().slice(0, 10)}`) % 2000) - 1000) / 1000;
    price = Math.max(1, price / (1 + r * 0.018));
    pts.push({ date: d.toISOString().slice(0, 10), close: Math.round(price * 100) / 100 });
  }
  return { points: pts, source: "simulated" };
}

export async function marketStatus(): Promise<{ live: boolean; checked: string }> {
  const q = await stooqQuote("AAPL");
  return { live: !!q, checked: new Date().toISOString() };
}

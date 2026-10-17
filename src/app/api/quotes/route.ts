import { getQuotes } from "@/lib/market";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("tickers") ?? "AAPL,NVDA,MSFT";
  const tickers = q
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 12);
  const quotes = await getQuotes(tickers);
  return Response.json({ quotes });
}

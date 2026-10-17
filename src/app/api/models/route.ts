import { getOllamaBase, ollamaUp } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const [up, base] = await Promise.all([ollamaUp(), getOllamaBase()]);
  return Response.json({ ok: up.up, base, models: up.models });
}

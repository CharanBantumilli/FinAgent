/** LLM helpers — LangChain ChatOllama when a local runtime is up. */

export async function getOllamaBase(): Promise<string> {
  return process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

export async function ollamaUp(): Promise<{ up: boolean; models: string[] }> {
  try {
    const base = await getOllamaBase();
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { up: false, models: [] };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { up: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { up: false, models: [] };
  }
}

export async function chatText(opts: {
  system: string;
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { ChatOllama } = await import("@langchain/ollama");
  const base = await getOllamaBase();
  const status = await ollamaUp();
  if (!status.up) throw new Error("ollama offline");
  const model =
    opts.model && status.models.includes(opts.model)
      ? opts.model
      : (status.models[0] ?? "llama3.1:8b");
  const llm = new ChatOllama({
    baseUrl: base,
    model,
    temperature: opts.temperature ?? 0.2,
    numPredict: opts.maxTokens ?? 500,
  });
  const res = await llm.invoke([
    ["system", opts.system],
    ["human", opts.prompt],
  ]);
  const content = res.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

export async function chatJson<T>(opts: {
  system: string;
  prompt: string;
  temperature?: number;
}): Promise<T> {
  const raw = await chatText({ ...opts, maxTokens: 800 });
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in LLM output");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

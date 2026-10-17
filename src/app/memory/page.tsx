"use client";

import React, { useState } from "react";
import { BrainCircuit, Clock3, Wrench } from "lucide-react";
import { api, usePoll, type MemoryDTO } from "@/lib/client";
import { Chip, Empty, Panel, SectionHead } from "@/components/ui";

const TABS = [
  { k: "episodic", label: "Episodic", icon: Clock3, desc: "Conversation turns persisted as Episode nodes — recall spans sessions." },
  { k: "semantic", label: "Semantic", icon: BrainCircuit, desc: "Facts the desk learned; deduped on write, confidence grows on confirmation." },
  { k: "procedural", label: "Procedural", icon: Wrench, desc: "How the desk works — playbooks and policies." },
] as const;

export default function MemoryPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["k"]>("semantic");
  const [tenant, setTenant] = useState("desk-1");
  const memory = usePoll<MemoryDTO>(
    () => api(`/api/memory?tenant=${encodeURIComponent(tenant)}`),
    4000,
    [tenant],
  );
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState("semantic");
  const [busy, setBusy] = useState(false);

  const items = (memory.data?.memory ?? []).filter(
    (m) => tab === "episodic" || m.kind === tab,
  );
  const episodes = memory.data?.episodic ?? [];
  const filtered = q
    ? items.filter((m) => m.text.toLowerCase().includes(q.toLowerCase()))
    : items;
  const filteredEp = q
    ? episodes.filter((e) => e.content.toLowerCase().includes(q.toLowerCase()))
    : episodes;

  async function store(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api("/api/memory", {
        method: "POST",
        body: JSON.stringify({ tenant, kind, text }),
      });
      setText("");
      memory.refresh();
    } finally {
      setBusy(false);
    }
  }

  const active = TABS.find((t) => t.k === tab)!;

  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1100px] mx-auto">
      <div className="eyebrow mb-3">Track 2 · Persistent, shared, per-tenant</div>
      <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
        Graph <span className="clip-acid">Memory</span>
      </h1>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mt-6 pb-10">
        <div className="xl:col-span-4 flex flex-col gap-4">
          <Panel corners>
            <div className="eyebrow mb-2">Tenant scope</div>
            <input
              className="input mono text-[11px]"
              value={tenant}
              onChange={(e) => setTenant(e.target.value || "desk-1")}
            />
            <p className="mono text-[9.5px] mt-3 leading-relaxed" style={{ color: "var(--faint)" }}>
              Every memory node carries its tenant. Agents recall only within
              scope — high-concurrency reads/writes, no cross-tenant bleed.
            </p>
          </Panel>

          <Panel>
            <SectionHead k="Write" title="Store memory" />
            <form onSubmit={store} className="flex flex-col gap-3">
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="semantic">semantic · fact</option>
                <option value="procedural">procedural · how-to</option>
              </select>
              <textarea
                className="textarea"
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. Our NVDA stop-loss is 8% below cost basis."
              />
              <button className="btn btn-acid" disabled={busy || !text.trim()}>
                {busy ? <span className="spinner" /> : null} Store in graph
              </button>
            </form>
          </Panel>
        </div>

        <div className="xl:col-span-8">
          <Panel pad={false} className="h-full">
            <div className="flex border-b" style={{ borderColor: "var(--line)" }}>
              {TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.k}
                    onClick={() => setTab(t.k)}
                    className="flex-1 flex items-center justify-center gap-2 py-3 mono text-[10px] uppercase tracking-[0.16em] bg-transparent border-0 cursor-pointer"
                    style={{
                      color: tab === t.k ? "var(--acid)" : "var(--dim)",
                      borderBottom: tab === t.k ? "1px solid var(--acid)" : "1px solid transparent",
                      marginBottom: -1,
                    }}
                  >
                    <Icon size={11} /> {t.label}
                    <Chip tone="dim">
                      {t.k === "episodic"
                        ? episodes.length
                        : (memory.data?.memory ?? []).filter((m) => m.kind === t.k).length}
                    </Chip>
                  </button>
                );
              })}
            </div>

            <div className="p-4 border-b flex items-center gap-3" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
              <input
                className="input mono text-[11px] py-2 flex-1"
                placeholder={`search ${tab} memory…`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <p className="mono text-[9.5px] px-5 pt-3" style={{ color: "var(--faint)" }}>
              {active.desc}
            </p>

            {tab === "episodic" ? (
              filteredEp.length === 0 ? (
                <Empty>No episodes recalled — chat with the desk first</Empty>
              ) : (
                filteredEp.map((e, i) => (
                  <div key={i} className="px-5 py-3 border-t flex gap-3" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                    <span className={`chip flex-none ${e.role === "user" ? "chip-acid" : "chip-cyan"}`}>{e.role}</span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] leading-relaxed truncate" style={{ color: "var(--txt)" }}>
                        {e.content}
                      </div>
                      <div className="mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>
                        session #{e.sessionId} · {new Date(Number(e.ts)).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))
              )
            ) : filtered.length === 0 ? (
              <Empty>Nothing stored in this drawer</Empty>
            ) : (
              filtered.map((m, i) => (
                <div key={i} className="px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <div className="flex items-center gap-2">
                    <Chip tone={m.kind === "procedural" ? "violet" : "cyan"}>{m.kind}</Chip>
                    {!!m.topic && <Chip tone="dim">{String(m.topic)}</Chip>}
                    <span className="mono text-[9px] ml-auto" style={{ color: "var(--faint)" }}>
                      confidence ×{Number(m.confidence ?? 1)}
                    </span>
                  </div>
                  <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--txt)" }}>{m.text}</p>
                  <div className="mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>
                    {new Date(Number(m.ts)).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

"use client";

import React, { useState } from "react";
import { FilePlus2, Gavel, PersonStanding } from "lucide-react";
import { api, usePoll, type BrainDTO } from "@/lib/client";
import { Chip, Empty, Panel, SectionHead } from "@/components/ui";

export default function BrainPage() {
  const brain = usePoll<BrainDTO>(() => api("/api/brain"), 5000);
  const [form, setForm] = useState<null | "document" | "decision" | "person">(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const data = brain.data;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { type: form };
    fd.forEach((v, k) => (payload[k] = v));
    if (payload.sources)
      payload.sources = String(payload.sources)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    try {
      await api("/api/brain", { method: "POST", body: JSON.stringify(payload) });
      (e.target as HTMLFormElement).reset();
      setForm(null);
      brain.refresh();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-3">Track 3 · Connected institutional knowledge</div>
          <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
            Company <span className="clip-acid">Brain</span>
          </h1>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setForm(form === "document" ? null : "document")}>
            <FilePlus2 size={11} /> Ingest doc
          </button>
          <button className="btn" onClick={() => setForm(form === "decision" ? null : "decision")}>
            <Gavel size={11} /> Record decision
          </button>
          <button className="btn" onClick={() => setForm(form === "person" ? null : "person")}>
            <PersonStanding size={11} /> Add person
          </button>
        </div>
      </div>

      {/* ingest form */}
      {form && (
        <Panel corners className="mt-6">
          <SectionHead k="Write to graph" title={form === "document" ? "Ingest document" : form === "decision" ? "Record decision" : "Add person"} />
          <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {form === "person" ? (
              <>
                <label>
                  <span className="eyebrow block mb-2">Name</span>
                  <input name="name" className="input" required placeholder="Ada Lovelace" />
                </label>
                <label>
                  <span className="eyebrow block mb-2">Role</span>
                  <input name="role" className="input" placeholder="Analyst" />
                </label>
                <label>
                  <span className="eyebrow block mb-2">Team</span>
                  <select name="team" className="select">
                    {(data?.org ?? []).map((t) => (
                      <option key={t.team} value={t.team}>{t.team}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="md:col-span-2">
                  <span className="eyebrow block mb-2">Title</span>
                  <input name="title" className="input" required placeholder={form === "document" ? "Q4 supply chain memo" : "Increase AMD position"} />
                </label>
                {form === "document" ? (
                  <label className="md:col-span-2">
                    <span className="eyebrow block mb-2">Body — mentions of known companies auto-link as MENTIONS edges</span>
                    <textarea name="body" className="textarea" rows={5} placeholder="Paste the text…" />
                  </label>
                ) : (
                  <>
                    <label className="md:col-span-2">
                      <span className="eyebrow block mb-2">Rationale</span>
                      <textarea name="rationale" className="textarea" rows={3} placeholder="Why was this decided…" />
                    </label>
                    <label>
                      <span className="eyebrow block mb-2">Decided by</span>
                      <input name="decidedBy" className="input" placeholder="Mira Chen" />
                    </label>
                    <label>
                      <span className="eyebrow block mb-2">Source documents (comma separated titles)</span>
                      <input name="sources" className="input" placeholder="Q3 Investment Committee Memo" />
                    </label>
                  </>
                )}
              </>
            )}
            <div className="md:col-span-2 flex gap-3 items-center">
              <button type="submit" className="btn btn-acid" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                Write to graph
              </button>
              {err && <span className="mono text-[10px]" style={{ color: "var(--red)" }}>{err}</span>}
            </div>
          </form>
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mt-6 pb-10">
        {/* org */}
        <div className="xl:col-span-4">
          <Panel pad={false} className="h-full">
            <div className="p-5 pb-0">
              <SectionHead k="Who owns what" title="Org graph" />
            </div>
            {(data?.org ?? []).map((t) => (
              <div key={t.team} className="px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                <div className="font-bold text-[14px]">{t.team}</div>
                <div className="mono text-[9.5px] uppercase tracking-[0.12em] mt-0.5" style={{ color: "var(--faint)" }}>{t.focus}</div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {t.members.map((m) => (
                    <span key={m} className="chip chip-amber">{m}</span>
                  ))}
                </div>
                {t.projects.length > 0 && (
                  <div className="mt-3 flex flex-col gap-1.5">
                    {t.projects.map((p) => (
                      <div key={p.name} className="panel-inset px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-[12.5px]">{p.name}</span>
                        <span className="mono text-[9px]" style={{ color: "var(--cyan)" }}>
                          {p.status}{p.lead ? ` · ${p.lead}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!data && <Empty>Loading…</Empty>}
          </Panel>
        </div>

        {/* decisions */}
        <div className="xl:col-span-5">
          <Panel pad={false} className="h-full">
            <div className="p-5 pb-0">
              <SectionHead
                k="Provenance"
                title="Decision trace"
                right={<Chip tone="red">{(data?.decisions ?? []).length} logged</Chip>}
              />
            </div>
            {(data?.decisions ?? []).map((d) => (
              <div key={d.title} className="px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[14px]">{d.title}</span>
                  <Chip tone={d.status === "active" ? "acid" : "dim"}>{d.status}</Chip>
                  <span className="mono text-[9px]" style={{ color: "var(--faint)" }}>{d.date}</span>
                </div>
                <p className="text-[12.5px] leading-relaxed mt-2" style={{ color: "var(--dim)" }}>{d.rationale}</p>
                <div className="mono text-[9.5px] mt-3 leading-relaxed" style={{ color: "var(--faint)" }}>
                  <div>DECIDED_BY → <span style={{ color: "var(--amber)" }}>{d.deciders.join(", ") || "—"}</span></div>
                  <div>DERIVED_FROM → {(d.sources ?? []).map((s) => (
                    <span key={s} style={{ color: "#9FB4C7" }} className="mr-2">“{s}”</span>
                  ))}</div>
                  <div>MENTIONS → <span style={{ color: "var(--acid)" }}>{(d.tickers ?? []).join(" · ") || "—"}</span></div>
                </div>
              </div>
            ))}
            {(data?.decisions ?? []).length === 0 && <Empty>No decisions logged</Empty>}
          </Panel>
        </div>

        {/* documents */}
        <div className="xl:col-span-3">
          <Panel pad={false} className="h-full">
            <div className="p-5 pb-0">
              <SectionHead k="Corpus" title="Documents" />
            </div>
            {(data?.documents ?? []).map((d) => (
              <div key={String(d.title)} className="px-5 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                <div className="font-semibold text-[13.5px]">{String(d.title)}</div>
                <div className="mono text-[9px] mt-1 uppercase tracking-[0.12em]" style={{ color: "var(--faint)" }}>
                  {String(d.date ?? "")} · {String((d.body ?? "")).length} chars
                </div>
                <p className="text-[12px] leading-relaxed mt-2 line-clamp-3" style={{ color: "var(--dim)" }}>
                  {String(d.body ?? "")}
                </p>
              </div>
            ))}
            {(data?.documents ?? []).length === 0 && <Empty>Corpus empty</Empty>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

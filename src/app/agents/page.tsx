"use client";

import React from "react";
import { Workflow } from "lucide-react";
import { api, usePoll, type AgentDTO } from "@/lib/client";
import { Chip, Panel, SectionHead } from "@/components/ui";

const PIPELINE = [
  { key: "START", label: "START", color: "#8b939e" },
  { key: "supervisor", label: "ORCHESTRA", color: "#C6FF4A" },
  { key: "memory", label: "ARCHIVE recall", color: "#5AA9FF" },
  { key: "market", label: "TICKER", color: "#46E0C0" },
  { key: "graph", label: "TOPOLOGY", color: "#8B7CFF" },
  { key: "brain", label: "PROVENANCE", color: "#FFB14A" },
  { key: "synthesize", label: "DESK-WRITER", color: "#FF5470" },
  { key: "scribe", label: "ARCHIVE scribe", color: "#5AA9FF" },
  { key: "END", label: "END", color: "#8b939e" },
];

export default function AgentsPage() {
  const agents = usePoll<{ agents: AgentDTO[] }>(() => api("/api/agents"), 6000);
  const roster = agents.data?.agents ?? [];

  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1400px] mx-auto">
      <div className="eyebrow mb-3">Multi-agent system · LangGraph StateGraph</div>
      <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
        The <span className="clip-acid">Desk</span>
      </h1>

      {/* pipeline diagram */}
      <Panel corners className="mt-6">
        <SectionHead k="Topology" title="Execution graph" right={<Workflow size={14} color="var(--acid)" />} />
        <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
          {PIPELINE.map((n, i) => (
            <React.Fragment key={n.key}>
              <div className="flex-none flex flex-col items-center justify-center px-3">
                <div
                  className="mono text-[9px] font-bold px-2.5 py-2 border text-center whitespace-nowrap"
                  style={{
                    color: n.color,
                    borderColor: `${n.color}88`,
                    background: `${n.color}0d`,
                  }}
                >
                  {n.label}
                </div>
                {(n.key === "market" || n.key === "graph" || n.key === "brain") && (
                  <div className="mono text-[7.5px] mt-1 uppercase tracking-[0.1em]" style={{ color: "var(--faint)" }}>
                    conditional
                  </div>
                )}
              </div>
              {i < PIPELINE.length - 1 && (
                <div className="flex items-center flex-none" style={{ color: "var(--faint)" }}>
                  <svg width="26" height="10">
                    <line x1="0" y1="5" x2="20" y2="5" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
                    <path d="M 19 1 L 25 5 L 19 9" fill="none" stroke="currentColor" strokeWidth="1" />
                  </svg>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
        <p className="mono text-[10px] mt-3" style={{ color: "var(--faint)" }}>
          supervisor plans → memory recalls → specialists fan through the MCP tool plane → synth cites → scribe persists episodic memory. Conditional edges follow the plan.
        </p>
      </Panel>

      {/* roster */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4 pb-10">
        {roster.map((a) => (
          <Panel key={a.key} pad={false}>
            <div className="flex items-center gap-4 p-5 pb-3">
              <div
                className="flex-none w-[46px] h-[46px] flex items-center justify-center mono font-bold text-[13px] border relative"
                style={{ color: a.color, borderColor: a.color, background: `${a.color}10` }}
              >
                {a.callsign}
                <span className="sdot ok absolute" style={{ top: -3, right: -3 }} />
              </div>
              <div className="min-w-0">
                <div className="font-extrabold tracking-tight text-[16px]">{a.name}</div>
                <div className="mono text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--dim)" }}>
                  {a.role}
                </div>
              </div>
              <div className="ml-auto mono text-[9px]" style={{ color: "var(--faint)" }}>
                {a.runs} runs
              </div>
            </div>
            <div className="px-5 pb-4">
              <div className="text-[12px] italic" style={{ color: "var(--dim)" }}>
                “{a.directive}”
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <Chip tone="dim">{a.model}</Chip>
                <Chip tone="dim">temp {a.temperature.toFixed(1)}</Chip>
              </div>
              <div className="eyebrow mt-4 mb-2">MCP tools</div>
              <div className="flex flex-wrap gap-1.5">
                {a.tools
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((t) => (
                    <span key={t} className="chip" style={{ color: a.color, borderColor: `${a.color}44` }}>
                      {t}
                    </span>
                  ))}
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

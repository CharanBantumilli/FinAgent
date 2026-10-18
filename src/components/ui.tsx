"use client";

import React from "react";

export function Panel({
  className = "",
  children,
  corners = false,
  pad = true,
}: {
  className?: string;
  children: React.ReactNode;
  corners?: boolean;
  pad?: boolean;
}) {
  return (
    <div className={`panel ${pad ? "p-5" : ""} ${className}`}>
      {corners && (
        <>
          <i className="c c-tl" />
          <i className="c c-tr" />
          <i className="c c-bl" />
          <i className="c c-br" />
        </>
      )}
      {children}
    </div>
  );
}

export function SectionHead({
  k,
  title,
  right,
}: {
  k: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <div className="eyebrow">{k}</div>
        <h2 className="text-lg font-bold uppercase tracking-tight mt-1">
          {title}
        </h2>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export type Tone = "acid" | "cyan" | "blue" | "violet" | "amber" | "red" | "dim";

export function Chip({
  tone = "dim",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span className={`chip ${tone === "dim" ? "" : `chip-${tone}`}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  queued: "amber",
  running: "acid",
  completed: "cyan",
  failed: "red",
  pending: "dim",
  in_progress: "acid",
  done: "cyan",
};

export function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "dim";
  return (
    <Chip tone={tone}>
      {(status === "running" || status === "in_progress") && (
        <span className="spinner" style={{ width: 8, height: 8 }} />
      )}
      {status.replace("_", " ")}
    </Chip>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "var(--txt)",
  live = false,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: string;
  live?: boolean;
}) {
  return (
    <Panel className="relative overflow-hidden" corners>
      <div className="flex items-center justify-between">
        <div className="eyebrow">{label}</div>
        {live && <span className="sdot ok" />}
      </div>
      <div
        className="mono font-bold mt-3"
        style={{ fontSize: "clamp(30px, 3.6vw, 44px)", lineHeight: 1, color: tone }}
      >
        {value}
      </div>
      {sub && <div className="mono text-[10px] mt-3 uppercase tracking-[0.15em]" style={{ color: "var(--faint)" }}>{sub}</div>}
    </Panel>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono text-[11px] uppercase tracking-[0.18em] text-center py-10" style={{ color: "var(--faint)" }}>
      {children}
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  system: "#8b939e",
  delegation: "#8b7cff",
  thought: "#5aa9ff",
  result: "#46e0c0",
  error: "#ff5470",
  report: "#c6ff4a",
};

export function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? "#8b939e";
}

export function LogLine({
  time,
  tag,
  color,
  content,
}: {
  time: string;
  tag: string;
  color: string;
  content: string;
}) {
  return (
    <div className="logline flex gap-3 px-4 py-[3px] hover:bg-white/[0.02]">
      <span style={{ color: "var(--faint)" }} className="flex-none">{time}</span>
      <span className="flex-none w-[92px] truncate" style={{ color }}>
        {tag}
      </span>
      <span className="flex-1" style={{ color: "#aeb6bf" }}>{content}</span>
    </div>
  );
}

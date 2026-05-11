// /roster — agent cards styled like the mockup: avatar + name header, message
// body, stat sidebar, sparkline, and contextual CTA buttons (Review / Needs
// Help / Open Files depending on roster_status.cta + tone).

import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuLoader, LuPause, LuPlay, LuZap, LuSettings, LuMessageSquare,
  LuFileText, LuEllipsis, LuArrowUpDown,
} from "react-icons/lu";
import { api, type Environment, type RosterEntry, type Session } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Page } from "../components/Page";
import { humanCron } from "../lib/cron";

type Tone = "ok" | "warn" | "running" | "idle";
type SortKey = "last_run" | "next_run" | "name";
type FilterKey = "all" | "needs_review" | "running" | "paused";

const STATUS_CFG: Record<string, { dot: string; label: string }> = {
  warn:    { dot: "#f97316", label: "Needs Review" },
  running: { dot: "#8b5cf6", label: "On It"        },
  ok:      { dot: "#22c55e", label: "Done"          },
  idle:    { dot: "#94a3b8", label: "Standby"       },
  paused:  { dot: "#94a3b8", label: "Paused"        },
};

export function RosterPage() {
  const { data, isLoading, mutate } = useApi<{ data: RosterEntry[] }>("/schedules/roster");
  const nav = useNavigate();
  const [sort, setSort] = useState<SortKey>("last_run");
  const [filter, setFilter] = useState<FilterKey>("all");
  const allEntries = data?.data ?? [];

  const entries = useMemo(() => {
    let list = [...allEntries];
    if (filter === "needs_review") list = list.filter(e => derive(e).tone === "warn");
    else if (filter === "running") list = list.filter(e => derive(e).tone === "running");
    else if (filter === "paused") list = list.filter(e => e.status === "paused");
    list.sort((a, b) => {
      if (sort === "name") return a.agent.name.localeCompare(b.agent.name);
      if (sort === "next_run") return a.next_run_at.localeCompare(b.next_run_at);
      return (b.last_run_at ?? "").localeCompare(a.last_run_at ?? "");
    });
    return list;
  }, [allEntries, sort, filter]);

  const reviewCount = allEntries.filter(e => derive(e).tone === "warn").length;

  const SORT_LABELS: Record<SortKey, string> = { last_run: "Last run", next_run: "Next run", name: "Name" };
  const FILTER_CYCLE: FilterKey[] = ["all", "needs_review", "running", "paused"];
  const FILTER_LABELS: Record<FilterKey, string> = {
    all: "All agents",
    needs_review: `Needs Review${reviewCount > 0 ? ` (${reviewCount})` : ""}`,
    running: "Running",
    paused: "Paused",
  };

  return (
    <Page title="Roster" subtitle="Your agents on the clock.">
      <div className="px-6 py-4 min-h-full">
        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-5">
          <button
            onClick={() => setFilter(f => {
              const i = FILTER_CYCLE.indexOf(f);
              return FILTER_CYCLE[(i + 1) % FILTER_CYCLE.length];
            })}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-neutral-200 bg-white text-sm text-ink-700 hover:border-neutral-300 hover:shadow-sm transition-all"
          >
            {filter !== "all" && (
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: filter === "needs_review" ? "#f97316" : filter === "running" ? "#8b5cf6" : "#94a3b8" }}
              />
            )}
            {FILTER_LABELS[filter]}
            <span className="text-ink-300 text-xs">▾</span>
          </button>

          <button
            onClick={() => setSort(s => s === "last_run" ? "next_run" : s === "next_run" ? "name" : "last_run")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-neutral-200 bg-white text-sm text-ink-700 hover:border-neutral-300 hover:shadow-sm transition-all ml-auto"
          >
            <LuArrowUpDown className="size-3.5 text-ink-400" />
            Sort: {SORT_LABELS[sort]}
          </button>
        </div>

        {isLoading ? (
          <div className="text-sm text-ink-500 flex items-center gap-2 py-8">
            <LuLoader className="animate-spin size-4" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title={filter !== "all" ? "No agents match this filter" : "No agents scheduled yet"}
            body={filter !== "all" ? "Try clearing the filter above." : "Open an agent and add a schedule from the Schedule tab."}
          />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-6xl">
            {entries.map(e => (
              <RosterCard key={e.id} entry={e} onChanged={() => mutate()} onSettings={() => nav(`/agents/${e.agent.id}`)} />
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

async function startChat(entry: RosterEntry): Promise<Session> {
  const fresh = await api.get<{ data: Environment[] }>("/environments");
  let env = fresh.data?.[0];
  if (!env) {
    env = await api.post<Environment>("/environments", {
      name: "Default",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    refresh("/environments");
  }
  return api.post<Session>("/sessions", {
    agent_id: entry.agent.id,
    environment_id: env.id,
    title: `Chat with ${entry.agent.name}`,
  });
}

function RosterCard({
  entry, onChanged, onSettings,
}: { entry: RosterEntry; onChanged: () => void; onSettings: () => void }) {
  const status = derive(entry);
  const nav = useNavigate();
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);

  const cfgKey = entry.status === "paused" ? "paused" : status.tone;
  const cfg = STATUS_CFG[cfgKey] ?? STATUS_CFG.idle;
  const rs = entry.last_session?.roster_status;
  const [,, orbMid, orbDark] = orbTheme(entry.agent.id);

  // Derive primary CTA
  let ctaLabel = "Chat";
  let ctaIsHighlighted = false;
  if (rs?.cta === "open_files") {
    ctaLabel = "Open Files";
  } else if (status.tone === "warn") {
    ctaLabel = "Review";
    ctaIsHighlighted = true;
  } else if (entry.last_session?.status === "idle") {
    ctaLabel = "Needs Help";
    ctaIsHighlighted = true;
  }

  async function openPrimary() {
    if (opening) return;
    if (rs?.cta === "open_files") {
      if (entry.last_session) nav(`/runs/${entry.last_session.id}`);
      return;
    }
    // Open the chat page and let the user start/configure the session there
    nav("/chat", { state: { newChatAgentId: entry.agent.id } });
  }

  function openLogs() {
    if (entry.last_session) nav(`/runs/${entry.last_session.id}`);
  }

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    const paused = entry.status === "paused";
    setBusy("toggle");
    try {
      await api.patch(`/schedules/${entry.id}`, { status: paused ? "active" : "paused" });
      onChanged();
    } catch (err) {
      alert(`Could not ${paused ? "resume" : "pause"}: ${(err as Error).message}`);
    } finally { setBusy(null); }
  }

  async function runNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy("run");
    try {
      if (entry.status === "paused") await api.patch(`/schedules/${entry.id}`, { status: "active" });
      await api.post(`/schedules/${entry.id}/run`);
      onChanged();
    } catch (err) {
      alert(`Could not run: ${(err as Error).message}`);
    } finally { setBusy(null); }
  }

  const accent = entry.agent.accent || "#6366f1";

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_20px_rgba(0,0,0,0.03)] flex flex-col overflow-hidden">
      {/* Avatar banner */}
      <div
        className="flex justify-center pt-5 pb-4"
        style={{ background: `linear-gradient(160deg, ${accent}12 0%, ${accent}06 100%)` }}
      >
        <OrbAvatar seed={entry.agent.id} size={72} />
      </div>

      {/* Name + status */}
      <div className="px-4 pb-3 text-center">
        <h3 className="text-[14px] font-medium text-ink-900 leading-tight">{entry.agent.name}</h3>
        <div className="text-[11px] text-ink-400 mt-0.5">{entry.name}</div>
        <div className="flex items-center justify-center mt-2">
          {cfgKey === "warn" ? (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border"
              style={{ backgroundColor: orbMid + "20", color: orbDark, borderColor: orbMid + "50" }}
            >
              <span className="size-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: orbMid }} />
              {cfg.label}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: cfg.dot }} />
              <span className="text-[10px] uppercase tracking-widest text-ink-500 font-medium">{cfg.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* Message body */}
      <div className="px-4 pb-3 flex-1">
        <p className="text-sm text-ink-600 leading-relaxed">
          {status.tone === "running" && (
            <LuLoader className="inline size-3 mr-1 -mt-0.5 animate-spin text-violet-400" />
          )}
          {stripMd(status.message)}
        </p>
      </div>

      {/* Stats row */}
      <div className="mx-4 mb-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-neutral-50 px-3 py-2">
          <div className="text-[10px] text-ink-400 uppercase tracking-wide">Last run</div>
          <div className="text-sm font-medium text-ink-800 mt-0.5">
            {entry.last_run_at ? relative(entry.last_run_at) : "Never"}
          </div>
        </div>
        <div className="rounded-xl bg-neutral-50 px-3 py-2">
          <div className="text-[10px] text-ink-400 uppercase tracking-wide">Next run</div>
          <div className={`text-sm font-medium mt-0.5 ${entry.status !== "paused" && new Date(entry.next_run_at) < new Date() ? "text-orange-500" : "text-ink-800"}`}>
            {entry.status === "paused" ? "—" : relative(entry.next_run_at)}
          </div>
        </div>
      </div>

      {/* Footer action row */}
      <div className="border-t border-neutral-100 flex divide-x divide-neutral-100">
        <FooterBtn
          label={opening ? "Opening…" : ctaLabel}
          highlighted={ctaIsHighlighted}
          accentBg={orbMid}
          icon={rs?.cta === "open_files" ? <LuFileText className="size-3.5" /> : <LuMessageSquare className="size-3.5" />}
          onClick={openPrimary}
          disabled={opening}
        />
        <FooterBtn
          label="Ask"
          icon={<LuMessageSquare className="size-3.5" />}
          onClick={openPrimary}
        />
        <FooterBtn
          label="Logs"
          onClick={openLogs}
          disabled={!entry.last_session}
        />
        <MoreBtn
          paused={entry.status === "paused"}
          busy={busy}
          onToggle={toggle}
          onRunNow={runNow}
          onSettings={onSettings}
        />
      </div>
    </div>
  );
}


function FooterBtn({
  label, icon, highlighted, accentBg, onClick, disabled,
}: {
  label: string;
  icon?: React.ReactNode;
  highlighted?: boolean;
  accentBg?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-all disabled:opacity-40"
      style={highlighted
        ? { backgroundColor: accentBg ?? "#171717", color: "#fff" }
        : { color: "#6b7280" }
      }
      onMouseEnter={e => { if (!highlighted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#f9fafb"; }}
      onMouseLeave={e => { if (!highlighted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
    >
      {icon}
      {label}
    </button>
  );
}

function MoreBtn({
  paused, busy, onToggle, onRunNow, onSettings,
}: {
  paused: boolean;
  busy: "toggle" | "run" | null;
  onToggle: (e: React.MouseEvent) => void;
  onRunNow: (e: React.MouseEvent) => void;
  onSettings: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);

  function openMenu() {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        className="w-10 py-2.5 flex items-center justify-center text-ink-400 hover:text-ink-600 hover:bg-neutral-50 transition-colors"
      >
        <LuEllipsis className="size-4" />
      </button>
      {pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
          <div
            className="fixed z-50 bg-white border border-neutral-200 rounded-xl shadow-lg py-1 min-w-[140px] text-sm"
            style={{ top: pos.top, right: pos.right }}
          >
            <button
              className="w-full px-3 py-1.5 text-left text-ink-700 hover:bg-neutral-50 flex items-center gap-2"
              onClick={(e) => { setPos(null); onToggle(e); }}
            >
              {busy === "toggle"
                ? <LuLoader className="size-3.5 animate-spin" />
                : paused ? <LuPlay className="size-3.5" /> : <LuPause className="size-3.5" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-ink-700 hover:bg-neutral-50 flex items-center gap-2"
              onClick={(e) => { setPos(null); onRunNow(e); }}
            >
              {busy === "run" ? <LuLoader className="size-3.5 animate-spin" /> : <LuZap className="size-3.5" />}
              Run now
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-ink-700 hover:bg-neutral-50 flex items-center gap-2"
              onClick={() => { setPos(null); onSettings(); }}
            >
              <LuSettings className="size-3.5" />
              Settings
            </button>
          </div>
        </>
      )}
    </>
  );
}


// [veryLight, light, mid, deep] per hue — high contrast for distinct rays
const ORB_THEMES: [string, string, string, string][] = [
  ["#ccf7fe", "#67e0f5", "#0ea5c9", "#083060"],  // cyan-blue (like reference)
  ["#bbf7d0", "#4ade80", "#16a34a", "#052e16"],  // emerald
  ["#ede9fe", "#c4b5fd", "#7c3aed", "#1e0a50"],  // violet
  ["#bae6fd", "#7dd3fc", "#0284c7", "#082050"],  // sky
  ["#fce7f3", "#f9a8d4", "#db2777", "#500030"],  // rose
  ["#fef9c3", "#fde047", "#ca8a04", "#451a03"],  // amber
  ["#d1fae5", "#6ee7b7", "#059669", "#022c22"],  // teal
  ["#e0e7ff", "#a5b4fc", "#4f46e5", "#1e1b4b"],  // indigo
];

function orbTheme(seed: string): [string, string, string, string] {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return ORB_THEMES[(h >>> 0) % ORB_THEMES.length];
}

function OrbAvatar({ seed, size = 72 }: { seed: string; size?: number }) {
  const [vl, l, m, d] = useMemo(() => orbTheme(seed), [seed]);

  const blurA = Math.round(size * 0.08);
  const blurB = Math.round(size * 0.06);

  return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", position: "relative", flexShrink: 0 }}>
      {/* Base fill */}
      <div style={{ position: "absolute", inset: 0, background: l }} />

      {/* Layer A: slow CW — wide light wedges */}
      <div
        className="orb-spin-a"
        style={{
          position: "absolute",
          width: "260%", height: "260%",
          top: "-80%", left: "-80%",
          background: `conic-gradient(from 0deg,
            ${vl}, ${l}, ${vl}, ${m}, ${l},
            ${vl}, ${l}, ${vl}, ${m}, ${l},
            ${vl}, ${l}, ${vl}, ${m}, ${l}, ${vl})`,
          filter: `blur(${blurA}px)`,
        }}
      />

      {/* Layer B: faster CCW — narrow deep wedges, creates interference */}
      <div
        className="orb-spin-b"
        style={{
          position: "absolute",
          width: "240%", height: "240%",
          top: "-70%", left: "-70%",
          background: `conic-gradient(from 0deg,
            ${d}, ${d}, ${m}, ${l}, ${m},
            ${d}, ${d}, ${m}, ${l}, ${m}, ${d})`,
          filter: `blur(${blurB}px)`,
          opacity: 0.72,
        }}
      />

      {/* Edge darkening for sphere depth */}
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(circle at 50% 50%, transparent 30%, ${d}55 68%, ${d}aa 100%)`,
      }} />

      {/* Glass highlight */}
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(circle at 34% 28%, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0.05) 42%, transparent 58%)`,
      }} />
    </div>
  );
}

function derive(entry: RosterEntry): { message: string; tone: Tone } {
  if (entry.status === "paused") return { message: "On break.", tone: "idle" };
  const ls = entry.last_session;
  if (!ls) return { message: "Pinned and waiting for the first shift.", tone: "idle" };
  const rs = ls.roster_status;
  if (rs?.summary) return { message: snippet(rs.summary) ?? rs.summary, tone: rs.tone };
  const said = snippet(ls.latest_message);
  const thought = snippet(ls.latest_thinking);
  if (ls.status === "running" || ls.status === "rescheduling") {
    return { message: thought ?? said ?? "Working on it…", tone: "running" };
  }
  if (ls.status === "idle") return { message: said ?? "Got something I need from you.", tone: "warn" };
  if (ls.status === "terminated") return { message: said ?? ls.title ?? "All wrapped up.", tone: "ok" };
  return { message: said ?? ls.title ?? ls.status, tone: "idle" };
}

function stripMd(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function snippet(text: string | null | undefined, max = 80): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  if (abs < 60_000) return ms < 0 ? "Just now" : "In <1m";
  const sign = ms >= 0 ? "In " : "";
  const tail = ms < 0 ? " ago" : "";
  if (min < 60) return `${sign}${min}m${tail}`;
  if (hr < 24) return `${sign}${hr}h${tail}`;
  return `${sign}${day}d${tail}`;
}

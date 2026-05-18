import React, { lazy, Suspense, useState, useMemo } from "react";

const LazyChartView = lazy(() =>
  import("../components/ChartView").then((m) => ({ default: m.ChartView }))
);
import { useNavigate } from "react-router-dom";
import {
  LuLoader, LuPause, LuPlay, LuZap, LuSettings, LuMessageSquare,
  LuFileText, LuEllipsis, LuArrowUpDown,
} from "react-icons/lu";
import { api, type RosterEntry } from "../lib/api";
import { useApi } from "../lib/swr";
import { EmptyState, Page } from "../components/Page";
import { OrbAvatar, orbTheme } from "../components/OrbAvatar";
import { PressedSpinner } from "../components/PressedSpinner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
        <div className="flex items-center gap-2 mb-5">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full gap-2"
            onClick={() => setFilter(f => {
              const i = FILTER_CYCLE.indexOf(f);
              return FILTER_CYCLE[(i + 1) % FILTER_CYCLE.length];
            })}
          >
            {filter !== "all" && (
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: filter === "needs_review" ? "#f97316" : filter === "running" ? "#8b5cf6" : "#94a3b8" }}
              />
            )}
            {FILTER_LABELS[filter]}
            <span className="text-muted-foreground text-xs">▾</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="rounded-full gap-1.5 ml-auto"
            onClick={() => setSort(s => s === "last_run" ? "next_run" : s === "next_run" ? "name" : "last_run")}
          >
            <LuArrowUpDown className="size-3.5" />
            Sort: {SORT_LABELS[sort]}
          </Button>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-8">
            <PressedSpinner size={18} /> Loading…
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

  let ctaLabel = "Chat";
  let ctaIsHighlighted = false;
  if (rs?.cta === "open_files") {
    ctaLabel = "Open Files";
  } else if (status.tone === "warn") {
    ctaLabel = "Review";
    ctaIsHighlighted = true;
  }

  async function openPrimary() {
    if (opening) return;
    if (rs?.cta === "open_files") {
      if (entry.last_session) nav(`/runs/${entry.last_session.id}`);
      return;
    }
    nav("/chat", { state: { newChatAgentId: entry.agent.id } });
  }

  function openLogs() {
    if (entry.last_session) nav(`/runs/${entry.last_session.id}`);
  }

  async function toggle() {
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

  async function runNow() {
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
    <div className="bg-card rounded-2xl border border-border shadow-sm flex flex-col overflow-hidden">
      <div
        className="flex justify-center pt-5 pb-4"
        style={{ background: `linear-gradient(160deg, ${accent}12 0%, ${accent}06 100%)` }}
      >
        <OrbAvatar seed={entry.agent.id} size={72} />
      </div>

      {rs?.cta === "open_files" && rs?.file_name && (
        <button
          type="button"
          onClick={openPrimary}
          className="w-full px-4 py-2.5 flex items-center gap-3 border-b border-border text-left transition-opacity hover:opacity-80"
          style={{ backgroundColor: cfg.dot + "18" }}
        >
          <div
            className="size-7 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: cfg.dot + "30" }}
          >
            <LuFileText className="size-3.5" style={{ color: cfg.dot }} />
          </div>
          <div className="min-w-0 flex-1">
            {rs.label && (
              <div className="text-[10px] font-bold uppercase tracking-wide leading-none mb-0.5" style={{ color: cfg.dot }}>
                {rs.label}
              </div>
            )}
            <div className="text-[11px] text-foreground/80 truncate">{rs.file_name}</div>
          </div>
        </button>
      )}

      <div className={`px-4 pb-3 text-center ${rs?.cta === "open_files" && rs?.file_name ? "pt-3" : ""}`}>
        <h3 className="text-[14px] font-medium leading-tight">{entry.agent.name}</h3>
        <div className="text-[11px] text-muted-foreground mt-0.5">{entry.name}</div>
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
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">{cfg.label}</span>
            </span>
          )}
        </div>
      </div>

      <div className="px-4 pb-3 flex-1">
        <p className="text-sm text-foreground/70 leading-relaxed">
          {status.tone === "running" && (
            <PressedSpinner size={12} className="inline-block mr-1 -mt-0.5 align-middle" />
          )}
          {stripMd(status.message)}
        </p>
      </div>

      {rs?.chart && (
        <div className="px-3 pb-3">
          <Suspense fallback={<div className="h-[60px] rounded-lg bg-muted/30 animate-pulse" />}>
            <LazyChartView spec={rs.chart} compact />
          </Suspense>
        </div>
      )}

      <div className="mx-4 mb-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-muted/50 px-3 py-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Last run</div>
          <div className="text-sm font-medium mt-0.5">
            {entry.last_run_at ? relative(entry.last_run_at) : "Never"}
          </div>
        </div>
        <div className="rounded-xl bg-muted/50 px-3 py-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Next run</div>
          <div className={`text-sm font-medium mt-0.5 ${entry.status !== "paused" && new Date(entry.next_run_at) < new Date() ? "text-orange-500" : ""}`}>
            {entry.status === "paused" ? "—" : relative(entry.next_run_at)}
          </div>
        </div>
      </div>

      <div className="border-t border-border flex divide-x divide-border">
        <button
          type="button"
          disabled={opening}
          onClick={openPrimary}
          className="flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
          style={ctaIsHighlighted
            ? { backgroundColor: orbMid, color: "#fff" }
            : { color: "var(--muted-foreground)" }
          }
          onMouseEnter={e => { if (!ctaIsHighlighted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--muted)"; }}
          onMouseLeave={e => { if (!ctaIsHighlighted) (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
        >
          {rs?.cta === "open_files" ? <LuFileText className="size-3.5" /> : <LuMessageSquare className="size-3.5" />}
          {opening ? "Opening…" : ctaLabel}
        </button>

        <button
          type="button"
          onClick={openLogs}
          disabled={!entry.last_session}
          className="flex-1 py-2.5 text-xs font-medium text-muted-foreground flex items-center justify-center gap-1.5 transition-colors hover:bg-muted/50 disabled:opacity-40"
        >
          Logs
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="w-10 py-2.5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <LuEllipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem onClick={toggle}>
              {busy === "toggle"
                ? <LuLoader className="size-3.5 animate-spin" />
                : entry.status === "paused" ? <LuPlay className="size-3.5" /> : <LuPause className="size-3.5" />}
              {entry.status === "paused" ? "Resume" : "Pause"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={runNow}>
              {busy === "run" ? <LuLoader className="size-3.5 animate-spin" /> : <LuZap className="size-3.5" />}
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSettings}>
              <LuSettings className="size-3.5" />
              Settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
  if (ls.status === "idle") {
    const isScheduled = ls.trigger_summary?.startsWith("schedule:");
    if (isScheduled) return { message: said ?? ls.title ?? "Completed.", tone: "ok" };
    return { message: said ?? "Got something I need from you.", tone: "warn" };
  }
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


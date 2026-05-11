// /roster — agents-on-payroll, rendered as a corkboard of sticky notes. Each
// agent gets a deterministic paper color + tilt, a "tape" strip, a rubber-
// stamped status badge, the agent's emoji as a watermark, and a tear-off mono
// footer with the schedule. Click the note to continue chatting; hover to
// reveal pause / run / settings actions in the corner.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuLoader, LuPause, LuPlay, LuZap, LuSettings,
} from "react-icons/lu";
import { api, type Environment, type RosterEntry, type Session } from "../lib/api";
import { refresh, useApi } from "../lib/swr";
import { EmptyState, Page } from "../components/Page";
import { humanCron } from "../lib/cron";

export function RosterPage() {
  const { data, isLoading, mutate } = useApi<{ data: RosterEntry[] }>("/schedules/roster");
  const nav = useNavigate();
  const entries = data?.data ?? [];

  return (
    <Page
      title="Roster"
      subtitle="Notes from your agents on payroll."
    >
      {/* Subtle corkboard backdrop: warm paper-ish tone with a faint dot grid. */}
      <div
        className="p-8 min-h-full"
        style={{
          backgroundColor: "#f5efe4",
          backgroundImage:
            "radial-gradient(circle, rgba(120,95,60,0.18) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      >
        {isLoading ? (
          <div className="text-sm text-ink-500">Loading…</div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="No agents scheduled yet"
            body="Pin your first note: open an agent and add a schedule from the Schedule tab."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8 pt-2">
            {entries.map((e) => (
              <RosterTile
                key={e.id}
                entry={e}
                onChanged={() => mutate()}
                onSettings={() => nav(`/agents/${e.agent.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

// Mirror AgentDetailPage's session-bootstrap: pick the latest environment, or
// create a default one if none exists, then POST /sessions like /runs does.
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

// Deterministic per-id helpers so notes don't visually shuffle on every render.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Real Post-it-ish pastels. Arbitrary hex so we get the desk-supply feel
// instead of the default Tailwind palette.
const PAPERS: Array<{ bg: string; edge: string; ink: string }> = [
  { bg: "#FFF1A6", edge: "#E8D770", ink: "#5b4a14" }, // canary yellow
  { bg: "#FFD3D9", edge: "#F0A6B0", ink: "#5b1f2a" }, // bubblegum pink
  { bg: "#C9E5FF", edge: "#9DC8F2", ink: "#143352" }, // sky
  { bg: "#C9F0CE", edge: "#9CD7A4", ink: "#1c4a26" }, // mint
  { bg: "#E2D6FF", edge: "#BFA9F2", ink: "#352060" }, // lavender
  { bg: "#FFD9B3", edge: "#F2B57E", ink: "#5b3010" }, // peach
];

const TAPES = [
  "rgba(255,255,255,0.55)",
  "rgba(245,222,179,0.6)",   // masking-tape beige
  "rgba(200,220,235,0.55)",  // pale blue
];

function paperFor(id: string) {
  return PAPERS[hash(id) % PAPERS.length];
}
function tiltFor(id: string): number {
  // -2.4..+2.4 deg, in 0.4 steps so tiles feel hand-placed but not chaotic.
  const slot = hash(id + "tilt") % 13;
  return (slot - 6) * 0.4;
}
function tapeFor(id: string) {
  const tape = TAPES[hash(id + "tape") % TAPES.length];
  const skew = (hash(id + "skew") % 11) - 5; // -5..+5 deg
  const offset = (hash(id + "off") % 30) - 15; // -15..+15 px from center
  return { tape, skew, offset };
}

type Tone = "ok" | "warn" | "running" | "idle";

const STAMP: Record<Tone, { label: string; color: string }> = {
  ok:      { label: "DONE",       color: "#1f7a3a" },
  warn:    { label: "NEEDS YOU",  color: "#a35a00" },
  running: { label: "ON IT",      color: "#5b2cd1" },
  idle:    { label: "STANDBY",    color: "#5a5a5a" },
};

function RosterTile({
  entry, onSettings, onChanged,
}: { entry: RosterEntry; onSettings: () => void; onChanged: () => void }) {
  const status = derive(entry);
  const nav = useNavigate();
  const [opening, setOpening] = useState(false);
  const paper = paperFor(entry.id);
  const tilt = tiltFor(entry.id);
  const tape = tapeFor(entry.id);
  const stamp = STAMP[status.color];

  async function open() {
    if (opening) return;
    const last = entry.last_session;
    if (last && last.status !== "terminated") {
      nav(`/runs/${last.id}`);
      return;
    }
    setOpening(true);
    try {
      const session = await startChat(entry);
      refresh("/sessions");
      nav(`/runs/${session.id}`);
    } catch (err) {
      alert(`Could not start chat: ${(err as Error).message}`);
      setOpening(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      aria-busy={opening}
      className="group relative cursor-pointer select-none transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:rotate-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      style={{
        transform: `rotate(${tilt}deg)`,
        backgroundColor: paper.bg,
        color: paper.ink,
        border: `1px solid ${paper.edge}`,
        borderRadius: "4px",
        padding: "26px 22px 18px",
        minHeight: 220,
        boxShadow:
          "0 1px 1px rgba(0,0,0,0.08), 0 8px 16px -6px rgba(60,40,10,0.20), 0 18px 28px -10px rgba(60,40,10,0.18)",
      }}
    >
      {/* Tape strip across the top */}
      <span
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          top: -8,
          left: `calc(50% + ${tape.offset}px)`,
          transform: `translateX(-50%) rotate(${tape.skew}deg)`,
          width: 78,
          height: 20,
          background: tape.tape,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.4), 0 1px 2px rgba(0,0,0,0.08)",
        }}
      />

      {/* Watermark emoji in the back */}
      <span
        aria-hidden
        className="absolute pointer-events-none select-none"
        style={{
          right: -6, bottom: -10,
          fontSize: 132,
          opacity: 0.09,
          lineHeight: 1,
          transform: "rotate(-8deg)",
        }}
      >
        {entry.agent.emoji || "🤖"}
      </span>

      {/* Rubber stamp */}
      <span
        aria-hidden
        className="absolute font-mono uppercase tracking-[0.18em] text-[10px] font-bold whitespace-nowrap"
        style={{
          top: 14, right: 18,
          color: stamp.color,
          border: `2px solid ${stamp.color}`,
          borderRadius: 4,
          padding: "2px 8px",
          opacity: 0.8,
          transform: "rotate(-6deg)",
          background: "transparent",
          boxShadow: `inset 0 0 0 1px ${stamp.color}22`,
        }}
      >
        {entry.status === "paused" ? "PAUSED" : stamp.label}
      </span>

      {/* Header: agent name + the job this note is about */}
      <div className="relative pr-24">
        <h3 className="text-2xl font-bold tracking-tight leading-tight">
          {entry.agent.name}
        </h3>
        <div className="text-[11px] font-mono uppercase tracking-[0.15em] opacity-65 mt-1 truncate">
          re: {entry.name}
        </div>
      </div>

      {/* The note — what the agent has to say */}
      <div className="relative mt-4 text-[15px] leading-snug italic opacity-90">
        {status.color === "running" && (
          <LuLoader className="inline size-3.5 mr-1 -mt-0.5 animate-spin opacity-70" />
        )}
        <span className="opacity-50">“</span>
        {status.message}
        <span className="opacity-50">”</span>
      </div>

      {/* Tear-off footer */}
      <div
        className="relative mt-5 pt-2 font-mono text-[10px] uppercase tracking-[0.15em] flex flex-wrap gap-x-3 gap-y-1"
        style={{ borderTop: `1px dashed ${paper.edge}`, opacity: 0.7 }}
      >
        <span>{humanCron(entry.cron, entry.timezone)}</span>
        <span>·</span>
        <span>{entry.last_run_at ? `last ${relative(entry.last_run_at)}` : "never"}</span>
        <span>·</span>
        <span>next {relative(entry.next_run_at)}</span>
        {opening && (
          <>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <LuLoader className="size-3 animate-spin" /> opening
            </span>
          </>
        )}
      </div>

      {/* Hover-revealed actions, tucked at the bottom-right corner */}
      <Actions
        entry={entry}
        onChanged={onChanged}
        onSettings={onSettings}
        ink={paper.ink}
      />
    </div>
  );
}

function Actions({
  entry, onChanged, onSettings, ink,
}: {
  entry: RosterEntry;
  onChanged: () => void;
  onSettings: () => void;
  ink: string;
}) {
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const paused = entry.status === "paused";

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy("toggle");
    try {
      await api.patch(`/schedules/${entry.id}`, { status: paused ? "active" : "paused" });
      onChanged();
    } catch (err) {
      alert(`Could not ${paused ? "resume" : "pause"} schedule: ${(err as Error).message}`);
    } finally { setBusy(null); }
  }

  async function runNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy("run");
    try {
      if (paused) await api.patch(`/schedules/${entry.id}`, { status: "active" });
      await api.post(`/schedules/${entry.id}/run`);
      onChanged();
    } catch (err) {
      alert(`Could not run now: ${(err as Error).message}`);
    } finally { setBusy(null); }
  }

  return (
    <div
      className="absolute bottom-3 right-3 flex items-center gap-0.5 opacity-25 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
      style={{ color: ink }}
    >
      <IconBtn
        title={paused ? "Resume schedule" : "Pause schedule"}
        onClick={toggle}
        loading={busy === "toggle"}
      >
        {paused ? <LuPlay className="size-3.5" /> : <LuPause className="size-3.5" />}
      </IconBtn>
      <IconBtn title="Run now" onClick={runNow} loading={busy === "run"}>
        <LuZap className="size-3.5" />
      </IconBtn>
      <IconBtn
        title="Agent settings"
        onClick={(e) => { e.stopPropagation(); onSettings(); }}
      >
        <LuSettings className="size-3.5" />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  children, onClick, title, loading,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={loading}
      onClick={onClick}
      className="size-7 grid place-items-center rounded-md hover:bg-black/10 disabled:opacity-40 transition-colors"
    >
      {loading ? <LuLoader className="size-3.5 animate-spin" /> : children}
    </button>
  );
}

function derive(entry: RosterEntry): { message: string; color: Tone } {
  if (entry.status === "paused") return { message: "On break.", color: "idle" };
  const ls = entry.last_session;
  if (!ls) return { message: "Pinned and waiting for the first shift.", color: "idle" };
  const said = snippet(ls.latest_message);
  const thought = snippet(ls.latest_thinking);
  if (ls.status === "running" || ls.status === "rescheduling") {
    // Prefer the live thinking summary while in flight — there usually isn't
    // a final agent.message yet. Fall back to the last spoken text, then
    // title.
    return {
      message: thought ?? said ?? (ls.title ? `Working on ${ls.title}…` : "Working on it…"),
      color: "running",
    };
  }
  if (ls.status === "idle") {
    return { message: said ?? "Got something I need from you.", color: "warn" };
  }
  if (ls.status === "terminated") {
    return { message: said ?? ls.title ?? "All wrapped up.", color: "ok" };
  }
  return { message: said ?? ls.title ?? ls.status, color: "idle" };
}

function snippet(text: string | null | undefined, max = 180): string | null {
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
  const sign = ms >= 0 ? "in " : "";
  const tail = ms < 0 ? " ago" : "";
  if (abs < 60_000) return ms < 0 ? "just now" : "in <1m";
  if (min < 60) return `${sign}${min}m${tail}`;
  if (hr < 24) return `${sign}${hr}h${tail}`;
  return `${sign}${day}d${tail}`;
}


// Monochrome marketing timeline.
//
// Every visual cue is a thin white line on a black surface — campaigns,
// metrics, annotations, the time axis. No color.
//
// Schema-driven: pulls campaigns / metrics / annotations from the
// /timeline backend (seeded with realistic 6-month fake data via
// `npm run seed-timeline`).
//
// Interactions:
//   - Time scale picker (1w / 1m / 3m / 6m) — quick presets.
//   - Click a campaign block → visible window zooms to that campaign's span.
//   - Bottom of timeline: a semi-transparent rail overlay shows the full
//     6-month range and the visible bracket on top of it. Drag the bracket
//     center to pan; drag either edge to resize the visible window.
//   - Hover the swimlanes to get a vertical cursor that lights up across
//     all sparklines at the matching x.

import { useEffect, useMemo, useRef, useState } from "react";
import { LuLoader } from "react-icons/lu";
import { api } from "../../../lib/api";
import type {
  TimelineAnnotation,
  TimelineCampaign,
  TimelineChannel,
  TimelineMetricPoint,
} from "../../../lib/api";

type ScaleKey = "1w" | "1m" | "3m" | "6m";
const SCALE_DAYS: Record<ScaleKey, number> = { "1w": 7, "1m": 30, "3m": 90, "6m": 180 };

const METRIC_KINDS = ["sessions", "revenue", "orders", "ctr", "conversion"] as const;
type MetricKind = typeof METRIC_KINDS[number];

const METRIC_LABEL: Record<MetricKind, string> = {
  sessions: "Sessions",
  revenue: "Revenue",
  orders: "Orders",
  ctr: "CTR",
  conversion: "Conv.",
};

const CHANNEL_LABEL: Record<TimelineChannel, string> = {
  email: "Email",
  paid: "Paid",
  organic: "Organic",
  in_store: "In-store",
  retail: "Retail",
  other: "Other",
};

const CHANNELS: TimelineChannel[] = ["email", "paid", "organic", "in_store", "retail"];

export function Timeline({ fullScreen = false }: { fullScreen?: boolean }) {
  const fullRange = useTimelineRange();
  // Visible window is the source of truth — we no longer derive from a
  // single "scale" since edge-drag resize and click-to-zoom can produce
  // arbitrary spans.
  const [[visibleStart, visibleEnd], setWindow] = useState<[number, number]>(() => {
    const end = fullRange.end;
    return [end - SCALE_DAYS["3m"] * 86400_000, end];
  });
  const [hoverX, setHoverX] = useState<number | null>(null);

  const { campaigns, metrics, annotations, loading } = useTimelineData(visibleStart, visibleEnd);

  function setScale(s: ScaleKey) {
    const days = SCALE_DAYS[s];
    setWindow(([_s, e]) => [e - days * 86400_000, e]);
  }
  function zoomToCampaign(c: TimelineCampaign) {
    const start = Date.parse(c.started_at);
    const end = Date.parse(c.ended_at);
    // Add a tiny pad so the campaign block isn't flush against the edges.
    const pad = Math.max((end - start) * 0.1, 86400_000);
    setWindow([
      Math.max(fullRange.start, start - pad),
      Math.min(fullRange.end, end + pad),
    ]);
  }

  return (
    <div className={[
      "bg-black text-zinc-100 border-y border-zinc-900 select-none flex flex-col relative",
      fullScreen ? "h-full" : "",
    ].join(" ")}>
      <Header
        currentSpanDays={(visibleEnd - visibleStart) / 86400_000}
        onScale={setScale}
        windowEnd={visibleEnd}
        visibleStart={visibleStart}
        loading={loading}
      />
      {loading && metrics.length === 0 ? (
        <div className="px-6 py-10 text-zinc-600 text-xs flex items-center gap-2">
          <LuLoader className="size-3 animate-spin" /> Loading timeline…
        </div>
      ) : (
        <div className={fullScreen ? "flex-1 overflow-y-auto pb-20" : "pb-16"}>
          <Sparklines
            metrics={metrics}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
            hoverX={hoverX}
          />
          <Swimlanes
            campaigns={campaigns}
            annotations={annotations}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
            onHoverX={setHoverX}
            onCampaignClick={zoomToCampaign}
            tall={fullScreen}
          />
        </div>
      )}
      {/* Rail floats over the bottom of the timeline, semi-transparent. */}
      <Rail
        fullStart={fullRange.start}
        fullEnd={fullRange.end}
        visibleStart={visibleStart}
        visibleEnd={visibleEnd}
        onWindow={(s, e) => setWindow([s, e])}
      />
    </div>
  );
}

// -----------------------------------------------------------------------
// Data loading

type LoadedData = {
  campaigns: TimelineCampaign[];
  metrics: TimelineMetricPoint[];
  annotations: TimelineAnnotation[];
  loading: boolean;
};

function useTimelineData(visibleStart: number, visibleEnd: number): LoadedData {
  // Always fetch the FULL 6-month window once, then filter client-side.
  // Faster scale changes and smooth drag-pan vs re-fetching per change.
  const [loading, setLoading] = useState(true);
  const [allCampaigns, setAllCampaigns] = useState<TimelineCampaign[]>([]);
  const [allMetrics, setAllMetrics] = useState<TimelineMetricPoint[]>([]);
  const [allAnnotations, setAllAnnotations] = useState<TimelineAnnotation[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const from = new Date(Date.now() - SCALE_DAYS["6m"] * 86400_000).toISOString();
    const to = new Date().toISOString();
    Promise.all([
      api.get<{ data: TimelineCampaign[] }>(`/timeline/campaigns?from=${from}&to=${to}`),
      api.get<{ data: TimelineMetricPoint[] }>(`/timeline/metrics?from=${from}&to=${to}`),
      api.get<{ data: TimelineAnnotation[] }>(`/timeline/annotations?from=${from}&to=${to}`),
    ])
      .then(([c, m, a]) => {
        if (cancelled) return;
        setAllCampaigns(c.data);
        setAllMetrics(m.data);
        setAllAnnotations(a.data);
      })
      .catch((err) => console.warn("[timeline] fetch failed:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const campaigns = useMemo(
    () => allCampaigns.filter((c) =>
      Date.parse(c.ended_at) >= visibleStart && Date.parse(c.started_at) <= visibleEnd,
    ),
    [allCampaigns, visibleStart, visibleEnd],
  );
  const metrics = useMemo(
    () => allMetrics.filter((p) => {
      const t = Date.parse(p.occurred_at);
      return t >= visibleStart && t <= visibleEnd;
    }),
    [allMetrics, visibleStart, visibleEnd],
  );
  const annotations = useMemo(
    () => allAnnotations.filter((a) => {
      const t = Date.parse(a.at);
      return t >= visibleStart && t <= visibleEnd;
    }),
    [allAnnotations, visibleStart, visibleEnd],
  );

  return { campaigns, metrics, annotations, loading };
}

function useTimelineRange() {
  return useMemo(() => {
    const end = Date.now();
    const start = end - SCALE_DAYS["6m"] * 86400_000;
    return { start, end };
  }, []);
}

// -----------------------------------------------------------------------
// Header

function Header({
  currentSpanDays, onScale, visibleStart, windowEnd, loading,
}: {
  currentSpanDays: number;
  onScale: (s: ScaleKey) => void;
  visibleStart: number;
  windowEnd: number;
  loading: boolean;
}) {
  const scales: ScaleKey[] = ["1w", "1m", "3m", "6m"];
  // Highlight the preset that's exactly the current span; otherwise nothing
  // is highlighted (custom range from a campaign click or rail resize).
  const activeScale = scales.find((s) => Math.abs(SCALE_DAYS[s] - currentSpanDays) < 0.5);
  return (
    <div className="px-6 py-3 flex items-center gap-4 border-b border-zinc-900">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Timeline</div>
      <div className="flex">
        {scales.map((s) => (
          <button
            key={s}
            onClick={() => onScale(s)}
            className={[
              "px-3 py-1 text-xs font-medium border border-zinc-800 first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 transition-colors",
              s === activeScale
                ? "bg-zinc-100 text-black border-zinc-100 z-10"
                : "bg-transparent text-zinc-400 hover:text-zinc-100 hover:border-zinc-700",
            ].join(" ")}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500 font-mono">
        {fmtDate(visibleStart)} — {fmtDate(windowEnd)}
        <span className="ml-2 text-zinc-700">· {Math.round(currentSpanDays)}d</span>
      </div>
      {loading && (
        <span className="text-[11px] text-zinc-600 flex items-center gap-1.5">
          <LuLoader className="size-3 animate-spin" /> loading
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Sparklines

function Sparklines({
  metrics, visibleStart, visibleEnd, hoverX,
}: {
  metrics: TimelineMetricPoint[];
  visibleStart: number;
  visibleEnd: number;
  hoverX: number | null;
}) {
  const grouped = useMemo(() => {
    const map = new Map<MetricKind, TimelineMetricPoint[]>();
    for (const k of METRIC_KINDS) map.set(k, []);
    for (const p of metrics) {
      if ((METRIC_KINDS as readonly string[]).includes(p.kind)) {
        map.get(p.kind as MetricKind)!.push(p);
      }
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    }
    return map;
  }, [metrics]);

  return (
    <div className="grid grid-cols-5 border-b border-zinc-900">
      {METRIC_KINDS.map((kind) => (
        <Sparkline
          key={kind}
          kind={kind}
          points={grouped.get(kind) ?? []}
          visibleStart={visibleStart}
          visibleEnd={visibleEnd}
          hoverX={hoverX}
        />
      ))}
    </div>
  );
}

function Sparkline({
  kind, points, visibleStart, visibleEnd, hoverX,
}: {
  kind: MetricKind;
  points: TimelineMetricPoint[];
  visibleStart: number;
  visibleEnd: number;
  hoverX: number | null;
}) {
  const W = 100, H = 100;
  const span = visibleEnd - visibleStart;
  const values = points.map((p) => p.value);
  const total = values.reduce((s, v) => s + v, 0);
  const avg = values.length ? total / values.length : 0;
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const mid = (min + max) / 2;
  const lastHalf = values.slice(Math.floor(values.length / 2));
  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const lastAvg = lastHalf.length ? lastHalf.reduce((s, v) => s + v, 0) / lastHalf.length : 0;
  const firstAvg = firstHalf.length ? firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length : 0;
  const delta = firstAvg ? ((lastAvg - firstAvg) / firstAvg) * 100 : 0;

  const headline = useMemo(() => {
    if (kind === "revenue") return `$${(total).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    if (kind === "ctr" || kind === "conversion") return `${avg.toFixed(2)}%`;
    return total.toLocaleString();
  }, [kind, total, avg]);

  const path = useMemo(() => {
    if (points.length === 0) return "";
    const yRange = max - min || 1;
    return points.map((p, i) => {
      const t = Date.parse(p.occurred_at);
      const x = ((t - visibleStart) / span) * W;
      const y = H - ((p.value - min) / yRange) * H * 0.85 - H * 0.075;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
  }, [points, visibleStart, span, min, max]);

  // Cursor + hovered value (linear-interpolate from the points at hoverX).
  const cursorX = hoverX != null ? hoverX * W : null;
  const hoveredValue = useMemo(() => {
    if (hoverX == null || points.length === 0) return null;
    const t = visibleStart + hoverX * span;
    // Find the two surrounding points and lerp.
    let prev = points[0], next = points[points.length - 1];
    for (let i = 0; i < points.length - 1; i++) {
      const a = Date.parse(points[i].occurred_at);
      const b = Date.parse(points[i + 1].occurred_at);
      if (t >= a && t <= b) { prev = points[i]; next = points[i + 1]; break; }
    }
    const a = Date.parse(prev.occurred_at);
    const b = Date.parse(next.occurred_at);
    const k = b === a ? 0 : (t - a) / (b - a);
    return prev.value + (next.value - prev.value) * k;
  }, [hoverX, points, visibleStart, span]);

  // What number to surface in the headline-row right slot:
  // hovered value when a cursor is present, otherwise the delta %.
  return (
    <div className="px-4 py-3 border-l border-zinc-900 first:border-l-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {METRIC_LABEL[kind]}
        </div>
        {hoveredValue != null ? (
          <div className="text-[10px] font-mono text-zinc-100 tabular-nums">
            {fmtMetric(kind, hoveredValue)}
          </div>
        ) : (
          <div className={[
            "text-[10px] font-mono",
            delta > 0.5 ? "text-zinc-200" : delta < -0.5 ? "text-zinc-500" : "text-zinc-600",
          ].join(" ")}>
            {delta >= 0 ? "+" : ""}{delta.toFixed(1)}%
          </div>
        )}
      </div>
      <div className="text-base font-semibold tracking-tight tabular-nums">
        {headline}
      </div>
      <div className="relative mt-2">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-14">
          {/* gridlines at min/mid/max */}
          {[0.075, 0.5, 0.925].map((y) => (
            <line
              key={y}
              x1="0" x2={W} y1={H * y} y2={H * y}
              stroke="white" strokeOpacity="0.06" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={path} stroke="white" strokeWidth="1" fill="none" vectorEffect="non-scaling-stroke" />
          {cursorX != null && (
            <line x1={cursorX} y1="0" x2={cursorX} y2={H} stroke="white" strokeWidth="0.4" strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* y-axis tick labels overlaid on the right edge */}
        {values.length > 0 && (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between text-[9px] font-mono text-zinc-600 tabular-nums">
            <span className="-mt-0.5">{fmtMetric(kind, max)}</span>
            <span>{fmtMetric(kind, mid)}</span>
            <span className="-mb-0.5">{fmtMetric(kind, min)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Compact, format-aware number rendering for a metric kind. Picks a unit
// suffix when values get large (1.2k / 4.8M / etc.) so axis labels never
// overflow the cell.
function fmtMetric(kind: MetricKind, v: number): string {
  if (kind === "ctr" || kind === "conversion") return `${v.toFixed(2)}%`;
  const compact = compactNumber(v);
  if (kind === "revenue") return `$${compact}`;
  return compact;
}
function compactNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + "M";
  if (abs >= 1e4) return (v / 1e3).toFixed(0) + "k";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "k";
  if (abs < 1)    return v.toFixed(2);
  return Math.round(v).toLocaleString();
}

// -----------------------------------------------------------------------
// Swimlanes

function Swimlanes({
  campaigns, annotations, visibleStart, visibleEnd, onHoverX, onCampaignClick, tall,
}: {
  campaigns: TimelineCampaign[];
  annotations: TimelineAnnotation[];
  visibleStart: number;
  visibleEnd: number;
  onHoverX: (x: number | null) => void;
  onCampaignClick: (c: TimelineCampaign) => void;
  tall?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverCampaign, setHoverCampaign] = useState<TimelineCampaign | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const span = visibleEnd - visibleStart;

  function relativeX(e: React.MouseEvent): number {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }
  function pctForT(t: number): number { return Math.min(1, Math.max(0, (t - visibleStart) / span)); }

  const ticks = useMemo(() => {
    const days = span / 86400_000;
    let stride = 1;
    if (days > 14) stride = 7;
    if (days > 60) stride = 14;
    if (days > 120) stride = 30;
    const out: number[] = [];
    const start = new Date(visibleStart);
    start.setHours(0, 0, 0, 0);
    let t = start.getTime();
    while (t < visibleEnd) {
      if (t >= visibleStart) out.push(t);
      t += stride * 86400_000;
    }
    return out;
  }, [visibleStart, visibleEnd, span]);

  return (
    <div
      ref={ref}
      className="relative px-6 py-4"
      onMouseMove={(e) => {
        const x = relativeX(e);
        onHoverX(x);
        setHoverPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseLeave={() => { onHoverX(null); setHoverPos(null); setHoverCampaign(null); }}
    >
      {/* Date axis */}
      <div className="relative h-5 mb-2">
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute top-0 -translate-x-1/2 text-[10px] text-zinc-600 font-mono"
            style={{ left: `${pctForT(t) * 100}%` }}
          >
            {fmtTick(t)}
          </div>
        ))}
        {Date.now() >= visibleStart && Date.now() <= visibleEnd && (
          <div
            className="absolute top-0 h-full w-px bg-white/70"
            style={{ left: `${pctForT(Date.now()) * 100}%` }}
          />
        )}
      </div>

      {/* Channel rows */}
      <div className={tall ? "space-y-3" : "space-y-2"}>
        {CHANNELS.map((channel) => (
          <Swimlane
            key={channel}
            channel={channel}
            campaigns={campaigns.filter((c) => c.channel === channel)}
            visibleStart={visibleStart}
            span={span}
            onHover={(c) => setHoverCampaign(c)}
            onClick={onCampaignClick}
            tall={tall}
          />
        ))}
      </div>

      {/* Annotations: vertical hairlines */}
      {annotations.map((a) => {
        const t = Date.parse(a.at);
        const pct = pctForT(t);
        return (
          <Annotation key={a.id} ann={a} leftPct={pct * 100} />
        );
      })}

      {/* Hover tooltip */}
      {hoverCampaign && hoverPos && (
        <div
          className="fixed pointer-events-none z-30 max-w-sm rounded-md border border-zinc-700 bg-black/95 px-3 py-2 text-xs shadow-2xl"
          style={{ left: hoverPos.x + 12, top: hoverPos.y - 12 }}
        >
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
            {CHANNEL_LABEL[hoverCampaign.channel]}
          </div>
          <div className="text-zinc-100 font-medium">{hoverCampaign.name}</div>
          <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
            {fmtDate(Date.parse(hoverCampaign.started_at))} → {fmtDate(Date.parse(hoverCampaign.ended_at))}
          </div>
          {hoverCampaign.description && (
            <div className="text-[11px] text-zinc-300 mt-1.5 leading-relaxed">{hoverCampaign.description}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Swimlane({
  channel, campaigns, visibleStart, span, onHover, onClick, tall,
}: {
  channel: TimelineChannel;
  campaigns: TimelineCampaign[];
  visibleStart: number;
  span: number;
  onHover: (c: TimelineCampaign | null) => void;
  onClick: (c: TimelineCampaign) => void;
  tall?: boolean;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        {CHANNEL_LABEL[channel]}
      </div>
      <div className={["relative border-y border-zinc-900/80", tall ? "h-12" : "h-6"].join(" ")}>
        {campaigns.map((c) => {
          const start = Date.parse(c.started_at);
          const end = Date.parse(c.ended_at);
          const left = ((Math.max(start, visibleStart) - visibleStart) / span) * 100;
          const width = ((Math.min(end, visibleStart + span) - Math.max(start, visibleStart)) / span) * 100;
          if (width <= 0) return null;
          return (
            <button
              key={c.id}
              type="button"
              className="absolute top-1 bottom-1 cursor-pointer group text-left"
              style={{ left: `${left}%`, width: `${width}%` }}
              onMouseEnter={() => onHover(c)}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => { e.stopPropagation(); onClick(c); }}
              title="Click to zoom into this campaign"
            >
              <div className="absolute inset-0 border border-white/30 group-hover:border-white group-hover:bg-white/5 transition-colors" />
              <div className="absolute inset-y-0 left-0 w-px bg-white/60 group-hover:bg-white" />
              <div className="absolute inset-y-0 right-0 w-px bg-white/60 group-hover:bg-white" />
              <div className="absolute inset-x-1 top-0.5 text-[10px] text-white/85 font-mono truncate leading-tight">
                {c.name}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Annotation({ ann, leftPct }: { ann: TimelineAnnotation; leftPct: number }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        // Account for px-6 (24px) outer padding + the 80px swim-label column + 12px gap.
        left: `calc(${leftPct}% * (100% - 1.5rem - 80px - 0.75rem) / 100% + 1.5rem + 80px + 0.75rem)`,
        top: "1.75rem",
        bottom: "1rem",
      }}
    >
      <div
        className="pointer-events-auto absolute -translate-x-1/2 inset-y-0 w-3"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/60" />
        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-white" />
      </div>
      {hover && (
        <div className="absolute -translate-x-1/2 -top-7 whitespace-nowrap rounded-sm border border-zinc-700 bg-black/95 px-2 py-1 text-[10px] text-zinc-100 shadow-xl">
          {ann.label}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Rail — semi-transparent overlay floating at the bottom of the timeline.
// Center-drag pans (window keeps its span); edge-drag resizes by moving
// just that edge. Background hairlines show the full 6mo data range so
// you can see what's outside your current window.

const MIN_VIS_DAYS = 1;

function Rail({
  fullStart, fullEnd, visibleStart, visibleEnd, onWindow,
}: {
  fullStart: number;
  fullEnd: number;
  visibleStart: number;
  visibleEnd: number;
  onWindow: (start: number, end: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fullSpan = fullEnd - fullStart;

  const leftPct = ((visibleStart - fullStart) / fullSpan) * 100;
  const widthPct = ((visibleEnd - visibleStart) / fullSpan) * 100;

  type DragMode = null | "pan" | "left" | "right";
  const dragMode = useRef<DragMode>(null);
  // Snapshot of the window + start-of-drag pointer time, so deltas stay
  // consistent even as the user drags fast.
  const snap = useRef<{ start: number; end: number; pointerT: number }>({ start: 0, end: 0, pointerT: 0 });

  function pointerT(clientX: number): number {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return visibleEnd;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fullStart + pct * fullSpan;
  }

  function clampWindow(start: number, end: number): [number, number] {
    if (start < fullStart) { end += fullStart - start; start = fullStart; }
    if (end > fullEnd)     { start -= end - fullEnd; end = fullEnd; }
    if (end - start < MIN_VIS_DAYS * 86400_000) {
      end = start + MIN_VIS_DAYS * 86400_000;
    }
    return [Math.max(fullStart, start), Math.min(fullEnd, end)];
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragMode.current) return;
      const t = pointerT(e.clientX);
      const dt = t - snap.current.pointerT;
      const s0 = snap.current.start, e0 = snap.current.end;
      let next: [number, number];
      if (dragMode.current === "pan") {
        next = clampWindow(s0 + dt, e0 + dt);
      } else if (dragMode.current === "left") {
        next = clampWindow(s0 + dt, e0);
      } else {
        next = clampWindow(s0, e0 + dt);
      }
      onWindow(next[0], next[1]);
    }
    function onUp() { dragMode.current = null; document.body.style.cursor = ""; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fullStart, fullEnd, fullSpan, onWindow]);

  function startDrag(mode: Exclude<DragMode, null>, clientX: number) {
    dragMode.current = mode;
    snap.current = {
      start: visibleStart,
      end: visibleEnd,
      pointerT: pointerT(clientX),
    };
    document.body.style.cursor = mode === "pan" ? "grabbing" : "ew-resize";
  }

  return (
    <div className="absolute left-0 right-0 bottom-0 px-6 pb-3 pointer-events-none">
      <div
        ref={ref}
        className="relative h-8 rounded-md border border-zinc-800 bg-black/55 backdrop-blur-md pointer-events-auto"
      >
        {/* Faint full-range tick rail behind the bracket. */}
        <div className="absolute inset-y-0 left-0 right-0 flex items-stretch overflow-hidden rounded-md">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="flex-1 border-l border-zinc-800/70 first:border-l-0" />
          ))}
        </div>
        {/* Bracket */}
        <div
          className="absolute top-0 bottom-0 group"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        >
          {/* Body — drag to pan */}
          <div
            className="absolute inset-0 bg-white/15 hover:bg-white/20 cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => { e.stopPropagation(); startDrag("pan", e.clientX); }}
          />
          {/* Edges */}
          <div className="absolute inset-y-0 left-0 w-px bg-white" />
          <div className="absolute inset-y-0 right-0 w-px bg-white" />
          {/* Resize handles — wider hit targets than the visual hairlines */}
          <div
            className="absolute inset-y-0 -left-1.5 w-3 cursor-ew-resize"
            onMouseDown={(e) => { e.stopPropagation(); startDrag("left", e.clientX); }}
            title="Drag to resize"
          />
          <div
            className="absolute inset-y-0 -right-1.5 w-3 cursor-ew-resize"
            onMouseDown={(e) => { e.stopPropagation(); startDrag("right", e.clientX); }}
            title="Drag to resize"
          />
        </div>
        {/* Edge labels */}
        <div className="absolute inset-y-0 left-2 flex items-center text-[9px] text-zinc-600 font-mono pointer-events-none">
          {fmtDate(fullStart)}
        </div>
        <div className="absolute inset-y-0 right-2 flex items-center text-[9px] text-zinc-600 font-mono pointer-events-none">
          {fmtDate(fullEnd)}
        </div>
      </div>
    </div>
  );
}

function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtTick(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default Timeline;

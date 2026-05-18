import { useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, Tooltip, Legend,
} from "recharts";
import type { ChartSpec } from "../lib/api";

const PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#f43f5e",
  "#3b82f6", "#8b5cf6", "#06b6d4", "#ec4899",
];

type TooltipEntry = { color?: string; name?: string | number; value?: number | string };

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs shadow-lg">
      {label != null && <div className="font-medium text-ink-700 mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="size-2 rounded-sm shrink-0" style={{ backgroundColor: p.color }} />
          <span className="text-ink-500">{p.name}</span>
          <span className="font-mono font-medium text-ink-800 ml-auto pl-3">
            {typeof p.value === "number" ? p.value.toLocaleString() : String(p.value ?? "")}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderChart(spec: ChartSpec, compact: boolean) {
  const margin = compact
    ? { top: 2, right: 2, bottom: 0, left: 0 }
    : { top: 4, right: 8, bottom: 0, left: 0 };
  const colors = spec.series.map((s, i) => s.color ?? PALETTE[i % PALETTE.length]);

  if (spec.type === "pie" || spec.type === "donut") {
    const valueKey = spec.series[0]?.key ?? "value";
    return (
      <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <Pie
          data={spec.data}
          dataKey={valueKey}
          nameKey="name"
          innerRadius={spec.type === "donut" ? "55%" : 0}
          outerRadius={compact ? "80%" : "65%"}
          paddingAngle={2}
          strokeWidth={0}
        >
          {spec.data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        {!compact && <Tooltip content={<ChartTooltip />} />}
        {!compact && (
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#6b7280" }} />
        )}
      </PieChart>
    );
  }

  if (spec.type === "bar") {
    return (
      <BarChart data={spec.data} margin={margin}>
        {!compact && <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />}
        {!compact && (
          <XAxis
            dataKey={spec.x ?? "x"}
            tick={{ fontSize: 11, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={false}
          />
        )}
        {!compact && (
          <YAxis
            tick={{ fontSize: 11, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={false}
            width={38}
          />
        )}
        {!compact && <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f3f4f6" }} />}
        {!compact && spec.series.length > 1 && (
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#6b7280" }} />
        )}
        {spec.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label ?? s.key}
            fill={colors[i]}
            radius={[3, 3, 0, 0]}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    );
  }

  if (spec.type === "area") {
    return (
      <AreaChart data={spec.data} margin={margin}>
        {!compact && <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />}
        {!compact && (
          <XAxis
            dataKey={spec.x ?? "x"}
            tick={{ fontSize: 11, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={false}
          />
        )}
        {!compact && (
          <YAxis
            tick={{ fontSize: 11, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={false}
            width={38}
          />
        )}
        {!compact && <Tooltip content={<ChartTooltip />} />}
        {!compact && spec.series.length > 1 && (
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#6b7280" }} />
        )}
        {spec.series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label ?? s.key}
            stroke={colors[i]}
            fill={colors[i]}
            fillOpacity={compact ? 0.25 : 0.12}
            strokeWidth={compact ? 1.5 : 2}
            dot={false}
          />
        ))}
      </AreaChart>
    );
  }

  // line (default)
  return (
    <LineChart data={spec.data} margin={margin}>
      {!compact && <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />}
      {!compact && (
        <XAxis
          dataKey={spec.x ?? "x"}
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={false}
        />
      )}
      {!compact && (
        <YAxis
          tick={{ fontSize: 11, fill: "#9ca3af" }}
          tickLine={false}
          axisLine={false}
          width={38}
        />
      )}
      {!compact && <Tooltip content={<ChartTooltip />} />}
      {!compact && spec.series.length > 1 && (
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "#6b7280" }} />
      )}
      {spec.series.map((s, i) => (
        <Line
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.label ?? s.key}
          stroke={colors[i]}
          strokeWidth={compact ? 1.5 : 2}
          dot={false}
          activeDot={compact ? false : { r: 4, strokeWidth: 0 }}
        />
      ))}
    </LineChart>
  );
}

export function ChartView({ spec, compact = false }: { spec: ChartSpec; compact?: boolean }) {
  const height = compact ? 60 : 224;
  const chart = useMemo(() => renderChart(spec, compact), [spec, compact]);

  return (
    <div className="w-full">
      {!compact && (spec.title || spec.description) && (
        <div className="mb-2 px-1">
          {spec.title && <p className="text-sm font-semibold text-ink-800">{spec.title}</p>}
          {spec.description && <p className="text-xs text-ink-500 mt-0.5">{spec.description}</p>}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        {chart}
      </ResponsiveContainer>
    </div>
  );
}

export function parseChartSpec(json: string): ChartSpec | null {
  try {
    const s = JSON.parse(json) as Record<string, unknown>;
    if (!["bar", "line", "area", "pie", "donut"].includes(s.type as string)) return null;
    if (!Array.isArray(s.data) || !Array.isArray(s.series)) return null;
    return s as unknown as ChartSpec;
  } catch {
    return null;
  }
}

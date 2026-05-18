import { useMemo } from "react";

// [veryLight, light, mid, deep]
const ORB_THEMES: [string, string, string, string][] = [
  ["#ccf7fe", "#67e0f5", "#0ea5c9", "#083060"],
  ["#bbf7d0", "#4ade80", "#16a34a", "#052e16"],
  ["#ede9fe", "#c4b5fd", "#7c3aed", "#1e0a50"],
  ["#bae6fd", "#7dd3fc", "#0284c7", "#082050"],
  ["#fce7f3", "#f9a8d4", "#db2777", "#500030"],
  ["#fef9c3", "#fde047", "#ca8a04", "#451a03"],
  ["#d1fae5", "#6ee7b7", "#059669", "#022c22"],
  ["#e0e7ff", "#a5b4fc", "#4f46e5", "#1e1b4b"],
];

export function orbTheme(seed: string): [string, string, string, string] {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return ORB_THEMES[(h >>> 0) % ORB_THEMES.length];
}

function orbDelay(seed: string, layer: "a" | "b"): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  // Different multiplier per layer so A and B don't share the same offset pattern
  const offset = layer === "a"
    ? -((h >>> 0) % 11000) / 1000
    : -((Math.imul(h, 1664525) >>> 0) % 7000) / 1000;
  return `${offset}s`;
}

export function OrbAvatar({ seed, size = 72 }: { seed: string; size?: number }) {
  const [vl, l, m, d] = useMemo(() => orbTheme(seed), [seed]);
  const delayA = useMemo(() => orbDelay(seed, "a"), [seed]);
  const delayB = useMemo(() => orbDelay(seed, "b"), [seed]);

  const blurA = Math.round(size * 0.03);
  const blurB = Math.round(size * 0.02);

  return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", position: "relative", flexShrink: 0 }}>
      <div style={{ position: "absolute", inset: 0, background: l }} />

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
          animationDelay: delayA,
        }}
      />

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
          animationDelay: delayB,
        }}
      />

      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(circle at 50% 50%, transparent 30%, ${d}55 68%, ${d}aa 100%)`,
      }} />

      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(circle at 34% 28%, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0.05) 42%, transparent 58%)`,
      }} />
    </div>
  );
}

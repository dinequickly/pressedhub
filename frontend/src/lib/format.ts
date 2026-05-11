// Small formatting helpers used across the chat surface.

import { marked } from "marked";

// Relative timestamp. "just now" within 5s, then "12s ago", "3m ago",
// "2h ago", "yesterday", "May 8" for older. Avoids the chunky HH:MM:SS look
// when most events are seconds apart.
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "queued";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Configure marked for chat messages. GFM + line breaks, no raw HTML, no
// dangerous protocols.
marked.setOptions({ gfm: true, breaks: true });

// Render markdown to a sanitized HTML string. We rely on marked's built-in
// renderer; for the level of trust we have in assistant output (it's our own
// model), this is sufficient. If we ever pipe untrusted input through here,
// swap in DOMPurify.
export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

// Format a byte count as a short human-readable string. Picks the largest
// unit that keeps the number under 1024 — so a 13 MB file shows "12.6 MB"
// instead of the old "12962.0 KB" eyesore. Uses 1 KB = 1024 B (binary),
// which matches how Storage and file managers count.
export function humanizeBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

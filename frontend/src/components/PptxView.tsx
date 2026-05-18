// Read-only PPTX preview. Unzips the .pptx (a zip of XML) in the browser
// via fflate, extracts each slide's text + speaker notes, and renders them
// as cards. Fonts / layouts / images aren't reproduced — this is for reading
// the deck's content, not visually rendering it.
//
// Used by both /knowledge file previews and /runs output previews. Just
// takes a proxyPath; the consumer decides where to fetch from.

import { useEffect, useState, type ReactNode } from "react";
import { LuLoader, LuTriangleAlert } from "react-icons/lu";
import { api } from "../lib/api";

export type PptxSlide = {
  index: number;
  title: string | null;
  bullets: string[];
  notes: string | null;
};

export function PptxView({
  proxyPath,
  rightActions,
}: {
  proxyPath: string;
  // Optional trailing slot (eg. a Download button). Rendered floating top-right.
  rightActions?: ReactNode;
}) {
  const [slides, setSlides] = useState<PptxSlide[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ unzipSync, strFromU8 }, res] = await Promise.all([
          import("fflate"),
          api.getRaw(proxyPath),
        ]);
        const buf = new Uint8Array(await res.arrayBuffer());
        const entries = unzipSync(buf, {
          filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) ||
            /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f.name),
        });
        if (cancelled) return;
        setSlides(parsePptx(entries, strFromU8));
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [proxyPath]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-4 pb-3 border-b border-neutral-200 flex items-center justify-between gap-3">
        <div className="text-[11px] text-ink-500 flex items-center gap-1.5">
          <LuTriangleAlert className="size-3.5 text-amber-500" />
          Showing slide text only — fonts, layouts, and images aren't rendered.
        </div>
        {rightActions}
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {err ? (
          <div className="p-2 text-sm text-rose-600 flex items-start gap-2">
            <LuTriangleAlert className="size-4 mt-0.5" /> {err}
          </div>
        ) : slides == null ? (
          <div className="flex items-center gap-2 text-sm text-ink-500">
            <LuLoader className="size-4 animate-spin" /> Parsing slides…
          </div>
        ) : slides.length === 0 ? (
          <div className="text-sm text-ink-500">No slide text found.</div>
        ) : slides.map((s) => (
          <div key={s.index} className="border border-neutral-200 rounded-xl bg-white shadow-sm">
            <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 bg-neutral-50 rounded-t-xl">
              <div className="text-[11px] font-mono text-ink-500">Slide {s.index}</div>
            </div>
            <div className="p-4 space-y-2">
              {s.title && <div className="text-base font-semibold">{s.title}</div>}
              {s.bullets.length > 0 && (
                <ul className="list-disc pl-5 space-y-1 text-sm text-ink-700">
                  {s.bullets.map((b, i) => (<li key={i}>{b}</li>))}
                </ul>
              )}
              {!s.title && s.bullets.length === 0 && (
                <div className="text-xs text-ink-400 italic">(no text)</div>
              )}
              {s.notes && (
                <div className="mt-3 pt-2 border-t border-neutral-100 text-xs text-ink-500">
                  <span className="font-medium uppercase tracking-wide text-[10px] text-ink-400 block mb-0.5">Notes</span>
                  <div className="whitespace-pre-wrap">{s.notes}</div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Parse pptx slide XMLs into plain-text outlines.
export function parsePptx(
  entries: Record<string, Uint8Array>,
  strFromU8: (b: Uint8Array) => string,
): PptxSlide[] {
  const slideEntries = Object.entries(entries)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => slideNum(a) - slideNum(b));

  const notesEntries = Object.fromEntries(
    Object.entries(entries)
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map(([name, bytes]) => [slideNum(name), strFromU8(bytes)]),
  );

  return slideEntries.map(([name, bytes], i) => {
    const xml = strFromU8(bytes);
    const paragraphs = extractParagraphs(xml);
    const [title, ...rest] = paragraphs.filter((p) => p.trim());
    const notes = notesEntries[slideNum(name)]
      ? extractParagraphs(notesEntries[slideNum(name)]).join("\n").trim() || null
      : null;
    return { index: i + 1, title: title ?? null, bullets: rest, notes };
  });
}

function slideNum(name: string): number {
  const m = name.match(/(\d+)\.xml$/);
  return m ? parseInt(m[1], 10) : 0;
}

function extractParagraphs(xml: string): string[] {
  const out: string[] = [];
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(xml)) !== null) {
    const inner = pm[1];
    let text = "";
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(inner)) !== null) {
      text += decodeXml(tm[1]);
    }
    if (text.trim()) out.push(text);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

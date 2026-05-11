// PPTX browser parser + serializer.
// Reads a .pptx ZIP into a SlideModel tree; patches text edits back
// into the original XML; rezips for PUT. No new deps — uses fflate
// (already in package.json) and the browser DOMParser.

import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

export const EMU_PER_INCH = 914400;

// ---- Public types -------------------------------------------------------

export type LazySlide = {
  index: number;   // 1-based
  path: string;    // "ppt/slides/slideN.xml"
  parsed: SlideModel | null;
};

export type PptxDoc = {
  width: number;   // slide width in EMU
  height: number;  // slide height in EMU
  slides: LazySlide[];
  raw: Record<string, Uint8Array>;  // original zip entries for reserializing
  _mediaMap: Record<string, Uint8Array>;
  _themeColors: Record<string, string>;
};

export type SlideModel = {
  index: number;  // 1-based
  path: string;   // "ppt/slides/slideN.xml"
  bg: string;     // background hex ("#RRGGBB"), empty = white
  shapes: Shape[];
};

export type Shape = TextShape | ImageShape | OtherShape;

export type ShapeBase = {
  id: string;
  x: number; y: number; w: number; h: number;  // EMU
  fill: string;  // hex or "" for none
  rot: number;   // degrees (positive = clockwise)
  zIndex: number;
};

export type TextShape = ShapeBase & {
  kind: "text";
  paras: Para[];
  anchor: "t" | "ctr" | "b";
};

export type ImageShape = ShapeBase & {
  kind: "image";
  src: string;  // blob URL or data URL
};

export type OtherShape = ShapeBase & {
  kind: "other";
};

export type Para = {
  align: "l" | "ctr" | "r" | "just";
  runs: Run[];
};

export type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontSize: number;  // points
  color: string;     // hex or ""
  fontFamily: string;
};

// ---- Parser ------------------------------------------------------------

// Default Office theme accent colors used as fallback for schemeClr.
const SCHEME_COLORS: Record<string, string> = {
  dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6",
  accent1: "4472C4", accent2: "ED7D31", accent3: "A9D18E",
  accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47",
  hlink: "0563C1", folHlink: "954F72",
  bg1: "FFFFFF", bg2: "E7E6E6", tx1: "000000", tx2: "44546A",
  phClr: "000000",
};

function stripNs(xml: string): string {
  // Remove xmlns declarations, then strip namespace prefixes from tag names.
  // Attribute namespace prefixes (r:embed, etc.) are also stripped.
  return xml
    .replace(/\s+xmlns(:\w+)?="[^"]*"/g, "")
    .replace(/<(\/?)([a-zA-Z]+):([A-Za-z])/g, "<$1$3")
    .replace(/\s([a-zA-Z]+):([a-zA-Z]+)=/g, " $2=");
}

function parse(xml: string): Document {
  return new DOMParser().parseFromString(stripNs(xml), "application/xml");
}

function hex(el: Element | null): string {
  if (!el) return "";
  const srgb = el.querySelector("srgbClr");
  if (srgb) return (srgb.getAttribute("val") ?? "").toUpperCase();
  const sys = el.querySelector("sysClr");
  if (sys) return (sys.getAttribute("lastClr") ?? "").toUpperCase();
  const scheme = el.querySelector("schemeClr");
  if (scheme) {
    const base = SCHEME_COLORS[scheme.getAttribute("val") ?? ""] ?? "000000";
    return applyMods(base, scheme);
  }
  return "";
}

function applyMods(baseHex: string, el: Element): string {
  // Apply lumMod / lumOff in HLS space if present.
  const lumMod = el.querySelector("lumMod");
  const lumOff = el.querySelector("lumOff");
  if (!lumMod && !lumOff) return baseHex;
  const r = parseInt(baseHex.slice(0, 2), 16) / 255;
  const g = parseInt(baseHex.slice(2, 4), 16) / 255;
  const b = parseInt(baseHex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let l = (max + min) / 2;
  if (lumMod) l *= parseInt(lumMod.getAttribute("val") ?? "100000") / 100000;
  if (lumOff) l += parseInt(lumOff.getAttribute("val") ?? "0") / 100000;
  l = Math.max(0, Math.min(1, l));
  // Reconstruct from HLS (simplified — keep hue/sat from original).
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  function hue2rgb(p: number, q: number, t: number) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  if (s === 0) {
    const v = Math.round(l * 255);
    return v.toString(16).padStart(2, "0").repeat(3).toUpperCase();
  }
  const maxH = max, minH = min;
  let h = 0;
  if (maxH === r) h = (g - b) / (maxH - minH) / 6;
  else if (maxH === g) h = (2 + (b - r) / (maxH - minH)) / 6;
  else h = (4 + (r - g) / (maxH - minH)) / 6;
  if (h < 0) h += 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rr = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const gg = Math.round(hue2rgb(p, q, h) * 255);
  const bb = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  return [rr, gg, bb].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function parseTransform(spPr: Element): { x: number; y: number; w: number; h: number; rot: number } {
  const xfrm = spPr.querySelector("xfrm");
  const off = xfrm?.querySelector("off");
  const ext = xfrm?.querySelector("ext");
  const rot = xfrm?.getAttribute("rot");
  return {
    x: parseInt(off?.getAttribute("x") ?? "0"),
    y: parseInt(off?.getAttribute("y") ?? "0"),
    w: parseInt(ext?.getAttribute("cx") ?? "0"),
    h: parseInt(ext?.getAttribute("cy") ?? "0"),
    rot: rot ? parseInt(rot) / 60000 : 0,
  };
}

function parseFill(spPr: Element): string {
  const solidFill = spPr.querySelector(":scope > solidFill");
  if (solidFill) return hex(solidFill) || "";
  const noFill = spPr.querySelector(":scope > noFill");
  if (noFill) return "";
  return "";
}

function parseRPr(rPr: Element | null, defaultFontSize = 18): Run {
  const sz = rPr?.getAttribute("sz");
  const bAttr = rPr?.getAttribute("b");
  const iAttr = rPr?.getAttribute("i");
  const uAttr = rPr?.getAttribute("u");
  const solidFill = rPr?.querySelector("solidFill");
  const latin = rPr?.querySelector("latin");
  return {
    text: "",
    bold: bAttr === "1" || bAttr === "true",
    italic: iAttr === "1" || iAttr === "true",
    underline: !!uAttr && uAttr !== "none",
    fontSize: sz ? parseInt(sz) / 100 : defaultFontSize,
    color: solidFill ? hex(solidFill) : "",
    fontFamily: latin?.getAttribute("typeface") ?? "",
  };
}

function parsePara(paraEl: Element): Para {
  const pPr = paraEl.querySelector(":scope > pPr");
  const algn = pPr?.getAttribute("algn") as Para["align"] ?? "l";
  const runs: Run[] = [];
  for (const rEl of paraEl.querySelectorAll(":scope > r")) {
    const rPr = rEl.querySelector(":scope > rPr");
    const tEl = rEl.querySelector(":scope > t");
    const run = parseRPr(rPr);
    run.text = tEl?.textContent ?? "";
    if (run.text) runs.push(run);
  }
  // Also handle <a:br> (line breaks) as runs with newline text
  for (const brEl of paraEl.querySelectorAll(":scope > br")) {
    const rPr = brEl.querySelector(":scope > rPr");
    const run = parseRPr(rPr);
    run.text = "\n";
    runs.push(run);
  }
  return { align: algn, runs };
}

function parseTextShape(sp: Element, zIndex: number): TextShape | null {
  const spPr = sp.querySelector(":scope > spPr");
  if (!spPr) return null;
  const xform = parseTransform(spPr);
  if (!xform.w && !xform.h) return null;

  const txBody = sp.querySelector(":scope > txBody");
  const bodyPr = txBody?.querySelector(":scope > bodyPr");
  const anchorAttr = bodyPr?.getAttribute("anchor");
  const anchor: TextShape["anchor"] = anchorAttr === "ctr" ? "ctr" : anchorAttr === "b" ? "b" : "t";

  const paras: Para[] = [];
  for (const pEl of txBody?.querySelectorAll(":scope > p") ?? []) {
    const para = parsePara(pEl);
    paras.push(para);
  }

  const cNvPr = sp.querySelector("cNvPr");
  const id = cNvPr?.getAttribute("id") ?? String(zIndex);

  return {
    kind: "text",
    id,
    ...xform,
    fill: parseFill(spPr),
    zIndex,
    paras,
    anchor,
  };
}

function parseImageShape(pic: Element, relsMap: Record<string, string>, mediaMap: Record<string, Uint8Array>, zIndex: number): ImageShape | null {
  const spPr = pic.querySelector(":scope > spPr");
  if (!spPr) return null;
  const xform = parseTransform(spPr);
  if (!xform.w && !xform.h) return null;

  const blip = pic.querySelector("blip");
  const rId = blip?.getAttribute("embed") ?? "";
  const target = relsMap[rId] ?? "";
  const mediaKey = target.replace(/^\.\.\//, "ppt/");
  const bytes = mediaMap[mediaKey];
  let src = "";
  if (bytes) {
    const ext = mediaKey.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "svg" ? "image/svg+xml"
      : "image/png";
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    src = URL.createObjectURL(blob);
  }

  const cNvPr = pic.querySelector("cNvPr");
  const id = cNvPr?.getAttribute("id") ?? String(zIndex);

  return { kind: "image", id, ...xform, fill: "", zIndex, src };
}

function parseSlideRels(relsXml: string): Record<string, string> {
  const doc = parse(relsXml);
  const map: Record<string, string> = {};
  for (const rel of doc.querySelectorAll("Relationship")) {
    map[rel.getAttribute("Id") ?? ""] = rel.getAttribute("Target") ?? "";
  }
  return map;
}

function parseSlideXml(xml: string, relsMap: Record<string, string>, mediaMap: Record<string, Uint8Array>, themeColors: Record<string, string>): { bg: string; shapes: Shape[] } {
  // Inject theme colors into SCHEME_COLORS for this slide.
  Object.assign(SCHEME_COLORS, themeColors);

  const doc = parse(xml);
  const cSld = doc.querySelector("cSld");

  // Background color
  let bg = "";
  const bgPr = cSld?.querySelector("bgPr");
  if (bgPr) {
    const solidFill = bgPr.querySelector("solidFill");
    if (solidFill) bg = hex(solidFill);
  }

  const shapes: Shape[] = [];
  const spTree = cSld?.querySelector("spTree");
  if (!spTree) return { bg, shapes };

  let z = 0;
  for (const child of spTree.children) {
    const tag = child.tagName;
    if (tag === "sp") {
      const s = parseTextShape(child, z++);
      if (s) shapes.push(s);
    } else if (tag === "pic") {
      const s = parseImageShape(child, relsMap, mediaMap, z++);
      if (s) shapes.push(s);
    } else if (tag === "grpSp") {
      // Flatten one level of group shapes.
      for (const inner of child.children) {
        if (inner.tagName === "sp") {
          const s = parseTextShape(inner, z++);
          if (s) shapes.push(s);
        } else if (inner.tagName === "pic") {
          const s = parseImageShape(inner, relsMap, mediaMap, z++);
          if (s) shapes.push(s);
        }
      }
    }
  }

  return { bg, shapes };
}

function parsePresentation(xml: string): { width: number; height: number } {
  const doc = parse(xml);
  const sldSz = doc.querySelector("sldSz");
  return {
    width: parseInt(sldSz?.getAttribute("cx") ?? "9144000"),
    height: parseInt(sldSz?.getAttribute("cy") ?? "6858000"),
  };
}

function parseTheme(xml: string): Record<string, string> {
  const doc = parse(xml);
  const clrScheme = doc.querySelector("clrScheme");
  if (!clrScheme) return {};
  const colors: Record<string, string> = {};
  for (const child of clrScheme.children) {
    const name = child.tagName;
    const v = hex(child);
    if (v) colors[name] = v;
  }
  return colors;
}

// Parse a single slide on demand and return an updated PptxDoc (immutable).
export function parseSlide(doc: PptxDoc, index: number): PptxDoc {
  const lazy = doc.slides[index];
  if (!lazy || lazy.parsed !== null) return doc;

  const relsPath = lazy.path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
  const relsXml = doc.raw[relsPath];
  const relsMap = relsXml ? parseSlideRels(strFromU8(relsXml)) : {};
  const xml = strFromU8(doc.raw[lazy.path]);
  const { bg, shapes } = parseSlideXml(xml, relsMap, doc._mediaMap, doc._themeColors);
  const parsed: SlideModel = { index: lazy.index, path: lazy.path, bg, shapes };

  const newSlides = doc.slides.slice();
  newSlides[index] = { ...lazy, parsed };
  return { ...doc, slides: newSlides };
}

// Unzip once, parse slide 1 immediately, leave others as lazy stubs.
export async function parsePptxLazy(bytes: Uint8Array): Promise<PptxDoc> {
  const raw = unzipSync(bytes);
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(raw)) entries[k] = v;

  const presXml = entries["ppt/presentation.xml"];
  const { width, height } = presXml ? parsePresentation(strFromU8(presXml)) : { width: 9144000, height: 6858000 };

  const themeXml = entries["ppt/theme/theme1.xml"];
  const themeColors = themeXml ? parseTheme(strFromU8(themeXml)) : {};

  // Media map: "ppt/media/imageN.png" → bytes
  const mediaMap: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (k.startsWith("ppt/media/")) mediaMap[k] = v;
  }

  // Enumerate slides in order — all start as unparsed stubs.
  const slidePaths = Object.keys(entries)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNum(a) - slideNum(b));

  const slides: LazySlide[] = slidePaths.map((path, i) => ({
    index: i + 1,
    path,
    parsed: null,
  }));

  const doc: PptxDoc = { width, height, slides, raw: entries, _mediaMap: mediaMap, _themeColors: themeColors };

  // Parse slide 1 eagerly so it renders immediately.
  return slides.length > 0 ? parseSlide(doc, 0) : doc;
}

// Legacy: parse all slides upfront (kept for any callers that need full SlideModel[]).
export async function parsePptx(bytes: Uint8Array): Promise<PptxDoc> {
  let doc = await parsePptxLazy(bytes);
  for (let i = 1; i < doc.slides.length; i++) {
    doc = parseSlide(doc, i);
  }
  return doc;
}

function slideNum(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1]) : 0;
}

// ---- Serializer --------------------------------------------------------

// Patch text runs in a shape's txBody by shape id. Rebuilds the entire
// txBody XML from the given paragraphs so text content is correctly updated.
export function patchShapeText(doc: PptxDoc, slideIndex: number, shapeId: string, paras: Para[]): PptxDoc {
  const slide = doc.slides[slideIndex];
  if (!slide) return doc;

  const origXml = strFromU8(doc.raw[slide.path]);
  const patched = patchTxBody(origXml, shapeId, paras);

  return {
    ...doc,
    raw: { ...doc.raw, [slide.path]: strToU8(patched) },
    slides: doc.slides.map((s, i) =>
      i === slideIndex
        ? {
            ...s,
            parsed: s.parsed
              ? { ...s.parsed, shapes: s.parsed.shapes.map((sh) => sh.id === shapeId && sh.kind === "text" ? { ...sh, paras } : sh) }
              : s.parsed,
          }
        : s,
    ),
  };
}

// Escape a value for use inside a double-quoted XML attribute.
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function patchTxBody(slideXml: string, shapeId: string, paras: Para[]): string {
  // Use a regex to find the <p:sp> with cNvPr id=shapeId and replace its
  // <p:txBody>...</p:txBody>. This is surgical and preserves all other XML.

  // Build the replacement txBody content.
  const parasXml = paras.map((para) => {
    // Alignment comes from parsed PPTX enum values — escape defensively.
    const pPrXml = para.align !== "l"
      ? `<a:pPr algn="${escapeXmlAttr(para.align)}"/>`
      : "";
    const runsXml = para.runs.map((run) => {
      const rPrAttrs: string[] = [];
      if (run.bold) rPrAttrs.push('b="1"');
      if (run.italic) rPrAttrs.push('i="1"');
      if (run.underline) rPrAttrs.push('u="sng"');
      if (run.fontSize) rPrAttrs.push(`sz="${Math.round(run.fontSize * 100)}"`);
      // color and fontFamily come from the original PPTX; escape as XML
      // attribute values so a crafted PPTX cannot break out of the attribute
      // context when the file is re-serialized.
      const fillXml = run.color
        ? `<a:solidFill><a:srgbClr val="${escapeXmlAttr(run.color)}"/></a:solidFill>`
        : "";
      const fontXml = run.fontFamily
        ? `<a:latin typeface="${escapeXmlAttr(run.fontFamily)}"/>`
        : "";
      const rPrXml = rPrAttrs.length || fillXml || fontXml
        ? `<a:rPr ${rPrAttrs.join(" ")}>${fillXml}${fontXml}</a:rPr>`
        : "<a:rPr/>";
      // Text content sits between tags — only content-level escaping needed.
      const text = run.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<a:r>${rPrXml}<a:t>${text}</a:t></a:r>`;
    }).join("");
    return `<a:p>${pPrXml}${runsXml}</a:p>`;
  }).join("");

  // Match the sp with this id and replace its txBody.
  // We look for cNvPr id="N" (where N = shapeId) within a p:sp block.
  // IMPORTANT: inside a template literal, \s and \S lose their backslashes
  // and become the literal characters s/S, so [\\s\\S] must be used to
  // produce the intended [\s\S] in the compiled RegExp string.
  const spRegex = new RegExp(
    `(<p:sp>(?:(?!</p:sp>)[\\s\\S])*?<p:cNvPr[^>]+\\bid="${escapeRe(shapeId)}"[^>]*>(?:(?!</p:sp>)[\\s\\S])*?)<p:txBody>(?:(?!</p:txBody>)[\\s\\S])*?</p:txBody>((?:(?!</p:sp>)[\\s\\S])*?</p:sp>)`,
    "g",
  );

  const replaced = slideXml.replace(spRegex, (_, before, after) => {
    return `${before}<p:txBody><a:bodyPr/><a:lstStyle/>${parasXml}</p:txBody>${after}`;
  });

  return replaced !== slideXml ? replaced : slideXml;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-zip the (possibly modified) raw entries back to a Uint8Array.
export function serializePptx(doc: PptxDoc): Uint8Array {
  const toZip: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(doc.raw)) toZip[k] = v;
  return zipSync(toZip, { level: 6 });
}

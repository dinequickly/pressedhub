// Reusable image generation helpers. These wrap the OpenAI and Gemini image
// APIs and return raw vendor blobs so the caller decides what to do with the
// bytes (upload to Anthropic Files, store in supabase, etc).
//
// This module deliberately has no Anthropic/Supabase dependencies — it's just
// "give me image blobs from a vendor". image_tools.ts uses these to keep the
// agent tool dispatch path; the /vibe-boards/:id/generate endpoint uses these
// to run inline, prompt-card driven generations.

import { ENV } from "./env.ts";

export type GenOpts = {
  n?: number;
  size?: string;
  quality?: string;
  /** Reference images. When set, OpenAI uses /v1/images/edits; Gemini
   *  inlines them as multimodal parts alongside the text. */
  references?: Blob[];
};

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
  }
  return btoa(s);
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return fallback;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function imageItemToBlob(item: { b64_json?: string; url?: string }): Promise<Blob> {
  if (item.b64_json) return base64ToBlob(item.b64_json, "image/png");
  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Failed to download generated image: ${res.status}`);
    return await res.blob();
  }
  throw new Error("Image generation result had no data");
}

/** Generate via OpenAI gpt-image-1. With references, switches to the
 *  /v1/images/edits endpoint (multipart) so the model conditions on the
 *  attached images. Returns one blob per requested variant. */
export async function generateOpenAI(prompt: string, opts: GenOpts = {}): Promise<Blob[]> {
  if (!ENV.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured. Set it via `supabase secrets set OPENAI_API_KEY=...`.");
  }
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("prompt is required");
  const n = clampInt(opts.n, 1, 1, 4);
  const size = opts.size ?? "auto";
  const quality = opts.quality ?? "medium";
  const refs = opts.references ?? [];

  let res: Response;
  if (refs.length > 0) {
    // Edits endpoint accepts one image at a time as primary; for multiple
    // refs gpt-image-1 takes them all under repeated `image[]` parts.
    const fd = new FormData();
    fd.append("model", "gpt-image-1");
    fd.append("prompt", trimmed);
    fd.append("n", String(n));
    fd.append("size", size);
    fd.append("quality", quality);
    refs.forEach((ref, i) => {
      const ext = (ref.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
      fd.append("image[]", ref, `ref_${i}.${ext}`);
    });
    res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "Authorization": `Bearer ${ENV.OPENAI_API_KEY}` },
      body: fd,
    });
  } else {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-image-1", prompt: trimmed, n, size, quality }),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image gen failed (${res.status}): ${text}`);
  }
  const json = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> };
  const blobs: Blob[] = [];
  for (const item of json.data ?? []) {
    blobs.push(await imageItemToBlob(item));
  }
  if (blobs.length === 0) throw new Error("OpenAI returned no image data");
  return blobs;
}

export const GEMINI_MODELS = {
  fast: "gemini-3.1-flash-image-preview",
  quality: "gemini-3-pro-image-preview",
} as const;

export type GeminiTier = keyof typeof GEMINI_MODELS;

/** Generate via Gemini image-preview models. One image per request, so we
 *  loop on the n axis. References inline as `inlineData` parts before the
 *  text part, mirroring Google's multimodal contract. */
export async function generateGemini(
  prompt: string,
  opts: GenOpts & { tier?: GeminiTier } = {},
): Promise<Blob[]> {
  if (!ENV.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured. Set it via `supabase secrets set GEMINI_API_KEY=...`.");
  }
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("prompt is required");
  const n = clampInt(opts.n, 1, 1, 4);
  const tier: GeminiTier = opts.tier ?? "fast";
  const model = GEMINI_MODELS[tier];

  // Build the request parts: each reference image first as inlineData, then
  // the text prompt last so the model treats the prompt as the operative
  // instruction over the references.
  const refParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const ref of opts.references ?? []) {
    refParts.push({
      inlineData: {
        mimeType: ref.type || "image/png",
        data: await blobToBase64(ref),
      },
    });
  }

  const blobs: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ENV.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [...refParts, { text: trimmed }],
          }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini image gen failed (${res.status}): ${text}`);
    }
    const json = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data);
    if (!inline?.inlineData?.data) {
      throw new Error("Gemini returned no image data");
    }
    blobs.push(base64ToBlob(inline.inlineData.data, inline.inlineData.mimeType ?? "image/png"));
  }
  return blobs;
}

/** Vendor-dispatching helper. The new prompt-card UI offers `gemini-fast`
 *  and `gemini-quality` tiers; `openai` is still supported for the agent's
 *  tool-dispatch path. The legacy `gemini` value is treated as `gemini-fast`. */
export type ImageGenModel = "openai" | "gemini" | "gemini-fast" | "gemini-quality";

export async function generateImage(
  model: ImageGenModel,
  prompt: string,
  opts: GenOpts = {},
): Promise<Blob[]> {
  if (model === "openai") return generateOpenAI(prompt, opts);
  if (model === "gemini" || model === "gemini-fast") {
    return generateGemini(prompt, { ...opts, tier: "fast" });
  }
  if (model === "gemini-quality") {
    return generateGemini(prompt, { ...opts, tier: "quality" });
  }
  throw new Error(`Unknown image model: ${model}`);
}

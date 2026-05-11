// Minimal Groq Chat Completions wrapper. Used for per-row LLM calls in the
// CSV ai-fill flow — small, cheap completions where Anthropic would be
// overkill latency-wise. Groq's API is OpenAI-compatible.

import { ENV } from "./env.ts";
import { Upstream } from "./errors.ts";

const BASE = "https://api.groq.com/openai/v1";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export const Groq = {
  async chat(input: {
    messages: ChatMessage[];
    model?: string;
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ text: string }> {
    if (!ENV.GROQ_API_KEY) throw new Upstream("GROQ_API_KEY is not set");
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ENV.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model ?? ENV.GROQ_MODEL,
        messages: input.messages,
        max_tokens: input.max_tokens ?? 256,
        temperature: input.temperature ?? 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Upstream(`Groq ${res.status}: ${text}`);
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return { text };
  },
};

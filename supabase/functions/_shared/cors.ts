// CORS preflight + wrap helper. Every edge function delegates to wrap() so
// requests from the browser don't trip on missing headers.

const ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type, idempotency-key";
const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": ALLOW_HEADERS,
  "Access-Control-Allow-Methods": ALLOW_METHODS,
  "Access-Control-Max-Age": "86400",
};

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  return null;
}

type Handler = (req: Request) => Promise<Response> | Response;

export function wrap(handler: Handler): Handler {
  return async (req) => {
    const pf = preflight(req);
    if (pf) return pf;
    try {
      const res = await handler(req);
      // Ensure CORS headers on every response.
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      const e = err as Error & {
        status?: number;
        code?: string;
        details?: unknown;
        // ZodError shape — `issues` is the field-level breakdown.
        issues?: Array<{ path: (string | number)[]; message: string; code: string }>;
      };

      // Zod validation errors → 422 with a flat list of field errors.
      if (Array.isArray(e.issues)) {
        const body = JSON.stringify({
          error: {
            code: "validation_error",
            message: e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            details: e.issues,
          },
        });
        return new Response(body, {
          status: 422,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const status = e.status ?? 500;
      const body = JSON.stringify({
        error: {
          code: e.code ?? "internal_error",
          message: e.message ?? "Internal error",
          details: e.details,
        },
      });
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  };
}

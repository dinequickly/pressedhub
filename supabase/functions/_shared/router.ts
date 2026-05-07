// Tiny in-function router: each function exposes one or more endpoints under
// the same base path. Edge functions in Supabase mount at /functions/v1/<name>,
// so this lets us implement REST-like resources cleanly.

import { BadRequest, NotFound } from "./errors.ts";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

type Route = {
  method: Method;
  pattern: URLPattern;
  handler: Handler;
};

export class Router {
  private routes: Route[] = [];
  constructor(private baseFunctionName: string) {}

  add(method: Method, pattern: string, handler: Handler) {
    // pattern is relative to the function root, eg "/" or "/:id" or "/:id/events".
    // The edge runtime invokes the function with EITHER `/<name>/<rest>` or
    // `/functions/v1/<name>/<rest>` depending on whether requests come through
    // Kong (production) or directly to edge-runtime (some local setups). We
    // register both so the function works in both modes.
    const baseAlternates = [
      `/${this.baseFunctionName}${pattern}`,
      `/functions/v1/${this.baseFunctionName}${pattern}`,
    ];
    // Allow the trailing slash on the root path to be optional. URLPattern
    // treats `/foo/` and `/foo` as different.
    for (const base of baseAlternates) {
      this.routes.push({ method, pattern: new URLPattern({ pathname: base }), handler });
      if (pattern === "/") {
        const stripped = base.replace(/\/$/, "");
        this.routes.push({
          method,
          pattern: new URLPattern({ pathname: stripped }),
          handler,
        });
      }
    }
    return this;
  }

  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec({ pathname: url.pathname });
      if (match) {
        const params = match.pathname.groups as Record<string, string>;
        return await route.handler(req, params);
      }
    }
    throw new NotFound(`No route for ${req.method} ${url.pathname}`);
  }
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch (_err) {
    throw new BadRequest("Body must be valid JSON");
  }
}

// Typed errors that wrap() turns into a uniform JSON envelope.

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BadRequest extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "bad_request", message, details);
  }
}

export class Unauthorized extends HttpError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class Forbidden extends HttpError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
  }
}

export class NotFound extends HttpError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class Conflict extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
  }
}

export class UnprocessableEntity extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, "unprocessable_entity", message, details);
  }
}

export class Upstream extends HttpError {
  constructor(message: string, details?: unknown) {
    super(502, "upstream_error", message, details);
  }
}

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

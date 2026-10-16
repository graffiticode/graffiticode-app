// RFC 9457 problem details. Every error this API returns is one of these, with
// a stable `code`; the `type` URI names it.
import type { Context } from "hono";

export const PROBLEM_BASE = "https://openapi.graffiticode.org/problems/";

export type ProblemFields = {
  detail?: string;
  errors?: Array<{ pointer: string; message: string }>;
  headers?: Record<string, string>;
  [extra: string]: unknown;
};

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly fields: ProblemFields;
  constructor(status: number, code: string, title: string, fields: ProblemFields = {}) {
    super(fields.detail ?? title);
    this.status = status;
    this.code = code;
    this.title = title;
    this.fields = fields;
  }
}

export function problemResponse(c: Context, p: ApiProblem) {
  const { headers = {}, ...rest } = p.fields;
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(JSON.stringify({
    type: `${PROBLEM_BASE}${p.code}`,
    title: p.title,
    status: p.status,
    code: p.code,
    instance: c.req.path,
    ...rest,
  }), p.status as any, { "Content-Type": "application/problem+json" });
}

export const notFound = (what: string) => new ApiProblem(404, "not_found", "Not found", { detail: `${what} not found.` });
export const unavailable = (detail: string, retryAfter = 30) =>
  new ApiProblem(503, "unavailable", "Temporarily unavailable", { detail, headers: { "Retry-After": String(retryAfter) } });

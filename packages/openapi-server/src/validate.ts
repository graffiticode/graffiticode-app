// Request validation compiled from openapi.yaml at startup. Every request is
// checked before any core call; a failure is a 400 problem listing where.
// Schemas are JSON Schema 2020-12 (OpenAPI 3.1), so ajv's 2020 build.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { ApiProblem } from "./problems.js";

type In = "path" | "query" | "header";
type Compiled = Record<In, ValidateFunction | null> & { body: ValidateFunction | null };

// Resolves local $refs ("#/components/...") so each compiled schema stands alone.
export function deref(spec: any, node: any, seen = new Set<string>()): any {
  if (Array.isArray(node)) return node.map(n => deref(spec, n, seen));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    if (seen.has(node.$ref)) throw new Error(`circular $ref ${node.$ref}`);
    const target = node.$ref.slice(2).split("/").reduce((o: any, k: string) => o?.[k], spec);
    return deref(spec, target, new Set([...seen, node.$ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(spec, v, seen)]));
}

export function createAjv() {
  const ajv = new (Ajv2020 as any).default({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
  (addFormats as any).default(ajv);
  return ajv;
}

export function compileValidators(spec: any) {
  const ajv = createAjv();
  const byOperation = new Map<string, Compiled>();
  for (const [, item] of Object.entries<any>(spec.paths ?? {})) {
    const shared = (item.parameters ?? []).map((p: any) => deref(spec, p));
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op?.operationId) continue;
      const params = [...shared, ...(op.parameters ?? []).map((p: any) => deref(spec, p))];
      const compiled: Compiled = { path: null, query: null, header: null, body: null };
      const media = op.requestBody?.content?.["application/json"] ?? op.requestBody?.content?.["application/merge-patch+json"];
      if (media?.schema) compiled.body = ajv.compile(deref(spec, media.schema));
      for (const where of ["path", "query", "header"] as In[]) {
        const ps = params.filter((p: any) => p.in === where);
        if (!ps.length) continue;
        const name = (p: any) => (where === "header" ? String(p.name).toLowerCase() : p.name);
        compiled[where] = ajv.compile({
          type: "object",
          properties: Object.fromEntries(ps.map((p: any) => [name(p), p.schema ?? {}])),
          required: ps.filter((p: any) => p.required).map(name),
        });
      }
      byOperation.set(op.operationId, compiled);
    }
  }
  return byOperation;
}

const toPointer = (where: string, e: ErrorObject) => {
  const missing = e.keyword === "required" ? `/${(e.params as any).missingProperty}`
    : e.keyword === "additionalProperties" ? `/${(e.params as any).additionalProperty}` : "";
  return `/${where}${e.instancePath}${missing}`;
};

/**
 * Validates (and, for query parameters, coerces and defaults) one request.
 * Returns the validated values; throws a 400 problem otherwise.
 */
export function validateRequest(
  validators: Map<string, Compiled>,
  operationId: string,
  input: { path?: Record<string, string>; query?: Record<string, string>; header?: Record<string, string> },
) {
  const compiled = validators.get(operationId);
  if (!compiled) throw new Error(`no validator for ${operationId}`);
  const out: Record<In, Record<string, any>> = { path: { ...(input.path ?? {}) }, query: { ...(input.query ?? {}) }, header: { ...(input.header ?? {}) } };
  const errors: Array<{ pointer: string; message: string }> = [];
  for (const where of ["path", "query", "header"] as In[]) {
    const v = compiled[where];
    if (v && !v(out[where])) {
      for (const e of v.errors ?? []) errors.push({ pointer: toPointer(where, e), message: e.message ?? "invalid" });
    }
  }
  if (errors.length) {
    throw new ApiProblem(400, "invalid_request", "The request doesn't match the API description", {
      detail: errors.map(e => `${e.pointer}: ${e.message}`).join("; "),
      errors,
    });
  }
  return out;
}

// Request bodies: JSON, at most 64KB, matching the operation's schema
// (additionalProperties: false, so unknown fields are refused).
export const MAX_BODY_BYTES = 64 * 1024;

export function validateBody(validators: Map<string, Compiled>, operationId: string, raw: string): any {
  const v = validators.get(operationId)?.body;
  if (!v) throw new Error(`no body schema for ${operationId}`);
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    throw new ApiProblem(413, "payload_too_large", "Request body too large", { detail: `At most ${MAX_BODY_BYTES} bytes.` });
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new ApiProblem(400, "invalid_json", "The request body isn't JSON");
  }
  if (!v(body)) {
    const errors = (v.errors ?? []).map(e => ({ pointer: toPointer("body", e), message: e.message ?? "invalid" }));
    throw new ApiProblem(400, "invalid_request", "The request doesn't match the API description", {
      detail: errors.map(e => `${e.pointer}: ${e.message}`).join("; "),
      errors,
    });
  }
  return body;
}

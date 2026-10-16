// The Graffiticode REST API (Phase 4): resources over @graffiticode-app/core,
// beside the MCP server. openapi.yaml is the contract; requests are validated
// against it before any core call, and every error is application/problem+json.
//
// Like every front door, this service holds no model key and calls no Policy
// route: LLM work (generation, get_spec) runs in the console.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { loadSpec } from "./spec.js";
import { compileValidators, validateBody, validateRequest } from "./validate.js";
import { ApiProblem, problemResponse } from "./problems.js";
import { languageRoutes } from "./routes/languages.js";
import { skillRoutes } from "./routes/skills.js";
import { metaRoutes } from "./routes/meta.js";
import { itemRoutes } from "./routes/items.js";
import { accountRoutes } from "./routes/account.js";
import { coreReadiness } from "@graffiticode-app/core/readiness";

export type Validate = (c: Context, operationId: string) => { path: Record<string, any>; query: Record<string, any>; header: Record<string, any> };
export type ValidateBody = (raw: string, operationId: string) => any;

export function createApp({ spec = loadSpec() }: { spec?: any } = {}) {
  const validators = compileValidators(spec);
  const validate: Validate = (c, operationId) => validateRequest(validators, operationId, {
    path: c.req.param() as Record<string, string>,
    query: Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => [k, v[v.length - 1]])),
    header: Object.fromEntries([...c.req.raw.headers.entries()]),
  });
  const body: ValidateBody = (raw, operationId) => validateBody(validators, operationId, raw);

  const app = new Hono();

  app.use("*", async (c, next) => {
    const id = c.req.header("x-request-id") || randomUUID();
    c.header("X-Request-Id", id);
    await next();
  });
  app.use("*", cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "Prefer", "If-None-Match", "X-Graffiticode-Workspace"],
    exposeHeaders: ["ETag", "Location", "Retry-After", "Preference-Applied", "Graffiticode-Workspace", "X-Request-Id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));

  // Liveness for gc-deploy; ?deep=1 checks what core needs to serve items
  // here: Firestore, the generation queue, secrets, free-plan credentials.
  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.query("deep") !== "1") return c.json({ status: "ok" });
    const r = await coreReadiness();
    return c.json({ status: r.ok ? "ok" : "unready", effectiveProtocol: r.effectiveProtocol, minProtocol: r.minProtocol, checks: r.checks }, r.ok ? 200 : 503);
  });

  const v1 = new Hono();
  languageRoutes(v1, validate);
  itemRoutes(v1, validate, body);
  accountRoutes(v1);
  skillRoutes(v1, validate);
  metaRoutes(v1, spec);
  app.route("/v1", v1);

  app.notFound((c) => problemResponse(c, new ApiProblem(404, "not_found", "Not found", { detail: `No route for ${c.req.method} ${c.req.path}.` })));
  app.onError((err, c) => {
    if (err instanceof ApiProblem) return problemResponse(c, err);
    console.error("[openapi] unhandled", c.req.method, c.req.path, err);
    return problemResponse(c, new ApiProblem(500, "internal", "Internal error", { detail: "Something went wrong on our side." }));
  });
  return app;
}

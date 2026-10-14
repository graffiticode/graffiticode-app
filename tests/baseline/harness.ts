// Phase 0.5 behaviour baseline: runs the console's GraphQL handler (and, through
// it, the MCP tools) in-process against the Firestore emulator, with every
// other external dependency faked on loopback. Nothing here may reach the
// network: the fetch router and the axios adapter refuse unknown hosts.
//
// Order matters. Console modules read most of their configuration at import
// (NEXT_PUBLIC_GC_API_URL, GENERATION_QUEUE_*, ...), so start() brings up the
// fakes, sets the environment and installs the interceptors first, and only
// then imports the handler.

import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONSOLE = path.join(ROOT, "packages/console");
const STATIC = (lang: string) => {
  const dir = path.join(ROOT, `node_modules/@graffiticode/l${lang}/dist/static`);
  return existsSync(dir) ? dir : path.join(ROOT, "node_modules/@graffiticode/l0175/dist/static");
};

export const PROJECT = process.env.GCLOUD_PROJECT || "demo-baseline";
export const JOB_SECRET = "baseline-job-secret";
export const FREE_PLAN_KEY = "baseline-free-plan-key";
export const TRIAL_UID = "trial-uid";
const WORKER_URL = "http://worker.baseline.test/api/generate-job";

// --- small http helpers ------------------------------------------------------

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// An unsigned JWT: the console decodes `sub` from Firebase ID tokens without
// verifying them (api-credentials.ts), so tests only need the payload.
export function fakeIdToken(uid: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: uid, user_id: uid })}.sig`;
}

// --- the fake backend (api.graffiticode.org + auth.graffiticode.org) --------

export type Calls = Array<{ method: string; path: string; body?: any; headers: http.IncomingHttpHeaders }>;

export type CompileResponder = (req: { id: string; connectionId: string; idempotencyKey: string }) =>
  { status: number; body: unknown };

export type ReconcileResponder = (req: { connectionId: string; idempotencyKey: string }) =>
  { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

type BackendState = {
  compile: CompileResponder;
  reconcile: ReconcileResponder;
  connections: any[];
  tasks: Map<string, any>;
};

function fakeBackend(calls: Calls, state: BackendState) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url!, "http://x");
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, path: url.pathname + url.search, body, headers: req.headers });

    // auth.graffiticode.org
    if (req.method === "POST" && url.pathname === "/oauth/verify") {
      const token = String(body?.idToken ?? "");
      if (token.startsWith("user:")) {
        return sendJson(res, 200, { status: "success", data: { uid: token.slice(5), token } });
      }
      return sendJson(res, 401, { status: "error", error: { message: "invalid token" } });
    }
    if (req.method === "POST" && url.pathname === "/authenticate/api-key") {
      const token = String(body?.token ?? "");
      const uid = token === FREE_PLAN_KEY ? TRIAL_UID : token.startsWith("key:") ? token.slice(4) : null;
      if (!uid) return sendJson(res, 401, { status: "error", error: { message: "bad key" } });
      return sendJson(res, 200, { status: "success", data: { firebaseCustomToken: `custom:${uid}` } });
    }

    // policy (connections and W5 receipts); POLICY_URL points here when a test sets it
    if (req.method === "GET" && url.pathname === "/v1/connections") {
      return sendJson(res, 200, { status: "success", data: state.connections });
    }
    if (req.method === "GET" && url.pathname === "/v1/shared") {
      return sendJson(res, 200, { status: "success", data: [] });
    }
    if (req.method === "POST" && url.pathname === "/v1/receipts/reconcile") {
      const r = await state.reconcile({ connectionId: body?.connectionId, idempotencyKey: body?.idempotencyKey });
      return sendJson(res, r.status, r.body);
    }

    // api.graffiticode.org
    if (req.method === "GET" && url.pathname === "/lang-overrides") {
      return sendJson(res, 200, { status: "success", data: { langs: [] } });
    }
    const asset = url.pathname.match(/^\/L(\d{4})\/(.+)$/);
    if (req.method === "GET" && asset) {
      const file = path.join(STATIC(asset[1]), asset[2]);
      if (!existsSync(file)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200);
      return res.end(readFileSync(file));
    }
    if (req.method === "POST" && url.pathname === "/task") {
      const task = body?.task;
      const id = createHash("sha256").update(JSON.stringify(task)).digest("hex").slice(0, 20);
      state.tasks.set(id, task);
      return sendJson(res, 200, { status: "success", data: { id } });
    }
    if (req.method === "GET" && url.pathname === "/task") {
      const ids = String(url.searchParams.get("id")).split("+");
      const found = ids.map(id => state.tasks.get(id));
      if (found.some(t => !t)) return sendJson(res, 404, { status: "error", error: { message: "no task" } });
      return sendJson(res, 200, { status: "success", data: found });
    }
    if (req.method === "GET" && url.pathname === "/data") {
      const id = url.searchParams.get("id");
      return sendJson(res, 200, { status: "success", data: { compiled: true, id } });
    }
    if (req.method === "POST" && url.pathname === "/compile") {
      const r = state.compile({ id: body?.id, connectionId: body?.connectionId, idempotencyKey: body?.idempotencyKey });
      return sendJson(res, r.status, r.body);
    }
    sendJson(res, 404, { status: "error", error: { message: `fake backend: no route ${req.method} ${url.pathname}` } });
  };
}

// --- the LLM ---------------------------------------------------------------

export type LlmResponder = (req: { system?: string; messages: any[]; model: string }) => string;

function sseOf(text: string) {
  const lines = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return lines.map(l => `event: ${l.type}\ndata: ${JSON.stringify(l)}\n\n`).join("");
}

// --- the harness -------------------------------------------------------------

export type Auth = { token: string } | { freePlan: string } | null;

export type Harness = {
  consoleOrigin: string;
  backendOrigin: string;
  calls: Calls;
  external: string[];
  llmRequests: any[];
  jobs: Promise<unknown>[];
  jobPayloads: any[];
  setLlm(fn: LlmResponder, delayMs?: number): void;
  setCompile(fn: CompileResponder): void;
  setReconcile(fn: ReconcileResponder): void;
  setConnections(connections: any[]): void;
  addTask(task: { lang: string; code: unknown }): string;
  enablePolicy(): void;
  disablePolicy(): void;
  gql<T = any>(query: string, variables?: Record<string, unknown>, auth?: Auth, headers?: Record<string, string>): Promise<{ status: number; body: { data?: T; errors?: any[] } & Record<string, any> }>;
  drainJobs(): Promise<void>;
  resetFirestore(): Promise<void>;
  db: any;
  stop(): Promise<void>;
};

const DEFAULT_PROGRAM = readFileSync(path.join(STATIC("0175"), "template.gc"), "utf8");

export async function start(): Promise<Harness> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("baseline: FIRESTORE_EMULATOR_HOST is not set; run via `npm run test:baseline`");
  }
  process.chdir(CONSOLE); // the RAG fallback reads ./training relative to cwd

  const calls: Calls = [];
  const external: string[] = [];
  const llmRequests: any[] = [];
  const jobs: Promise<unknown>[] = [];
  const jobPayloads: any[] = [];
  const defaultLlm = (() => "```\n" + DEFAULT_PROGRAM + "\n```") as LlmResponder;
  const defaultCompile = (() => ({ status: 200, body: { status: "success", data: { id: "x" } } })) as CompileResponder;
  const defaultReconcile = (() => ({ status: 200, body: { status: "success", data: { operations: [] } } })) as ReconcileResponder;
  const state: BackendState & { llm: LlmResponder; llmDelayMs: number } = {
    compile: defaultCompile,
    reconcile: defaultReconcile,
    connections: [],
    tasks: new Map<string, any>(),
    llm: defaultLlm,
    llmDelayMs: 0,
  };

  const backend = await listen(fakeBackend(calls, state));

  Object.assign(process.env, {
    GCLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    NEXT_PUBLIC_GC_API_URL: backend.origin,
    NEXT_PUBLIC_GC_AUTH_URL: backend.origin,
    NEXT_PUBLIC_FIREBASE_API_KEY: "baseline-firebase-web-key",
    FREE_PLAN_NAMESPACE_SALT: "baseline-salt",
    FREE_PLAN_API_KEY: FREE_PLAN_KEY,
    INTERNAL_JOB_SECRET: JOB_SECRET,
    GENERATION_QUEUE_LOCAL: "1",
    GENERATION_JOB_URL: WORKER_URL,
    CONSOLE_URL: "http://console.baseline.test",
    ANTHROPIC_API_KEY: "baseline-anthropic-key",
    SCOPE_GATE_ENABLED: "false",
    // "prod" so item billing runs its accounting (Stripe stays a no-op: no key).
    GC_TELEMETRY_ENV: "prod",
  });
  for (const k of ["OPENAI_API_KEY", "STRIPE_SECRET_KEY", "POLICY_URL", "SENDGRID_API_KEY",
    "TWILIO_ACCOUNT_SID", "LANGUAGE_SERVER_BASE_URL", "ENABLE_DSPY_SERVICE", "K_SERVICE"]) {
    delete process.env[k];
  }

  // Policy calls carry Google-signed service identity tokens; stub the minting.
  const { GoogleAuth } = await import("google-auth-library");
  (GoogleAuth.prototype as any).getIdTokenClient = async () => ({
    getRequestHeaders: async () => ({ Authorization: "Bearer baseline-service-identity" }),
  });

  // axios: Anthropic only. Every Anthropic call in the console uses the default
  // instance (llm-generation-service, language-router, spec-generation-service).
  const axios = (await import("axios")).default;
  axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (url !== "https://api.anthropic.com/v1/messages") {
      external.push(`axios ${config.method} ${url}`);
      throw new Error(`baseline: refused external axios call to ${url}`);
    }
    const req = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    llmRequests.push(req);
    if (state.llmDelayMs) await new Promise(r => setTimeout(r, state.llmDelayMs));
    const text = state.llm(req);
    if (config.responseType === "stream") {
      return { status: 200, statusText: "OK", headers: {}, config, data: Readable.from([sseOf(text)]) };
    }
    return {
      status: 200, statusText: "OK", headers: {}, config,
      data: { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" },
    };
  };

  // fetch: loopback passes through; Firebase's token exchange and the
  // generation worker are answered here; anything else is refused.
  const realFetch = globalThis.fetch;
  let jobHandler: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
      const { token } = JSON.parse(init?.body ?? "{}");
      const uid = String(token).replace(/^custom:/, "");
      return new Response(JSON.stringify({ idToken: fakeIdToken(uid), refreshToken: "r", expiresIn: "3600" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === WORKER_URL) {
      const body = JSON.parse(init?.body ?? "{}");
      jobPayloads.push(body);
      const p = invoke(jobHandler, { method: "POST", headers: lower(init?.headers), body });
      jobs.push(p);
      await p;
      return new Response("{}", { status: 200 });
    }
    external.push(`fetch ${url}`);
    throw new Error(`baseline: refused external fetch to ${url}`);
  }) as typeof fetch;

  const apiHandler = (await import("../../packages/console/src/pages/api/index")).default;
  jobHandler = (await import("../../packages/console/src/pages/api/generate-job")).default;
  const admin = (await import("firebase-admin")).default;

  const consoleServer = await listen(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const raw = await readBody(req);
    const r: any = req;
    r.query = Object.fromEntries(url.searchParams);
    r.body = raw ? JSON.parse(raw) : undefined;
    const handler = url.pathname === "/api/generate-job" ? jobHandler : apiHandler;
    await handler(r, nextRes(res));
  });

  async function gql(query: string, variables: Record<string, unknown> = {}, auth: Auth = null, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "content-type": "application/json", ...headers };
    if (auth && "token" in auth) h.authorization = auth.token;
    if (auth && "freePlan" in auth) h["x-free-plan-session"] = auth.freePlan;
    const res = await realFetch(`${consoleServer.origin}/api`, { method: "POST", headers: h, body: JSON.stringify({ query, variables }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  return {
    consoleOrigin: consoleServer.origin,
    backendOrigin: backend.origin,
    calls, external, llmRequests, jobs, jobPayloads,
    setLlm(fn, delayMs = 0) { state.llm = fn; state.llmDelayMs = delayMs; },
    setCompile(fn) { state.compile = fn; },
    setReconcile(fn) { state.reconcile = fn; },
    setConnections(connections) { state.connections = connections; },
    addTask(task) {
      const id = createHash("sha256").update(JSON.stringify(task)).digest("hex").slice(0, 20);
      state.tasks.set(id, task);
      return id;
    },
    enablePolicy() { process.env.POLICY_URL = backend.origin; },
    disablePolicy() { delete process.env.POLICY_URL; },
    gql,
    async drainJobs() {
      while (jobs.length) await Promise.allSettled(jobs.splice(0));
    },
    async resetFirestore() {
      const host = process.env.FIRESTORE_EMULATOR_HOST;
      await realFetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
      calls.length = 0;
      llmRequests.length = 0;
      jobPayloads.length = 0;
      state.llm = defaultLlm; state.llmDelayMs = 0;
      state.compile = defaultCompile; state.reconcile = defaultReconcile;
      state.connections = [];
      delete process.env.POLICY_URL;
    },
    db: admin.firestore(),
    async stop() {
      await this.drainJobs();
      backend.server.close();
      consoleServer.server.close();
      globalThis.fetch = realFetch;
    },
  };
}

function lower(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

// Next's API response helpers over a plain node response.
function nextRes(res: http.ServerResponse) {
  const r: any = res;
  r.status = (code: number) => { res.statusCode = code; return r; };
  r.json = (body: unknown) => { if (!res.headersSent) res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); return r; };
  r.send = (body: unknown) => { res.end(typeof body === "string" ? body : JSON.stringify(body)); return r; };
  return r;
}

// Calls a Next API handler in-process and resolves with its status and body.
function invoke(handler: any, { method, headers, body }: { method: string; headers: Record<string, string>; body: unknown }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    let out = "";
    const res: any = {
      statusCode: 200, headersSent: false, headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return this.headers[k.toLowerCase()]; },
      writeHead(code: number, h?: Record<string, string>) { this.statusCode = code; Object.assign(this.headers, h ?? {}); this.headersSent = true; return this; },
      write(chunk: string) { out += chunk; return true; },
      end(chunk?: string) { if (chunk) out += chunk; resolve({ status: this.statusCode, body: out }); return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(b: unknown) { this.end(JSON.stringify(b)); return this; },
      send(b: unknown) { this.end(typeof b === "string" ? b : JSON.stringify(b)); return this; },
    };
    Promise.resolve(handler({ method, headers, body, query: {} }, res)).catch(reject);
  });
}

// Signed-in user tokens the fake auth service accepts.
export const userToken = (uid: string) => `user:${uid}`;

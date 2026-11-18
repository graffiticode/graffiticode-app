// The service-tool family (installations plan, P4; A2A design §8; execution
// observation plan W7). A profile's MCP surface that selects "services" gets
// a catalog generated from its service definitions (core/service-catalog.ts):
// one tool per operation each available skill exposes, plus job_get and
// job_cancel. The parked Learnosity endpoint, generalized: Learnosity's tools
// are now just one installation's definitions.
//
// Every tool is a protocol representation of a service job
// (core/service-jobs.ts). What a tool's operation does, and who may call it,
// is code (core/capability-handlers.ts); the profile only selects skills and
// names their tools. Nothing here writes outside the installation: every
// generation runs with `externalWrites: false`, and the server refuses to
// start if a selected skill could write before execution is ready
// (assertServiceCatalogsWriteFree).
//
// Jobs belong to an account, so these endpoints take an API key. OAuth tokens
// are issued for /mcp only; a resource of their own is plan P5, and until
// then an OAuth bearer is refused rather than accepted for an audience it
// wasn't issued for.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveAuth } from "@graffiticode-app/core/auth";
import { capability, EXECUTION_READY } from "@graffiticode-app/core/capabilities";
import { authorize, CapabilityRefusal, operationInput, startOperation } from "@graffiticode-app/core/capability-handlers";
import { createServiceJob, findLiveServiceJob, readServiceJobEvents, requestServiceJobCancel, serviceJobFor, type ServiceJobDoc } from "@graffiticode-app/core/service-jobs";
import { digestInput, jobPrincipalOf, observeServiceJob, rejectServiceJob, startGenerationStep } from "@graffiticode-app/core/service-runner";
import { listServices, serviceDefinition, type ServiceDefinition } from "@graffiticode-app/core/service-registry";
import { serviceTools, type ServiceTool } from "@graffiticode-app/core/service-catalog";
import { isTerminalJobState } from "@graffiticode-app/core/service-job-state";
import { installationBrand } from "@graffiticode-app/core/profile/brand";
import { profile } from "./installation.js";
import { appUrl } from "./api.js";
import { formatToolResult } from "./tool-result.js";

export type ServiceSurface = { path: string; serviceIds: string[] | null };

// The installation's service surfaces: each MCP path that selects "services",
// and which services it serves (null: all).
export function serviceSurfaces(): ServiceSurface[] {
  return (profile()?.surfaces.mcp ?? [])
    .filter(m => m.families.includes("services"))
    .map(m => ({ path: m.path, serviceIds: m.services ?? null }));
}

const surfaceServices = (s: ServiceSurface): ServiceDefinition[] =>
  listServices().filter(d => !s.serviceIds || s.serviceIds.includes(d.serviceId));

// The surface's catalog, now: available skills only, then the job tools.
export const surfaceTools = (s: ServiceSurface): ServiceTool[] => serviceTools(surfaceServices(s), installationBrand().name);

// No selected skill may write before execution is ready. The validator
// refuses such a profile; this is the server's own check, at startup.
export function assertServiceCatalogsWriteFree() {
  if (EXECUTION_READY) return;
  for (const def of listServices()) {
    for (const s of def.skills) {
      const c = capability(s.capability);
      if (!c || c.externalWrites || c.requiresExecution) {
        throw new Error(`${def.serviceId}/${s.skillId} (${s.capability}) would write or need execution, which this release doesn't allow on a service surface.`);
      }
    }
  }
}

// A refusal the caller can act on, reported as a tool error.
export class ServiceToolError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
    this.name = "ServiceToolError";
  }
}

type Credentials = { token: string };
type CallOpts = { clientKind?: string; now?: number };

const reasonOf = (err: any): string => err?.reason ?? err?.code ?? (err?.name === "NotFoundError" ? "not_found" : "refused");
const toolError = (err: any) => new ServiceToolError(reasonOf(err), err?.message ?? String(err));

const optKey = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[\x21-\x7e]{1,255}$/.test(v)) {
    throw new ServiceToolError("invalid_argument", "idempotency_key must be 1-255 visible ASCII characters.");
  }
  return v;
};
const jobIdArg = (v: unknown) => {
  if (typeof v !== "string" || v.trim() === "") throw new ServiceToolError("invalid_argument", "job_id is required.");
  return v;
};
// What a request is, for its idempotency fingerprint: the surface it came
// through, the tool and its arguments (without the key itself), as sent. Never
// what the tool means now: a retry must match its first request whatever the
// catalog has become.
// The arguments are nested, so no argument can stand in for the surface or
// the tool.
const requestDigest = (surface: ServiceSurface, name: string, args: Record<string, unknown>) => {
  const { idempotency_key: _k, ...rest } = args;
  return digestInput({ surface: surface.path, tool: name, arguments: rest });
};

const SUMMARY: Record<string, string> = {
  accepted: "The job was accepted and hasn't started yet. Call job_get again shortly.",
  working: "The job is working. Call job_get with this job_id again in about 15 seconds.",
  completed: "The job completed.",
  failed: "The job failed; see findings.",
  canceled: "The job was canceled.",
  rejected: "The job was refused before anything was made; see refusal.",
};

async function view(job: ServiceJobDoc, itemId: string | null, taskId: string | null): Promise<Record<string, unknown>> {
  const { status, envelope } = job;
  const refusal = status.state === "rejected" ? await refusalOf(job) : null;
  const viewUrl = itemId ? `${appUrl()}/form/${itemId}` : null;
  let summary = SUMMARY[status.state] ?? `The job is ${status.state}.`;
  if (status.state === "completed" && viewUrl) {
    summary += ` Show the user this link to the result: [Open it](${viewUrl}). Nothing was written outside ${installationBrand().name}.`;
  }
  return {
    job_id: job.jobId,
    service_id: envelope.serviceId,
    skill_id: envelope.skillId,
    state: status.state,
    terminal: isTerminalJobState(status.state),
    external_outcome: status.externalOutcome,
    deliverable: { kind: envelope.deliverable.kind, requested_state: envelope.deliverable.requestedState },
    item_id: itemId,
    task_id: taskId,
    view_url: viewUrl,
    findings: status.verdict?.findings ?? [],
    refusal,
    cancel_requested: status.cancelRequested,
    summary,
  };
}

async function refusalOf(job: ServiceJobDoc): Promise<{ reason: string; message: string } | null> {
  const e = (await readServiceJobEvents(job.jobId)).find(ev => ev.type === "refused");
  return e ? { reason: String(e.data.reason), message: String(e.data.message) } : null;
}

async function caller(creds: Credentials) {
  const auth = await resolveAuth({ token: creds.token });
  if (auth.freePlan) throw new ServiceToolError("sign_in_required", "This endpoint needs an account. Connect with an API key.");
  return { auth, ...jobPrincipalOf(auth) };
}

async function observed(jobId: string, now?: number) {
  const o = await observeServiceJob(jobId, now ? { now } : {});
  if (!o) throw new ServiceToolError("not_found", "Job not found.");
  return view(o.job, o.itemId, o.taskId);
}

// Runs a job's one step if it hasn't run: its recorded request, under its
// pinned definition. A reservation an earlier attempt made is recovered, never
// redone. The job ends rejected only when it holds no reservation and none is
// being made (core rejectServiceJob, which revokes the step's authority to
// reserve in the same commit); when that can't be established, the job stays
// open and the caller is asked to retry.
const RETRY = new Set(["step_in_flight", "recovery_unavailable"]);
const ENDED = new Set(["capability_withdrawn", "job_terminal"]);

async function resume(job: ServiceJobDoc, creds: Credentials, opts: CallOpts) {
  if (!isTerminalJobState(job.status.state) && !job.steps?.generate?.generation) {
    try {
      await startGenerationStep(job.jobId, "generate", claim => startOperation(job, { token: creds.token, clientKind: opts.clientKind }, claim));
    } catch (err: any) {
      if (RETRY.has(err?.reason)) throw new ServiceToolError("in_progress", `${err.message} The job (${job.jobId}) is still open; retry, or call job_get.`);
      if (!ENDED.has(err?.reason)) {
        try {
          await rejectServiceJob(job.jobId, { reason: reasonOf(err), message: err?.message ?? String(err) });
        } catch {
          throw new ServiceToolError("in_progress", `The job (${job.jobId}) couldn't be settled yet; retry, or call job_get.`);
        }
      }
    }
  }
  return observed(job.jobId, opts.now);
}

// A new request's arguments must be the tool's declared ones.
function checkDeclared(tool: ServiceTool, args: Record<string, unknown>) {
  const declared = Object.keys((tool.inputSchema as any).properties ?? {});
  const extra = Object.keys(args).filter(k => !declared.includes(k));
  if (extra.length) throw new ServiceToolError("invalid_argument", `Unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}.`);
}

// A new job for a tool in the current catalog: its input validated against
// the operation now, then recorded with the job, which starts pinned.
async function startJob(surface: ServiceSurface, tool: ServiceTool, args: Record<string, unknown>, creds: Credentials, who: Awaited<ReturnType<typeof caller>>, opts: CallOpts) {
  const { serviceId, skillId, operation } = tool.target!;
  const def = serviceDefinition(serviceId)!;
  const skill = def.skills.find(s => s.skillId === skillId)!;
  checkDeclared(tool, args);
  let input: Record<string, string>;
  try {
    authorize(capability(skill.capability)!.authorization, who.auth);
    input = operationInput(operation, args);
  } catch (err) {
    throw toolError(err);
  }
  const created = await createServiceJob({
    serviceId,
    skillId,
    principal: who.principal,
    scope: who.scope,
    intent: input.description ?? input.modification,
    deliverable: { kind: skill.deliverableKind, requestedState: skill.deliveryStates[0] },
    inputDigest: requestDigest(surface, tool.name, args),
    idempotencyKey: optKey(args.idempotency_key),
    request: { surface: surface.path, tool: tool.name, operation, input },
    ...(opts.now ? { now: opts.now } : {}),
  }).catch(err => { throw toolError(err); });
  return resume(created.job, creds, opts);
}

export async function callServiceTool(surface: ServiceSurface, name: string, args: Record<string, unknown>, creds: Credentials, opts: CallOpts = {}): Promise<Record<string, unknown>> {
  if (name === "job_get" || name === "job_cancel") {
    // Existing jobs, whatever is selected now: an id the caller owns.
    const jobId = jobIdArg(args.job_id);
    const { principal } = await caller(creds);
    const job = await serviceJobFor(jobId, principal).catch(() => { throw new ServiceToolError("not_found", "Job not found."); });
    if (name === "job_cancel" && !isTerminalJobState(job.status.state)) {
      await requestServiceJobCancel(jobId, opts.now ? { now: opts.now } : {}).catch((err: any) => {
        if (err?.reason !== "job_terminal") throw err;
      });
    }
    return observed(jobId, opts.now);
  }
  const key = optKey(args.idempotency_key);
  const who = await caller(creds);
  // A retry first: the same key and the same request on this surface get
  // their job back, resumed under its pin, whatever the catalog says now.
  if (key) {
    const job = await findLiveServiceJob(who.scope, key, requestDigest(surface, name, args)).catch(err => { throw toolError(err); });
    if (job) return resume(job, creds, opts);
  }
  const tool = surfaceTools(surface).find(t => t.name === name && t.target);
  if (!tool) throw new ServiceToolError("unknown_tool", `Unknown tool: ${name}`);
  return startJob(surface, tool, args, creds, who, opts);
}

// --- the endpoint --------------------------------------------------------------

function createServiceServer(surface: ServiceSurface, bearer: string) {
  const brand = installationBrand().name;
  const server = new Server(
    { name: `${installationBrand().id}-services`, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `${brand} services, as jobs. A tool starts a job and returns its job_id; ` +
        `call job_get until the job is terminal, then show the user the view_url. Nothing here writes outside ${brand}.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: surfaceTools(surface).map(({ target: _t, ...tool }) => tool) as any[],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callServiceTool(surface, name, (args ?? {}) as Record<string, unknown>, { token: bearer }, { clientKind: server.getClientVersion()?.name });
      return formatToolResult(result) as any;
    } catch (err: any) {
      const known = err instanceof ServiceToolError || err instanceof CapabilityRefusal;
      const reason = known ? err.reason : "internal_error";
      const message = known ? err.message : "The request failed. Try again.";
      if (!known) console.error(`[services] ${name} failed: ${err?.message ?? err}`);
      return { isError: true, content: [{ type: "text", text: `${message} (${reason})` }] };
    }
  });
  return server;
}

const transports = new Map<string, { transport: StreamableHTTPServerTransport; bearer: string; path: string }>();

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export async function handleServiceMcp(surface: ServiceSurface, req: IncomingMessage, res: ServerResponse, bearer: string | null, isOAuthToken: (t: string) => boolean) {
  if (!bearer) {
    json(res, 401, { error: "unauthorized", error_description: "This endpoint needs an API key as the Bearer credential." });
    return;
  }
  if (isOAuthToken(bearer)) {
    json(res, 401, { error: "invalid_token", error_description: "OAuth tokens are issued for /mcp. Use an API key here." });
    return;
  }
  if (req.method === "GET") {
    json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server offers no standalone SSE stream" }, id: null }, { Allow: "POST, DELETE" });
    return;
  }
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const existing = sessionId ? transports.get(sessionId) : undefined;
  if (existing) {
    // A session is bound to the credential and the endpoint that opened it.
    if (existing.bearer !== bearer || existing.path !== surface.path) {
      json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    if (req.method === "DELETE") {
      transports.delete(sessionId!);
      json(res, 200, { status: "session terminated" });
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }
  if (sessionId) {
    json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { transports.set(id, { transport, bearer, path: surface.path }); },
  });
  transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
  await createServiceServer(surface, bearer).connect(transport);
  await transport.handleRequest(req, res);
}

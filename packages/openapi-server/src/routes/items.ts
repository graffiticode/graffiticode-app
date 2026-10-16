// Items: MCP's create_item, update_item, get_item, render_item and get_spec as
// resources, plus listing, rename, archive, versions, src/data, retry and an
// event stream. Everything runs through core in-process, except get_spec,
// which calls a model and so runs in the console.
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createFromDescription, reviseItem } from "@graffiticode-app/core/revise";
import { getItem, listItemSummaries, updateItem } from "@graffiticode-app/core/items";
import { getTask, readItemData } from "@graffiticode-app/core/tasks";
import { getTaskVersions } from "@graffiticode-app/core/versions";
import { jobFailure, retryGeneration } from "@graffiticode-app/core/generation-jobs";
import { reconcileTarget } from "@graffiticode-app/core/lib/write-errors";
import { callerFor, workspaceHandleIfMoved, type Caller } from "../auth.js";
import { fromCoreError } from "../errors.js";
import { ApiProblem, notFound } from "../problems.js";
import { bareLanguageId, decodeCursor, encodeCursor, languageId } from "../http.js";
import { publicBase } from "../spec.js";
import { consoleSpec } from "../console.js";
import { idempotent } from "../idempotency.js";
import { db } from "@graffiticode-app/core/db";
import { mintSessionToken } from "@graffiticode-app/core/lib/free-plan-session-token";
import type { Validate, ValidateBody } from "../app.js";

const APP_URL = () => process.env.GRAFFITICODE_APP_URL || "https://app.graffiticode.org";
const CONSOLE_URL = () => process.env.GRAFFITICODE_CONSOLE_BASE_URL || "https://console.graffiticode.org";
const CLIENT = "openapi";
const MAX_WAIT_S = 45;
const POLL_MS = 1000;
// A legacy (v1) job with no v2 deadline is reported failed past this, as MCP does.
const LEGACY_STALE_MS = 16 * 60_000;

const iso = (ms: unknown) => (ms != null && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

function statusOf(g: any, now = Date.now()): "generating" | "ready" | "failed" {
  if (g.generationStatus === "failed") return "failed";
  if (g.generationStatus === "generating") {
    const started = Number(g.generationStartedAt) || 0;
    if (g.generationDeadlineAt == null && started && now - started > LEGACY_STALE_MS) return "failed";
    return "generating";
  }
  return g.taskId ? "ready" : "generating";
}

// The REST Item from core's item (getItem or listItemSummaries).
async function representation(g: any, caller: Caller, extra: Record<string, unknown> = {}) {
  const base = `${publicBase()}/items/${g.id}`;
  const status = statusOf(g);
  const item: Record<string, unknown> = {
    id: g.id,
    name: g.name ?? null,
    language: languageId(g.lang),
    status,
    created: iso(g.created),
    updated: iso(g.updated),
    view_url: null,
    links: { self: base, view: `${base}/view`, spec: `${base}/spec`, events: `${base}/events`, revisions: `${base}/revisions` },
  };
  if (status === "generating") {
    const started = Number(g.generationStartedAt) || 0;
    item.progress = { chars: g.generationChars ?? 0, elapsed_s: started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0 };
  }
  if (status === "failed") {
    const failure = g.generation?.id ? await jobFailure(g.generation.id).catch(() => null) : null;
    item.error = {
      message: g.generationError || failure?.message || "Generation timed out",
      code: failure?.code ?? null,
      retryable: failure?.retryable ?? false,
    };
  }
  if (status === "ready") {
    const view = `${APP_URL()}/form/${g.id}`;
    item.view_url = caller.ctx.freePlan && g.claimToken ? `${view}?claim=${g.claimToken}` : view;
    if (caller.ctx.freePlan && g.claimToken) {
      item.claim_url = `${CONSOLE_URL()}/claim?token=${encodeURIComponent(g.claimToken)}&src=api`;
    }
  }
  const w = g.lastWrite;
  if (w?.taskId) {
    item.last_write = {
      task_id: w.taskId,
      connection_id: w.connectionId ?? null,
      status: w.status,
      message: w.message ?? null,
      at: iso(w.at),
      confirmed: w.confirmed ?? null,
      checkable: Boolean(reconcileTarget(w)),
      reconcile: w.reconcile ? { verdict: w.reconcile.verdict, text: w.reconcile.text, at: iso(w.reconcile.at) } : null,
    };
  }
  return { ...item, ...extra };
}

async function load(caller: Caller, id: string) {
  const auth = await caller.principal();
  let g: any;
  try {
    g = await getItem({ auth, id, connectionFields: false, typedErrors: true });
  } catch (err) {
    throw fromCoreError(err);
  }
  if (!g) throw notFound(`Item ${id}`);
  return { auth, g: { ...g, id } };
}

// RFC 7240 `Prefer: wait=N`; anything malformed is ignored.
function preferredWait(c: Context): number | null {
  const prefer = c.req.header("prefer") ?? "";
  const m = /(?:^|[,;\s])wait=(\d{1,3})(?:$|[,;\s])/i.exec(prefer);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= MAX_WAIT_S ? n : null;
}

// The 202 for a started generation, as a storable response (Idempotency-Key
// replays it verbatim).
async function accepted(caller: Caller, started: { itemId: string; workspaceNamespace?: string | null }) {
  const { g } = await load(caller, started.itemId);
  const headers: Record<string, string> = { Location: `${publicBase()}/items/${started.itemId}`, "Retry-After": "2" };
  const handle = await workspaceHandleIfMoved(caller, started.workspaceNamespace);
  if (handle) headers["Graffiticode-Workspace"] = handle;
  return { status: 202, headers, body: await representation(g, caller) };
}

// A key bound to a job whose request never answered: the same 202, rebuilt
// from what it made. The workspace comes from the job's envelope — the one the
// create actually landed in — not from this retry's credentials.
async function rebuilt(caller: Caller, op: { itemId: string; generationId: string }) {
  const env = (await db().doc(`generation-jobs/${op.generationId}`).get()).data()?.envelope;
  const response = await accepted(caller, { itemId: op.itemId });
  if (caller.ctx.freePlan && env?.effectiveWorkspace && env.effectiveWorkspace !== caller.ctx.sessionNamespace) {
    response.headers["Graffiticode-Workspace"] = await mintSessionToken({
      sessionNamespace: env.effectiveWorkspace, sessionUuid: caller.ctx.sessionUuid || env.effectiveWorkspace,
    });
  }
  return response;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw fromCoreError(err);
  }
}

export function itemRoutes(app: Hono, validate: Validate, validateBody: ValidateBody) {
  app.post("/items", async (c) => {
    validate(c, "create_item");
    const raw = await c.req.text();
    const body = validateBody(raw, "create_item");
    const caller = await callerFor(c);
    // Credentials are checked here, so a bad one is a 401 whatever core does next.
    await caller.principal();
    return idempotent(c, caller, raw, async (idempotency) => accepted(caller, await run(() => createFromDescription(caller.ctx as any, {
      lang: bareLanguageId(body.language),
      description: body.description,
      name: body.name,
      siblingOf: body.source_item_id,
      client: CLIENT,
      clientKind: caller.ctx.clientKind,
      idempotency,
    }) as any)), (op) => rebuilt(caller, op));
  });

  app.get("/items", async (c) => {
    const { query } = validate(c, "list_items");
    const caller = await callerFor(c);
    const auth = await caller.principal();
    const offset = decodeCursor(query.cursor);
    if (offset < 0) throw new ApiProblem(400, "invalid_cursor", "Invalid cursor", { detail: "Use next_cursor from a previous page." });
    // Status is derived, so a status filter reads the whole (sorted) list.
    const all = await run(() => listItemSummaries({
      auth, lang: query.language ? bareLanguageId(query.language) : undefined,
      offset: query.status ? 0 : offset, limit: query.status ? 100_000 : query.limit,
    }));
    let rows = all.items;
    let total = all.total;
    if (query.status) {
      rows = rows.filter((g: any) => statusOf(g) === query.status);
      total = rows.length;
      rows = rows.slice(offset, offset + query.limit);
    }
    const data = await Promise.all(rows.map((g: any) => representation(g, caller)));
    return c.json({ data, next_cursor: offset + query.limit < total ? encodeCursor(offset + query.limit) : null });
  });

  app.get("/items/:id", async (c) => {
    const { path, query } = validate(c, "get_item");
    const caller = await callerFor(c);
    const wait = preferredWait(c);
    const deadline = Date.now() + (wait ?? 0) * 1000;
    let { g } = await load(caller, path.id);
    while (statusOf(g) === "generating" && Date.now() + POLL_MS <= deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      ({ g } = await load(caller, path.id));
    }
    if (wait !== null) c.header("Preference-Applied", `wait=${wait}`);
    const item = await representation(g, caller);
    if (item.status === "generating") c.header("Retry-After", "2");
    const include = new Set(String(query.include ?? "").split(",").filter(Boolean));
    if (include.size && item.status === "ready") {
      const auth = await caller.principal();
      if (include.has("src")) item.src = (await run(() => getTask({ auth, id: g.taskId })))?.src ?? "";
      if (include.has("data")) item.data = await run(() => readItemData({ auth, id: g.taskId }));
    }
    return c.json(item);
  });

  app.patch("/items/:id", async (c) => {
    const { path } = validate(c, "rename_item");
    const body = validateBody(await c.req.text(), "rename_item");
    const caller = await callerFor(c);
    const { auth } = await load(caller, path.id);
    await run(() => updateItem({ auth, id: path.id, name: body.name }));
    const { g } = await load(caller, path.id);
    return c.json(await representation(g, caller));
  });

  app.delete("/items/:id", async (c) => {
    const { path } = validate(c, "archive_item");
    const caller = await callerFor(c);
    const { auth } = await load(caller, path.id);
    await run(() => updateItem({ auth, id: path.id, mark: 5 }));
    return c.body(null, 204);
  });

  app.post("/items/:id/revisions", async (c) => {
    const { path } = validate(c, "update_item");
    const raw = await c.req.text();
    const body = validateBody(raw, "update_item");
    const caller = await callerFor(c);
    await caller.principal();
    return idempotent(c, caller, raw, async (idempotency) => accepted(caller, await run(() => reviseItem(caller.ctx as any, {
      itemId: path.id, modification: body.modification, client: CLIENT, clientKind: caller.ctx.clientKind, idempotency,
    }) as any)), (op) => rebuilt(caller, op));
  });

  app.get("/items/:id/revisions", async (c) => {
    const { path, query } = validate(c, "list_revisions");
    const caller = await callerFor(c);
    const { auth, g } = await load(caller, path.id);
    const versions: any[] = await run(() => getTaskVersions({ auth, lang: g.lang, itemId: path.id, limit: query.limit }) as any);
    return c.json({
      data: (versions ?? []).map((v: any) => ({
        task_id: v.taskId, created: iso(v.createdAt), source: v.source ?? "unknown", label: v.label ?? null,
      })),
    });
  });

  app.post("/items/:id/retry", async (c) => {
    const { path } = validate(c, "retry_item");
    const caller = await callerFor(c);
    const { auth } = await load(caller, path.id);
    return idempotent(c, caller, "", async (idempotency) =>
      accepted(caller, await run(() => retryGeneration({ auth, itemId: path.id, idempotency }))), (op) => rebuilt(caller, op));
  });

  const ready = async (c: Context, operationId: string) => {
    const { path } = validate(c, operationId);
    const caller = await callerFor(c);
    const loaded = await load(caller, path.id);
    if (statusOf(loaded.g) !== "ready") {
      throw new ApiProblem(409, "not_ready", "Not ready", { detail: "The item is still generating, or failed.", headers: { "Retry-After": "2" } });
    }
    return { caller, ...loaded };
  };

  app.get("/items/:id/src", async (c) => {
    const { auth, g } = await ready(c, "get_item_src");
    const task = await run(() => getTask({ auth, id: g.taskId }));
    return c.body(task?.src ?? "", 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  app.get("/items/:id/data", async (c) => {
    const { auth, g } = await ready(c, "get_item_data");
    return c.json(await run(() => readItemData({ auth, id: g.taskId })));
  });

  app.get("/items/:id/spec", async (c) => {
    const { caller, g } = await ready(c, "get_spec");
    const s = await consoleSpec(g.id, caller.forward);
    return c.json({
      // Leads with a blank line, as MCP's get_spec does, and for the same
      // reason: the text is meant to follow a line of intent in a new item's
      // description, and the scope gate takes everything after the first blank
      // line as pasted content, not as the request.
      item_id: s.itemId, language: languageId(s.lang), spec: `\n\n${s.spec.replace(/^\s+/, "")}`,
      coverage_checked: s.coverage.checked, coverage_missing: s.coverage.missing,
    });
  });

  app.get("/items/:id/view", async (c) => {
    const { path } = validate(c, "render_item");
    const caller = await callerFor(c);
    const { g } = await load(caller, path.id);
    const item = await representation(g, caller);
    return c.redirect((item.view_url as string) ?? `${APP_URL()}/form/${path.id}`, 303);
  });

  app.get("/items/:id/embed", async (c) => {
    const { query } = validate(c, "embed_item");
    const { caller, g } = await ready(c, "embed_item");
    const item = await representation(g, caller);
    const width = Math.min(query.maxwidth ?? 800, 4000);
    const height = Math.min(query.maxheight ?? 600, 4000);
    const src = String(item.view_url).replace(/"/g, "&quot;");
    const title = String(item.name ?? "Graffiticode item").replace(/[<>&"]/g, ch => `&#${ch.charCodeAt(0)};`);
    return c.json({
      version: "1.0", type: "rich", title: item.name ?? "Graffiticode item",
      provider_name: "Graffiticode", provider_url: "https://graffiticode.org",
      html: `<iframe src="${src}" title="${title}" width="${width}" height="${height}" style="border:0" loading="lazy" allow="clipboard-write"></iframe>`,
      width, height,
    });
  });

  app.get("/items/:id/events", async (c) => {
    const { path } = validate(c, "item_events");
    const caller = await callerFor(c);
    await load(caller, path.id);
    return streamSSE(c, async (stream) => {
      const until = Date.now() + 10 * 60_000;
      let last = "";
      let lastBeat = Date.now();
      while (!stream.aborted && Date.now() < until) {
        const { g } = await load(caller, path.id);
        const item = await representation(g, caller);
        if (item.status !== "generating") {
          await stream.writeSSE({ event: item.status as string, data: JSON.stringify(item) });
          return;
        }
        const progress = JSON.stringify(item.progress);
        if (progress !== last) {
          await stream.writeSSE({ event: "progress", data: progress });
          last = progress;
        } else if (Date.now() - lastBeat >= 15_000) {
          await stream.write(": keepalive\n\n");
          lastBeat = Date.now();
        }
        await stream.sleep(POLL_MS);
      }
      // Still generating after the stream's lifetime: reconnect to keep following.
      if (!stream.aborted) await stream.writeSSE({ event: "timeout", data: JSON.stringify({ retry_after: 2 }) });
    });
  });
}

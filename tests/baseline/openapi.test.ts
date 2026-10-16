// Phase 4b: the REST API's items, against the emulator with the real console
// and worker behind them (v2, as in production). Every response is checked
// against openapi.yaml.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, userToken, type Harness } from "./harness";

let h: Harness;
let app: any;
let protocol: any;
let jobs: any;
let mintSessionToken: any;
let deriveSessionNamespace: any;
let spec: any;
let ajv: any;
let deref: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.OPENAPI_PUBLIC_URL = "https://openapi.test/v1";
  protocol = await import("@graffiticode-app/core/generation-protocol");
  jobs = await import("@graffiticode-app/core/generation-jobs");
  ({ mintSessionToken } = await import("@graffiticode-app/core/lib/free-plan-session-token"));
  ({ deriveSessionNamespace } = await import("@graffiticode-app/core/lib/free-plan-context"));
  app = (await import("../../packages/openapi-server/src/app.ts")).createApp();
  spec = (await import("../../packages/openapi-server/src/spec.ts")).loadSpec();
  const v = await import("../../packages/openapi-server/src/validate.ts");
  ajv = v.createAjv();
  deref = v.deref;
});
after(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.resetFirestore();
  await h.db.doc("system/generation-protocol").set({ minProtocol: 2 });
  protocol.resetProtocolFloorCache();
});

const PROGRAM = readFileSync(new URL("../../node_modules/@graffiticode/l0175/dist/static/template.gc", import.meta.url), "utf8");
const DESCRIPTION = "Write a short literary passage about a lighthouse keeper.";
const alice = { Authorization: `Bearer ${userToken("alice")}` };
const workspace = async (uuid: string) => ({
  "X-Graffiticode-Workspace": await mintSessionToken({ sessionNamespace: deriveSessionNamespace(uuid), sessionUuid: uuid }),
});

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(`http://x/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

// The response, checked against the operation's documented status, media type and schema.
async function conforms(res: Response, operationId: string) {
  const op = Object.values<any>(spec.paths).flatMap((i: any) => Object.values<any>(i)).find((o: any) => o?.operationId === operationId);
  const documented = op.responses[String(res.status)];
  assert.ok(documented, `${operationId}: ${res.status} is not documented (${await res.clone().text()})`);
  const content = deref(spec, documented).content;
  if (!content) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  assert.ok(content[type], `${operationId} ${res.status}: ${type} is not documented`);
  const text = await res.text();
  if (!type.endsWith("json")) return text;
  const body = JSON.parse(text);
  const validate = ajv.compile(deref(spec, content[type].schema));
  assert.ok(validate(body), `${operationId} ${res.status}: ${JSON.stringify(validate.errors)}`);
  return body;
}

async function created(headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/items", headers, { language: "L0175", description: DESCRIPTION, ...extra });
  const item = await conforms(res, "create_item");
  assert.equal(res.status, 202);
  await h.drainJobs();
  return { res, item };
}

test("no credentials: 401 with a challenge", async () => {
  const res = await call("POST", "/items", {}, { language: "L0175", description: DESCRIPTION });
  const p = await conforms(res, "create_item");
  assert.equal(p.code, "unauthenticated");
  assert.match(res.headers.get("www-authenticate"), /Bearer/);
  assert.equal(h.jobPayloads.length, 0);
});

test("create: 202 with Location, then the item is ready with a view", async () => {
  const { res, item } = await created(alice, { name: "Lighthouse" });
  assert.equal(item.status, "generating");
  assert.equal(res.headers.get("location"), `https://openapi.test/v1/items/${item.id}`);
  assert.equal(res.headers.get("retry-after"), "2");
  assert.equal(h.jobPayloads[0].v, 2, "a v2 job, reserved in-process");
  const job = (await h.db.doc(`generation-jobs/${h.jobPayloads[0].generationId}`).get()).data();
  assert.equal(job.envelope.client, "openapi");

  const ready = await conforms(await call("GET", `/items/${item.id}`, alice), "get_item");
  assert.equal(ready.status, "ready");
  assert.equal(ready.name, "Lighthouse");
  assert.equal(ready.language, "L0175");
  assert.equal(ready.view_url, `https://app.graffiticode.org/form/${item.id}`);
  assert.equal(ready.links.events, `https://openapi.test/v1/items/${item.id}/events`);
  assert.equal(ready.claim_url, undefined, "only free-plan items carry a claim link");
});

test("Prefer: wait long-polls a generating item until it's ready", async () => {
  h.setLlm(() => "```\n" + PROGRAM + "\n```", 1500);
  const res = await call("POST", "/items", alice, { language: "L0175", description: DESCRIPTION });
  const { id } = await res.json();
  const waited = await call("GET", `/items/${id}`, { ...alice, Prefer: "wait=10" });
  assert.equal(waited.headers.get("preference-applied"), "wait=10");
  assert.equal((await conforms(waited, "get_item")).status, "ready");
  const malformed = await call("GET", `/items/${id}`, { ...alice, Prefer: "wait=99" });
  assert.equal(malformed.headers.get("preference-applied"), null, "an out-of-range wait is ignored");
  await h.drainJobs();
});

test("revisions: 202, and a second while one runs is a 409 with Retry-After", async () => {
  const { item } = await created(alice);
  h.setLlm(() => "```\n" + PROGRAM.replace(/"[^"]*"/, '"Winter"') + "\n```", 800);
  const first = await call("POST", `/items/${item.id}/revisions`, alice, { modification: "Make it winter." });
  assert.equal((await conforms(first, "update_item")).status, "generating");
  const second = await call("POST", `/items/${item.id}/revisions`, alice, { modification: "Make it summer." });
  const p = await conforms(second, "update_item");
  assert.equal(second.status, 409);
  assert.equal(p.code, "generation_in_progress");
  assert.equal(second.headers.get("retry-after"), "5");
  await h.drainJobs();
  const versions = await conforms(await call("GET", `/items/${item.id}/revisions`, alice), "list_revisions");
  assert.equal(versions.data.length, 2);
});

test("requests that don't match the description are refused with pointers", async () => {
  const unknown = await call("POST", "/items", alice, { language: "L0175", description: DESCRIPTION, colour: "red" });
  const p = await conforms(unknown, "create_item");
  assert.equal(p.errors[0].pointer, "/body/colour");
  assert.equal((await conforms(await call("POST", "/items", alice, "not json"), "create_item")).code, "invalid_json");
  assert.equal((await call("POST", "/items", alice, { language: "spreadsheet", description: DESCRIPTION })).status, 400);
  const big = await call("POST", "/items", alice, { language: "L0175", description: "x".repeat(70_000) });
  assert.equal(big.status, 413);
  assert.equal(h.jobPayloads.length, 0);
});

test("list, rename, archive", async () => {
  const a = (await created(alice, { name: "First" })).item;
  const b = (await created(alice, { name: "Second" })).item;
  const page = await conforms(await call("GET", "/items?limit=1", alice), "list_items");
  assert.deepEqual(page.data.map((i: any) => i.id), [b.id], "newest first");
  const next = await conforms(await call("GET", `/items?limit=1&cursor=${page.next_cursor}`, alice), "list_items");
  assert.deepEqual(next.data.map((i: any) => i.id), [a.id]);
  assert.equal(next.next_cursor, null);
  assert.equal((await conforms(await call("GET", "/items?status=failed", alice), "list_items")).data.length, 0);

  const renamed = await conforms(await call("PATCH", `/items/${a.id}`, alice, { name: "Renamed" }), "rename_item");
  assert.equal(renamed.name, "Renamed");
  assert.equal((await call("PATCH", `/items/${a.id}`, alice, { name: "x", lang: "0180" })).status, 400);

  assert.equal((await call("DELETE", `/items/${a.id}`, alice)).status, 204);
  const after = await conforms(await call("GET", "/items", alice), "list_items");
  assert.deepEqual(after.data.map((i: any) => i.id), [b.id]);
  assert.equal((await call("GET", `/items/${a.id}`, alice)).status, 200, "an archived item's id keeps working");
});

test("src, data, spec, view and embed", async () => {
  const { item } = await created(alice);
  const src = await call("GET", `/items/${item.id}/src`, alice);
  assert.match(src.headers.get("content-type"), /^text\/plain/);
  assert.ok((await src.text()).length > 0);
  assert.equal((await conforms(await call("GET", `/items/${item.id}/data`, alice), "get_item_data")).compiled, true);
  const withSrc = await conforms(await call("GET", `/items/${item.id}?include=src,data`, alice), "get_item");
  assert.ok(withSrc.src && withSrc.data);

  const s = await call("GET", `/items/${item.id}/spec`, alice);
  const specBody = await conforms(s, "get_spec");
  assert.equal(s.status, 200, JSON.stringify(specBody));
  assert.equal(specBody.item_id, item.id);
  assert.equal(specBody.language, "L0175");
  assert.ok(specBody.spec.length > 0);

  const view = await call("GET", `/items/${item.id}/view`, alice);
  assert.equal(view.status, 303);
  assert.equal(view.headers.get("location"), `https://app.graffiticode.org/form/${item.id}`);
  const embed = await conforms(await call("GET", `/items/${item.id}/embed?maxwidth=640`, alice), "embed_item");
  assert.equal(embed.width, 640);
  assert.match(embed.html, new RegExp(`<iframe src="https://app.graffiticode.org/form/${item.id}"`));
});

test("not found, and another account's item", async () => {
  assert.equal((await conforms(await call("GET", "/items/nope", alice), "get_item")).code, "not_found");
  const { item } = await created(alice);
  const bob = { Authorization: `Bearer ${userToken("bob")}` };
  assert.equal((await call("GET", `/items/${item.id}`, bob)).status, 404);
  assert.equal((await call("POST", `/items/${item.id}/revisions`, bob, { modification: "Take it." })).status, 404);
});

test("free plan: a workspace token, claim links, and the workspace handle when it moves", async () => {
  const mine = await workspace("11111111-1111-4111-8111-111111111111");
  const { item } = await created(mine);
  const ready = await conforms(await call("GET", `/items/${item.id}`, mine), "get_item");
  assert.match(ready.view_url, /\?claim=/);
  assert.match(ready.claim_url, /^https:\/\/console\.graffiticode\.org\/claim\?token=.+&src=api$/);
  assert.equal((await conforms(await call("GET", `/items/${item.id}/revisions`, mine), "list_revisions")).code, "forbidden");

  // A second caller joins that workspace by naming the first item.
  const other = await workspace("22222222-2222-4222-8222-222222222222");
  const res = await call("POST", "/items", other, { language: "L0175", description: DESCRIPTION, source_item_id: item.id });
  assert.equal(res.status, 202);
  const handle = res.headers.get("graffiticode-workspace");
  assert.ok(handle, "the new workspace handle comes back");
  await h.drainJobs();
  const listed = await conforms(await call("GET", "/items", { "X-Graffiticode-Workspace": handle }), "list_items");
  assert.equal(listed.data.length, 2, "both items, in the joined workspace");
  assert.equal((await call("GET", "/items", { "X-Graffiticode-Workspace": "not.a.token" })).status, 401);
});

test("retry: a retryable failure starts again; anything else is a 409", async () => {
  const { item } = await created(alice);
  assert.equal((await conforms(await call("POST", `/items/${item.id}/retry`, alice), "retry_item")).code, "not_retryable");
  const { generationId } = h.jobPayloads.at(-1);
  await h.db.doc(`generation-jobs/${generationId}`).update({ "dispatch.state": "failed", "dispatch.failure": { code: "deadline_exceeded", retryable: true, message: "late" } });
  await h.db.doc(`users/alice/items/${item.id}`).update({ "generation.state": "failed", generationStatus: "failed", generationError: "late", taskId: null, code: null, billed: false });
  const failed = await conforms(await call("GET", `/items/${item.id}`, alice), "get_item");
  assert.deepEqual(failed.error, { message: "late", code: "deadline_exceeded", retryable: true });
  const res = await call("POST", `/items/${item.id}/retry`, alice);
  const retried = await conforms(res, "retry_item");
  assert.equal(retried.status, "generating", JSON.stringify(retried));
  await h.drainJobs();
  assert.equal((await (await call("GET", `/items/${item.id}`, alice)).json()).status, "ready");
});

test("events: progress, then ready, then the stream ends", async () => {
  h.setLlm(() => "```\n" + PROGRAM + "\n```", 1200);
  const { id } = await (await call("POST", "/items", alice, { language: "L0175", description: DESCRIPTION })).json();
  const res = await call("GET", `/items/${id}/events`, alice);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: progress/);
  assert.match(text, /event: ready\ndata: \{.*"status":"ready"/);
  await h.drainJobs();
});

test("deep health reports core readiness", async () => {
  const res = await app.request("http://x/health?deep=1");
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.effectiveProtocol, 2);
});

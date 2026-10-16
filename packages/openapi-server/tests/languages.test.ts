import { test } from "node:test";
import assert from "node:assert/strict";
import { conforms, fetched } from "./support.ts";
import { createApp } from "../src/app.ts";

const app = createApp();
const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://x/v1${path}`, { headers });

test("lists discoverable languages, paged with an opaque cursor", async () => {
  const first = await conforms(await get("/languages?limit=3"), "list_languages");
  assert.equal(first.data.length, 3);
  assert.ok(first.data.every((l: any) => /^L\d{4}$/.test(l.id)));
  assert.ok(!first.data.some((l: any) => ["L0000", "L0010", "L0171"].includes(l.id)), "internal and hidden languages stay out");
  assert.ok(first.next_cursor);
  const second = await conforms(await get(`/languages?limit=3&cursor=${first.next_cursor}`), "list_languages");
  assert.notDeepEqual(second.data.map((l: any) => l.id), first.data.map((l: any) => l.id));
});

test("filters by domain, and the whole catalog fits one default page", async () => {
  const all = await conforms(await get("/languages"), "list_languages");
  assert.equal(all.next_cursor, null);
  const domain = all.data.find((l: any) => l.domains.length)?.domains[0];
  const some = await conforms(await get(`/languages?domain=${domain}`), "list_languages");
  assert.ok(some.data.length > 0 && some.data.every((l: any) => l.domains.includes(domain)));
});

test("conditional GET answers 304 for an unchanged catalog", async () => {
  const res = await get("/languages");
  const etag = res.headers.get("etag")!;
  assert.match(res.headers.get("cache-control")!, /max-age=300/);
  const again = await get("/languages", { "If-None-Match": etag });
  assert.equal(again.status, 304);
});

test("rejects requests that don't match the description, with pointers", async () => {
  const res = await get("/languages?limit=500");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  const p = await conforms(res, "list_languages");
  assert.equal(p.code, "invalid_request");
  assert.equal(p.errors[0].pointer, "/query/limit");
  assert.equal((await get("/languages?cursor=!!")).status, 400);
  assert.equal((await get("/languages/abc")).status, 400);
  const badCursor = await (await get(`/languages?cursor=${Buffer.from("{}").toString("base64url")}`)).json();
  assert.equal(badCursor.code, "invalid_cursor");
});

test("a language: authoring envelope, what it's not for, and links", async () => {
  const info = await conforms(await get("/languages/0180"), "get_language_info");
  assert.equal(info.id, "L0180");
  assert.equal(info.authoring_guide, "Describe the questions.");
  assert.deepEqual(info.not_for, ["spreadsheets"]);
  assert.equal(info.guide_url, "https://openapi.test/v1/languages/L0180/guide");
  assert.equal(info.spec_url, "https://l0180.graffiticode.org/spec.html");
});

test("a language's guide is markdown; an unknown language or missing guide is a 404 problem", async () => {
  const guide = await get("/languages/L0180/guide");
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get("content-type")!, /^text\/markdown/);
  assert.match(await guide.text(), /# L0180 guide/);
  const missing = await conforms(await get("/languages/L9999"), "get_language_info");
  assert.equal(missing.code, "not_found");
  assert.equal((await get("/languages/L0184/guide")).status, 404);
});

test("reads go through the API gateway only", async () => {
  assert.ok(fetched.every(u => u.startsWith("http://api.test/") || /github/.test(u)), fetched.join("\n"));
});

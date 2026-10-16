import { test } from "node:test";
import assert from "node:assert/strict";
import { conforms } from "./support.ts";
import { createApp } from "../src/app.ts";

const app = createApp();
const get = (path: string) => app.request(`http://x${path}`);

test("skills: listed with links, each readable as markdown", async () => {
  const list = await conforms(await get("/v1/skills"), "list_skills");
  assert.deepEqual(list.data, [{ id: "graffiticode-render", name: "Rendering items", description: "How to show an item to the user.", url: "https://openapi.test/v1/skills/graffiticode-render" }]);
  const one = await get("/v1/skills/graffiticode-render");
  assert.match(one.headers.get("content-type")!, /^text\/markdown/);
  assert.match(await one.text(), /# Rendering/);
  assert.equal((await conforms(await get("/v1/skills/nope"), "get_skill")).code, "not_found");
});

test("the description is served with the public server URL, as JSON and YAML; docs render it", async () => {
  const json = await conforms(await get("/v1/openapi.json"), "get_openapi_json");
  assert.equal(json.openapi, "3.1.0");
  assert.deepEqual(json.servers, [{ url: "https://openapi.test/v1" }]);
  const yaml = await get("/v1/openapi.yaml");
  assert.match(await yaml.text(), /^openapi: 3\.1\.0/m);
  assert.match(await (await get("/v1/docs")).text(), /data-url="\.\/openapi\.json"/);
});

test("every operation in the description has a route", async () => {
  const json = await (await get("/v1/openapi.json")).json();
  for (const [path, item] of Object.entries<any>(json.paths)) {
    for (const method of Object.keys(item).filter(m => ["get", "post", "patch", "delete"].includes(m))) {
      const concrete = path.replace("{id}", "L0180");
      const res = await app.request(`http://x/v1${concrete}`, { method: method.toUpperCase() });
      const body = res.status === 404 ? await res.json().catch(() => ({})) : {};
      assert.notEqual(body.detail?.startsWith?.("No route"), true, `${method} ${path} has no route`);
    }
  }
});

test("health, CORS, request ids and unknown routes", async () => {
  assert.deepEqual(await (await get("/health")).json(), { status: "ok" });
  const deep = await get("/health?deep=1");
  assert.equal(deep.status, 200);
  assert.deepEqual((await deep.json()).checks, { catalog: "ok" });
  const pre = await app.request("http://x/v1/languages", { method: "OPTIONS", headers: { Origin: "https://a.example", "Access-Control-Request-Method": "GET" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const res = await app.request("http://x/v1/languages", { headers: { "X-Request-Id": "abc" } });
  assert.equal(res.headers.get("x-request-id"), "abc");
  const missing = await get("/v1/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "application/problem+json");
});

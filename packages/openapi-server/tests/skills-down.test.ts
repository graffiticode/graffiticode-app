// Its own file, so its own process: core's skills cache starts empty here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { conforms, routes } from "./support.ts";
import { createApp } from "../src/app.ts";

test("an unreachable skills catalog is a 503 problem with Retry-After", async () => {
  for (const re of [...routes.keys()]) if (/github/.test(String(re))) routes.delete(re);
  routes.set(/api\.github\.com/, () => new Response("rate limited", { status: 403 }));
  const app = createApp();
  const res = await app.request("http://x/v1/skills");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal((await conforms(res, "list_skills")).code, "unavailable");
});

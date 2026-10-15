// GRAFFITICODE_BACKEND=core must answer every console operation MCP sends
// exactly as the console's GraphQL endpoint does: same fields, same values.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { start, userToken, type Harness } from "./harness";
import { PROMPT, session } from "./helpers";

let h: Harness;
let api: any;
let tools: any;
let session0: any;
before(async () => {
  h = await start();
  process.env.GRAFFITICODE_CONSOLE_URL = `${h.consoleOrigin}/api`;
  process.env.GRAFFITICODE_API_URL = h.backendOrigin;
  api = await import("../../packages/mcp-server/src/api");
  tools = await import("../../packages/mcp-server/src/tools");
  session0 = await import("../../packages/mcp-server/src/session-token");
});
after(async () => { await h?.stop(); });
beforeEach(async () => { await h.resetFirestore(); });

const user = { type: "firebase", token: userToken("alice"), source: "raw" } as const;

async function both<T>(fn: () => Promise<T>): Promise<{ graphql: T; core: T }> {
  delete process.env.GRAFFITICODE_BACKEND;
  api.__resetCatalogForTest();
  const graphql = await fn();
  process.env.GRAFFITICODE_BACKEND = "core";
  api.__resetCatalogForTest();
  try {
    return { graphql, core: await fn() };
  } finally {
    delete process.env.GRAFFITICODE_BACKEND;
  }
}

async function readyItem(auth: any = user) {
  const c = await tools.handleToolCall({ auth, clientKind: "baseline" }, "create_item", { language: "L0175", description: PROMPT });
  await h.drainJobs();
  return c.item_id;
}

test("item, data and spec reads are identical", async () => {
  const id = await readyItem();
  const item = await both(() => api.getItemWithTask({ auth: user, id }));
  assert.deepEqual(item.core, item.graphql);
  assert.ok(item.graphql.task.src);
  const data = await both(() => api.getData({ auth: user, taskId: item.graphql.taskId }));
  assert.deepEqual(data.core, data.graphql);
  h.setLlm(() => "A passage about a lighthouse keeper.");
  const spec = await both(() => api.getSpec({ auth: user, id }));
  assert.deepEqual(spec.core, spec.graphql);
});

test("the language catalog and language info are identical", async () => {
  const all = await both(() => api.listLanguages({ auth: user }));
  assert.ok(all.graphql.length > 0);
  assert.deepEqual(all.core, all.graphql);
  const some = await both(() => api.listLanguages({ auth: user, search: "quiz" }));
  assert.deepEqual(some.core, some.graphql);
  const info = await both(() => api.getLanguageInfo({ auth: user, language: "L0175" }));
  assert.deepEqual(info.core, info.graphql);
});

test("a missing item reads as null in both", async () => {
  const r = await both(() => api.getItemWithTask({ auth: user, id: "no-such-item" }));
  assert.deepEqual(r, { graphql: null, core: null });
});

test("free-plan reads are identical", async () => {
  const token = await session0.mintSessionToken("44444444-4444-4444-8444-444444444444");
  const auth = { type: "freePlan", sessionId: token };
  const id = await readyItem(auth);
  const item = await both(() => api.getItemWithTask({ auth, id }));
  assert.deepEqual({ ...item.core, claimToken: "x" }, { ...item.graphql, claimToken: "x" });
  assert.ok(item.core.claimToken && item.graphql.claimToken);
});

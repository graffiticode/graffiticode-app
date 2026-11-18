// The item tools this server serves are exactly the ones the release's surface
// registry lists, which discovery advertises (core/src/surfaces.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { toolsForClient } from "../src/tools.js";
import { SURFACE_FAMILIES } from "@graffiticode-app/core/surfaces";

test("the served item tools are the registry's", () => {
  for (const [name, ui] of [["claude-ai", true], ["openai-mcp", false], ["some-editor", false]] as const) {
    assert.deepEqual(toolsForClient(name, ui).map(t => t.name).sort(), [...SURFACE_FAMILIES.items.tools].sort(), name);
  }
});

test("every route the server answers itself is reserved from service surfaces", async () => {
  const { readFileSync } = await import("node:fs");
  const { isReservedMcpPath } = await import("@graffiticode-app/core/surfaces");
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const exact = [...src.matchAll(/pathname === "([^"]+)"/g)].map(m => m[1]);
  const patterns = [...src.matchAll(/pathname\.match\(\/\^((?:\\\/|[a-z.-])+)/g)].map(m => m[1].replace(/\\\//g, "/"));
  assert.ok(exact.length > 10 && patterns.length >= 2, `found ${exact.length} routes and ${patterns.length} patterns`);
  for (const path of [...exact, ...patterns]) {
    if (path === "/mcp") continue; // the item tools' endpoint, refused by its own rule
    assert.ok(isReservedMcpPath(path), `${path} isn't reserved`);
  }
});

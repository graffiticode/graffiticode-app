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

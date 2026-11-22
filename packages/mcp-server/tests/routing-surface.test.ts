// The routing eval's surface (scripts/routing-surface.ts): the installation
// PROFILE_DIR selects is loaded before the instructions, tool descriptions and
// catalog are read, and cases are judged against what it offers.
//   - built-in (no PROFILE_DIR): the surface is the one the eval always
//     measured, and every case is judged as written;
//   - the Graffiticode profile (integration gate, GRAFFITICODE_PROFILE_DIR):
//     the same instructions and tool descriptions as built-in, every case
//     language offered;
//   - a restricted catalog (the committed example installation, restricted to
//     two languages): only those are inlined, the profile's copy is used, and a
//     case expecting another language is judged "not-offered".
// No network: the catalog is passed in.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { resetInstallation } from "../src/installation.js";
import {
  inlinedCatalogIds, judge, LEGACY_CREATE_ITEM_STUB, loadRoutingSurface, MAX_TURNS, planCase, routeOnce, type Outcome,
} from "../scripts/routing-surface.js";

const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
const GRAFFITICODE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;

// A catalog as the console serves it (raw ids), wider than any restriction.
const IDS = ["0159", "0166", "0171", "0173", "0175", "0176", "0177", "0178", "0179", "0180", "0181", "0182", "0183", "0184", "0186", "0187"];
const CATALOG = IDS.map((id) => ({ id, name: `L${id}`, description: `Language ${id}`, domains: [] })) as any[];
// The languages the eval's cases expect (scripts/eval-routing.ts, CASES).
const CASE_LANGUAGES = ["L0175", "L0176", "L0178", "L0179", "L0180", "L0181", "L0182", "L0183", "L0184", "L0186", "L0187"];

afterEach(() => resetInstallation());

function restrictedProfile(languages: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "routing-restricted-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.catalog = { ...(p.catalog ?? {}), languages };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}

test("built-in: the surface the eval always measured, every case judged as written", async () => {
  const s = await loadRoutingSurface({});
  const tools = await import("../src/tools.js");
  assert.equal(s.receipt, null);
  assert.deepEqual(s.discoveryTools.map((t) => [t.name, t.description]), [
    ["list_languages", tools.listLanguagesTool.description],
    ["get_language_info", tools.getLanguageInfoTool.description],
  ]);
  // create_item as the server serves it, not a short stub: a client is never sent the stub.
  const served = tools.toolsForClient().find((t) => t.name === "create_item")!;
  assert.equal(s.createItemTool.description, served.description);
  assert.ok(s.createItemTool.description.length > 1000, `${s.createItemTool.description.length} chars`);
  assert.notEqual(s.createItemTool.description, LEGACY_CREATE_ITEM_STUB.description);
  assert.equal(s.instructions(CATALOG), tools.buildServerInstructions(CATALOG));
  for (const id of CASE_LANGUAGES) {
    assert.deepEqual(planCase({ expect: id }, s), { kind: "as-written" }, id);
  }
});

test("restricted catalog: only the offered languages are inlined and expected, and the profile's copy is used", async () => {
  const builtIn = (await loadRoutingSurface({})).instructions(CATALOG);
  resetInstallation();
  const s = await loadRoutingSurface({ PROFILE_DIR: restrictedProfile(["0180", "0181"]) });
  assert.equal(s.receipt?.installationId, JSON.parse(readFileSync(join(EXAMPLE, "profile.json"), "utf8")).installation.id);
  const instructions = s.instructions(CATALOG);
  assert.deepEqual(inlinedCatalogIds(instructions), ["L0180", "L0181"]);
  assert.notEqual(instructions, builtIn, "the profile's instructions copy, not the built-in text");
  const { copy } = await import("../src/installation.js");
  assert.equal(s.createItemTool.description, copy("mcp.tool.create_item.description"), "the profile's served create_item");
  assert.equal(s.offered("L0180"), true);
  assert.equal(s.offered("0176"), false);
  assert.deepEqual(planCase({ expect: "L0176" }, s), { kind: "not-offered", language: "L0176" });
  assert.deepEqual(planCase({ expectReachable: "L0182" }, s), { kind: "not-offered", language: "L0182" });
  assert.deepEqual(planCase({ expect: "L0180" }, s), { kind: "as-written" });
  assert.deepEqual(planCase({ expectNot: ["L0176", "L0177"] }, s), { kind: "as-written" });
});

test("PROFILE_DIR set: the surface refuses to start from an invalid profile, never falling back to built-in", async () => {
  const dir = restrictedProfile(["0180"]);
  writeFileSync(join(dir, "profile.json"), "{");
  await assert.rejects(loadRoutingSurface({ PROFILE_DIR: dir }), /profile/i);
});

test("the Graffiticode profile: the built-in instructions and tool descriptions, every case language offered",
  { skip: !GRAFFITICODE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, async () => {
    const builtIn = await loadRoutingSurface({});
    const expected = {
      instructions: builtIn.instructions(CATALOG),
      tools: builtIn.discoveryTools.map((t) => [t.name, t.description]),
      create: builtIn.createItemTool.description,
    };
    resetInstallation();
    const s = await loadRoutingSurface({ PROFILE_DIR: GRAFFITICODE! });
    assert.equal(s.receipt?.installationId, "graffiticode");
    assert.equal(s.instructions(CATALOG), expected.instructions);
    assert.deepEqual(s.discoveryTools.map((t) => [t.name, t.description]), expected.tools);
    assert.equal(s.createItemTool.description, expected.create, "the same served create_item in both modes");
    for (const id of CASE_LANGUAGES) {
      assert.deepEqual(planCase({ expect: id }, s), { kind: "as-written" }, id);
    }
  });

// --- The model loop and its judgment, with a scripted client: no network, no model. ---------

const toolUse = (name: string, input: Record<string, unknown>, id = `t-${name}`) => ({ type: "tool_use", id, name, input });
function scripted(turns: Array<Array<Record<string, unknown>>>) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    messages: { create: async (req: any) => { requests.push(req); return { content: turns[Math.min(i++, turns.length - 1)] } as any; } },
  };
}
const fakeSurface = {
  discoveryTools: [
    { name: "list_languages", description: "list", input_schema: { type: "object" } },
    { name: "get_language_info", description: "info", input_schema: { type: "object" } },
  ],
  createItemTool: { name: "create_item", description: "served create_item", input_schema: { type: "object" } },
  handleListLanguages: async () => ({ languages: [] }),
  handleGetLanguageInfo: async () => ({}),
};
const run = (client: any, legacyCreateStub = false) =>
  routeOnce(client, { prompt: "p", system: "s", model: "m", surface: fakeSurface as any, ctx: {} as any, legacyCreateStub });

test("a run that never decides within the turn budget is 'exhausted', not a decline", async () => {
  const client = scripted([[toolUse("list_languages", {})]]);
  const outcome = await run(client);
  assert.deepEqual(outcome, { kind: "exhausted", discovery: MAX_TURNS });
  assert.equal(client.requests.length, MAX_TURNS);
});

test("the loop's decisions: create, ask, and a text-only decline", async () => {
  assert.deepEqual(await run(scripted([[toolUse("list_languages", {})], [toolUse("create_item", { language: "180" })]])), { kind: "create", language: "L0180", discovery: 1 });
  assert.deepEqual(await run(scripted([[toolUse("ask_user", { question: "Which?" })]])), { kind: "ask", question: "Which?", discovery: 0 });
  assert.deepEqual(await run(scripted([[{ type: "text", text: "Nothing here fits." }]])), { kind: "none", text: "Nothing here fits.", discovery: 0 });
});

test("the model is offered the served create_item; the legacy stub only on request", async () => {
  const served = scripted([[toolUse("ask_user", { question: "q" })]]);
  await run(served);
  assert.equal(served.requests[0].tools.find((t: any) => t.name === "create_item").description, "served create_item");
  const legacy = scripted([[toolUse("ask_user", { question: "q" })]]);
  await run(legacy, true);
  assert.equal(legacy.requests[0].tools.find((t: any) => t.name === "create_item").description, LEGACY_CREATE_ITEM_STUB.description);
});

test("judging: an exhausted run fails every kind of case; asking or declining passes a not-offered one", () => {
  const exhausted: Outcome = { kind: "exhausted", discovery: MAX_TURNS };
  const asked: Outcome = { kind: "ask", question: "q", discovery: 0 };
  const declined: Outcome = { kind: "none", text: "no fit", discovery: 0 };
  const created = (language: string): Outcome => ({ kind: "create", language, discovery: 0 });
  const notOffered = { kind: "not-offered", language: "L0176" } as const;
  const asWritten = { kind: "as-written" } as const;
  const c = { prompt: "p" };

  assert.equal(judge(c, notOffered, [asked, declined, asked]).ok, true);
  assert.equal(judge(c, notOffered, [asked, exhausted, asked]).ok, false, "exhausted fails not-offered");
  assert.equal(judge(c, notOffered, [asked, created("L0180"), asked]).ok, false, "settling for another language fails");
  assert.equal(judge({ ...c, expect: "L0180" }, asWritten, [created("L0180"), exhausted]).ok, false);
  assert.equal(judge({ ...c, expectReachable: "L0180" }, asWritten, [asked, exhausted]).ok, false);
  assert.equal(judge({ ...c, expectReachable: "L0180" }, asWritten, [asked, created("L0180")]).ok, true);
  assert.equal(judge({ ...c, expectNot: ["L0176"] }, asWritten, [declined, exhausted]).ok, false, "exhausted fails expectNot");
  assert.equal(judge({ ...c, expectNot: ["L0176"] }, asWritten, [declined, asked, created("L0180")]).ok, true);
});

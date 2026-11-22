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
  evidenceLines, inlinedCatalogIds, judge, LEGACY_CREATE_ITEM_STUB, loadRoutingSurface, MAX_TURNS, planCase, replyClassifier, routeOnce, type Outcome,
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
  for (const t of s.workflowTools) {
    assert.equal(t.description, tools.toolsForClient().find((x) => x.name === t.name)!.description, t.name);
  }
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
    // Each request is recorded with a copy of its messages, as they were when sent.
    messages: { create: async (req: any) => { requests.push({ ...req, messages: structuredClone(req.messages) }); return { content: turns[Math.min(i++, turns.length - 1)] } as any; } },
  };
}
const fakeSurface = {
  discoveryTools: [
    { name: "list_languages", description: "list", input_schema: { type: "object" } },
    { name: "get_language_info", description: "info", input_schema: { type: "object" } },
  ],
  createItemTool: { name: "create_item", description: "served create_item", input_schema: { type: "object" } },
  workflowTools: [
    { name: "render_item", description: "render", input_schema: { type: "object" } },
    { name: "update_item", description: "update", input_schema: { type: "object" } },
  ],
  handleListLanguages: async () => ({ languages: [] }),
  handleGetLanguageInfo: async () => ({}),
};
const SURVEY = { item_id: "svy-1", status: "ready" as const, language: "L0182", name: "Office", summary: "Survey: ideas\n- standing desks\n- quiet room" };
const run = (client: any, opts: Record<string, unknown> = {}) =>
  routeOnce(client, { prompt: "p", system: "s", model: "m", surface: fakeSurface as any, ctx: {} as any, ...opts });
const text = (t: string) => ({ type: "text", text: t });

test("a run that never decides within the turn budget is 'exhausted', not a decline", async () => {
  const client = scripted([[toolUse("list_languages", {})]]);
  const outcome = await run(client);
  assert.deepEqual(outcome, { kind: "exhausted", discovery: MAX_TURNS, replies: [] });
  assert.equal(client.requests.length, MAX_TURNS);
});

test("the loop's decisions: create, ask, and a text reply with the classifier's verdict on the whole of it", async () => {
  assert.deepEqual(await run(scripted([[toolUse("list_languages", {})], [toolUse("create_item", { language: "180" })]])), { kind: "create", language: "L0180", discovery: 1, replies: [] });
  assert.deepEqual(await run(scripted([[toolUse("ask_user", { question: "Which?" })]])), { kind: "ask", question: "Which?", discovery: 0, replies: [] });
  const seen: any[] = [];
  const reply = "Here is your quiz:\n1. What do plants absorb? A) CO2 B) O2\n2. Which pigment is green?";
  const out = await run(scripted([[text(reply)]]), { prompt: "a quiz", classifyReply: async (a: any) => { seen.push(a); return "content"; } });
  assert.deepEqual(out, { kind: "none", text: reply, reply: "content", discovery: 0, replies: [{ text: reply, reply: "content" }] });
  assert.deepEqual(seen, [{ request: "a quiz", reply }], "the classifier reads the request and the WHOLE reply");
});

test("the model is offered the served tools; the legacy create stub only on request", async () => {
  const served = scripted([[toolUse("ask_user", { question: "q" })]]);
  await run(served);
  const names = served.requests[0].tools.map((t: any) => t.name);
  assert.deepEqual(names, ["list_languages", "get_language_info", "create_item", "render_item", "update_item", "ask_user"]);
  assert.equal(served.requests[0].tools.find((t: any) => t.name === "create_item").description, "served create_item");
  const legacy = scripted([[toolUse("ask_user", { question: "q" })]]);
  await run(legacy, { legacyCreateStub: true });
  assert.equal(legacy.requests[0].tools.find((t: any) => t.name === "create_item").description, LEGACY_CREATE_ITEM_STUB.description);
});

test("the survey workflow: render_item serves the referenced item, update_item records the response", async () => {
  const client = scripted([
    [toolUse("render_item", { item_id: "svy-1" })],
    [toolUse("update_item", { item_id: "svy-1", modification: "Rank: standing desks, quiet room" })],
  ]);
  const out = await run(client, { items: { "svy-1": SURVEY } });
  assert.deepEqual(out, { kind: "update", itemId: "svy-1", modification: "Rank: standing desks, quiet room", rendered: ["svy-1"], discovery: 0, replies: [] });
  const served = JSON.parse(client.requests[1].messages.at(-1).content[0].content);
  assert.deepEqual(served, SURVEY, "render_item answered with the fixture");
  const missing = scripted([[toolUse("render_item", { item_id: "nope" })], [toolUse("ask_user", { question: "Which survey?" })]]);
  await run(missing, { items: { "svy-1": SURVEY } });
  assert.match(missing.requests[1].messages.at(-1).content[0].content, /Item not found: nope/);
  // A failed render is not a read: rendering a missing item, then updating it, records no render.
  const blind = scripted([[toolUse("render_item", { item_id: "svy-9" })], [toolUse("update_item", { item_id: "svy-9", modification: "standing desks, quiet room" })]]);
  const blindOut = await run(blind, { items: { "svy-1": SURVEY } });
  assert.deepEqual(blindOut.kind === "update" && blindOut.rendered, []);
  const blindCase = { prompt: "p", expectUpdate: { itemId: "svy-9", mentions: ["standing desks"] } };
  assert.equal(judge(blindCase, { kind: "as-written" }, [blindOut]).ok, false);
});

test("clarify, then create: a clarifying text reply gets the fixed answer, and the decision after it is marked", async () => {
  const followUp = "Line items: design, 12 hours at $95.";
  const client = scripted([[text("What line items and amounts should it have?")], [toolUse("create_item", { language: "L0179" })]]);
  const out = await run(client, { followUp, classifyReply: async () => "clarify" });
  // The clarification the run continued past stays in the evidence, with its verdict.
  assert.deepEqual(out, {
    kind: "create", language: "L0179", discovery: 0, afterClarification: true,
    replies: [{ text: "What line items and amounts should it have?", reply: "clarify" }],
    clarification: { via: "text", question: "What line items and amounts should it have?", followUp },
  });
  assert.deepEqual(client.requests[1].messages.slice(-1), [{ role: "user", content: followUp }]);
  // ask_user gets the same answer, as its tool result.
  const viaTool = scripted([[toolUse("ask_user", { question: "Which items?" })], [toolUse("create_item", { language: "L0179" })]]);
  // An ask_user question the run continued past is kept, with the answer it got.
  assert.deepEqual(await run(viaTool, { followUp }), {
    kind: "create", language: "L0179", discovery: 0, afterClarification: true, replies: [],
    clarification: { via: "ask_user", question: "Which items?", followUp },
  });
  assert.equal(viaTool.requests[1].messages.at(-1).content[0].content, followUp);
  // Content in the chat is not a clarification: no follow-up, the run ends.
  const wrote = scripted([[text("INVOICE\\nDesign 12 x $95 = $1,140")]]);
  assert.deepEqual(await run(wrote, { followUp, classifyReply: async () => "content" }), { kind: "none", text: "INVOICE\\nDesign 12 x $95 = $1,140", reply: "content", discovery: 0, replies: [{ text: "INVOICE\\nDesign 12 x $95 = $1,140", reply: "content" }] });
  assert.equal(wrote.requests.length, 1);
});

test("judging", () => {
  const exhausted: Outcome = { kind: "exhausted", discovery: MAX_TURNS, replies: [] };
  const asked: Outcome = { kind: "ask", question: "q", discovery: 0, replies: [] };
  const said = (reply?: "clarify" | "decline" | "content" | "other"): Outcome => ({ kind: "none", text: "t", reply, discovery: 0, replies: [{ text: "t", ...(reply ? { reply } : {}) }] });
  const created = (language: string, afterClarification?: boolean): Outcome => ({ kind: "create", language, discovery: 0, replies: [], ...(afterClarification ? { afterClarification } : {}) });
  const updated = (itemId: string, modification: string, rendered = [itemId]): Outcome => ({ kind: "update", itemId, modification, rendered, discovery: 0, replies: [] });
  const notOffered = { kind: "not-offered", language: "L0176" } as const;
  const asWritten = { kind: "as-written" } as const;
  const c = { prompt: "p" };

  // not-offered: clarifying or declining passes; anything else fails.
  assert.equal(judge(c, notOffered, [asked, said("decline"), said("clarify")]).ok, true);
  for (const bad of [exhausted, created("L0180"), said("content"), said(undefined)]) {
    assert.equal(judge(c, notOffered, [asked, bad]).ok, false, JSON.stringify(bad));
  }
  // expect / expectReachable.
  assert.equal(judge({ ...c, expect: "L0180" }, asWritten, [created("L0180"), exhausted]).ok, false);
  assert.equal(judge({ ...c, expectReachable: "L0180" }, asWritten, [asked, said("clarify"), created("L0180")]).ok, true);
  assert.equal(judge({ ...c, expectReachable: "L0180" }, asWritten, [asked, said("content")]).ok, false, "a quiz written in the chat is not a clarification, whatever its question marks");
  assert.equal(judge({ ...c, expectReachable: "L0180" }, asWritten, [asked, exhausted]).ok, false);
  // expectNot.
  assert.equal(judge({ ...c, expectNot: ["L0176"] }, asWritten, [said("decline"), exhausted]).ok, false);
  assert.equal(judge({ ...c, expectNot: ["L0176"] }, asWritten, [said("decline"), asked, created("L0180")]).ok, true);
  // Clarify, then create.
  const invoice = { ...c, expect: "L0179", followUp: "items" };
  assert.equal(judge(invoice, asWritten, [created("L0179", true), created("L0179", true)]).ok, true);
  assert.equal(judge(invoice, asWritten, [created("L0179", true), created("L0179")]).ok, false, "creating without clarifying fails");
  assert.equal(judge(invoice, asWritten, [created("L0179", true), said("clarify")]).ok, false);
  // The survey workflow.
  const survey = { ...c, expectUpdate: { itemId: "svy-1", mentions: ["standing desks", "quiet room"] } };
  assert.equal(judge(survey, asWritten, [updated("svy-1", "1. Standing desks 2. Quiet room")]).ok, true);
  assert.equal(judge(survey, asWritten, [updated("svy-1", "standing desks", ["svy-1"])]).ok, false, "every chosen idea is named");
  assert.equal(judge(survey, asWritten, [updated("svy-1", "standing desks, quiet room", [])]).ok, false, "rendered first");
  assert.equal(judge(survey, asWritten, [updated("svy-2", "standing desks, quiet room", ["svy-2"])]).ok, false, "the referenced item");
  assert.equal(judge(survey, asWritten, [said("clarify")]).ok, false);
  // An existing item stays revisable whatever the installation offers: judged as written.
  assert.equal(planCase(survey, { receipt: {} as any, offered: () => false }).kind, "as-written");
  // Content written into the chat fails every kind of case, beside tool calls too.
  assert.equal(judge({ ...c, expectNot: ["L0176"] }, asWritten, [said("content")]).ok, false, "expectNot: an explicit content verdict fails");
  const contentThenCreate: Outcome = { ...created("L0179", true), replies: [{ text: "INVOICE ... Total $1,140", reply: "content" }] };
  assert.equal(judge(invoice, asWritten, [contentThenCreate]).ok, false, "an invented invoice beside ask_user, then create, fails");
});

test("the reply classifier sends the whole reply and returns a structured verdict", async () => {
  const requests: any[] = [];
  const client = { messages: { parse: async (req: any) => { requests.push(req); return { parsed_output: { kind: "clarify" } }; } } };
  const reply = "Before I build it: which grade, and how many questions?\nAlso, multiple choice only?";
  assert.equal(await replyClassifier(client)({ request: "a quiz", reply }), "clarify");
  assert.equal(requests[0].model, "claude-haiku-5-5");
  assert.ok(requests[0].messages[0].content.includes(reply), "the full reply, not an excerpt");
  assert.equal(requests[0].output_config.format.type, "json_schema");
  assert.deepEqual(requests[0].output_config.format.schema.required, ["kind"]);
  for (const parsed_output of [null, {}, { kind: "maybe" }]) {
    const bad = { messages: { parse: async () => ({ parsed_output }) } };
    await assert.rejects(replyClassifier(bad)({ request: "r", reply: "x" }), /no valid verdict/, JSON.stringify(parsed_output));
  }
});

test("text beside a tool call is classified too, and content there fails the case", async () => {
  const verdicts: string[] = [];
  const classifyReply = async ({ reply }: any) => { verdicts.push(reply); return reply.startsWith("INVOICE") ? "content" as const : "other" as const; };
  // An invented invoice in the chat, with ask_user beside it, then a create.
  const client = scripted([
    [text("INVOICE\nDesign 12 x $95 = $1,140\nTotal $1,140"), toolUse("ask_user", { question: "Is this right?" })],
    [toolUse("create_item", { language: "L0179" })],
  ]);
  const out = await run(client, { followUp: "Line items: design, 12 hours at $95.", classifyReply });
  assert.equal(out.kind, "create");
  assert.deepEqual(out.replies, [{ text: "INVOICE\nDesign 12 x $95 = $1,140\nTotal $1,140", reply: "content" }]);
  assert.deepEqual(out.clarification, { via: "ask_user", question: "Is this right?", followUp: "Line items: design, 12 hours at $95." });
  assert.deepEqual(verdicts, ["INVOICE\nDesign 12 x $95 = $1,140\nTotal $1,140"]);
  const invoice = { prompt: "Create an invoice", expect: "L0179", followUp: "items" };
  assert.equal(judge(invoice, { kind: "as-written" }, [out]).ok, false);
  // A short preamble beside a tool call is evidence, not a failure.
  const preamble = scripted([[text("Let me build that."), toolUse("create_item", { language: "L0180" })]]);
  const ok = await run(preamble, { classifyReply });
  assert.deepEqual(ok.replies, [{ text: "Let me build that.", reply: "other" }]);
  assert.equal(judge({ prompt: "p", expectReachable: "L0180" }, { kind: "as-written" }, [ok]).ok, true);
});

test("verbose evidence shows a continued ask_user question and the follow-up it got", async () => {
  const followUp = "Line items: design, 12 hours at $95.";
  const viaTool = await run(scripted([[toolUse("ask_user", { question: "Which line items?" })], [toolUse("create_item", { language: "L0179" })]]), { followUp });
  const viaText = await run(scripted([[text("What amounts?")], [toolUse("create_item", { language: "L0179" })]]), { followUp, classifyReply: async () => "clarify" });
  assert.deepEqual(evidenceLines([viaTool, viaText]), [
    "        run 1 CLARIFIED (ask_user): Which line items?",
    `        run 1 FOLLOW-UP: ${followUp}`,
    "        run 2 SAID (clarify): What amounts?",
    "        run 2 CLARIFIED (text): What amounts?",
    `        run 2 FOLLOW-UP: ${followUp}`,
  ]);
});

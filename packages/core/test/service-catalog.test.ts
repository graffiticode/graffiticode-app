// Services from the installation's profile, and everything derived from them
// (installations plan, P4): the registry's facts come from the capability
// registry in code; tools, descriptions, pinned definitions and A2A
// declarations come from the same validated definitions.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstallation, resetInstallation } from "../src/profile/runtime.js";
import { loadProfile } from "../src/profile/load.js";
import { availableSkills, definitionFromProfile, listServices, serviceDefinition, skillAvailable, skillRefusal } from "../src/service-registry.js";
import { a2aDeclaration, pinSkill, serviceTools } from "../src/service-catalog.js";
import { withdrawnCapabilities } from "../src/capabilities.js";

const SERVICES = new URL("./fixtures/installation-services", import.meta.url).pathname;
const ENV = { GOOGLE_CLOUD_PROJECT: "example-installation" } as any;
afterEach(() => resetInstallation());

function variant(edit: (p: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(SERVICES, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  edit(p);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}
const install = (dir = SERVICES) => loadInstallation({ ...ENV, PROFILE_DIR: dir });
const authoring = () => serviceDefinition("learnosity-assessment-authoring")!;
const NONE = new Set<string>();

test("services come from the installation's profile; without one there are none", () => {
  assert.deepEqual(listServices(), []);
  install();
  assert.deepEqual(listServices().map(s => s.serviceId), ["learnosity-assessment-authoring", "learnosity-data-operations"]);
  const skill = authoring().skills[0];
  // Facts from the capability (code), never from the profile.
  assert.deepEqual({ implemented: skill.implemented, externalWrites: skill.externalWrites, requiresExecution: skill.requiresExecution, authorization: skill.authorization },
    { implemented: true, externalWrites: false, requiresExecution: false, authorization: "account" });
});

test("availability: an implemented capability, ready dependencies, the operator's switch and the caller", () => {
  install();
  const def = authoring();
  assert.equal(skillAvailable(def, "author_content", { withdrawn: NONE }), true);
  assert.equal(skillAvailable(def, "no_such_skill"), false);
  assert.equal(skillAvailable(def, "author_content", { withdrawn: NONE, authorized: false }), false);
  assert.match(skillRefusal(def, "author_content", { withdrawn: new Set(["generate-content"]) })!, /withdrawn/);
  // A skill selecting an unimplemented, writing capability (the validator
  // refuses such a profile; the registry never relies on that).
  const saving = definitionFromProfile({
    serviceId: "s", version: 1, name: "S", responsibility: "R.", limits: { deadlineMs: 60000, retryWindowMs: 0, maxGenerationAttempts: 1 },
    skills: [{ skillId: "save_revision", name: "Save", description: "Save.", capability: "save-revision", deliverableKind: "content", deliveryStates: ["saved"], languages: ["0176"] }],
  });
  assert.equal(saving.skills[0].externalWrites, true);
  assert.equal(skillAvailable(saving, "save_revision", { withdrawn: NONE }), false);
  assert.equal(skillAvailable(saving, "save_revision", { withdrawn: NONE, executionReady: true }), false, "still not implemented");
  assert.deepEqual(withdrawnCapabilities({ CAPABILITIES_WITHDRAWN: " generate-content, save-revision " } as any), new Set(["generate-content", "save-revision"]));
});

test("no available skill writes externally in this release", () => {
  install();
  for (const def of listServices()) for (const s of availableSkills(def, { withdrawn: NONE })) assert.equal(s.externalWrites, false, s.skillId);
});

test("a pinned definition: the skill, its capability's facts and the service limits, with a stable digest", () => {
  install();
  const a = pinSkill(authoring(), "author_content")!;
  const b = pinSkill(authoring(), "author_content")!;
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(a.definition.capability.id, "generate-content");
  assert.equal(a.definition.limits.deadlineMs, 45 * 60_000);
  assert.deepEqual(a.definition.skill.languages, ["0176"]);
  resetInstallation();
  install(variant(p => { p.services[0].skills[0].languages = ["0180"]; }));
  assert.notEqual(pinSkill(authoring(), "author_content")!.digest, a.digest, "a changed definition is a different pin");
});

test("tools are generated from the definitions: names from the profile, schemas from the capability", () => {
  install();
  const tools = serviceTools(listServices(), "Example", { withdrawn: NONE });
  assert.deepEqual(tools.map(t => t.name), ["assessment_create_item", "assessment_update_item", "authoring_integration_plan", "data_plan", "job_get", "job_cancel"]);
  const create = tools[0], revise = tools[1];
  assert.deepEqual(create.target, { serviceId: "learnosity-assessment-authoring", skillId: "author_content", operation: "create" });
  assert.deepEqual(Object.keys((create.inputSchema as any).properties), ["description", "idempotency_key"]);
  assert.deepEqual((revise.inputSchema as any).required, ["item_id", "modification"]);
  assert.match(create.description, /^Create or revise Learnosity questions/);
  assert.match(create.description, /Never writes outside Example\./);
  assert.equal(create.annotations.destructiveHint, false);
  assert.equal(tools.at(-1)!.target, undefined);
});

test("a deselected or withdrawn skill has no tool; the job tools are always there", () => {
  install(variant(p => { p.services[0].skills = p.services[0].skills.filter((k: any) => k.skillId !== "author_content"); }));
  const names = serviceTools(listServices(), "Example", { withdrawn: NONE }).map(t => t.name);
  assert.ok(!names.includes("assessment_create_item"));
  assert.ok(names.includes("job_get") && names.includes("job_cancel"));
  resetInstallation();
  install();
  assert.deepEqual(serviceTools(listServices(), "Example", { withdrawn: new Set(["generate-content"]) }).map(t => t.name), ["job_get", "job_cancel"]);
});

test("A2A declarations come from the same definitions as the tools", () => {
  install();
  const decl = listServices().map(d => a2aDeclaration(d, { withdrawn: NONE }));
  const skillsWithTools = new Set(serviceTools(listServices(), "Example", { withdrawn: NONE }).filter(t => t.target).map(t => t.target!.skillId));
  assert.deepEqual(new Set(decl.flatMap(d => d.skills.map(s => s.id))), skillsWithTools);
  assert.deepEqual(decl[0].skills[0], {
    id: "author_content",
    name: "Author assessment content",
    description: authoring().skills[0].description,
    tags: ["learnosity-assessment-authoring", "content"],
    examples: ["Five multiple-choice questions on photosynthesis for grade 7, with feedback."],
    inputModes: ["text/plain"],
    outputModes: ["application/json"],
  });
  assert.equal(decl[0].description, authoring().responsibility);
});

test("the validator refuses tool names that collide or take a job tool's, and service tools on the item path", () => {
  const problems = (edit: (p: any) => void) => { try { loadProfile(variant(edit)); return ""; } catch (e) { return String((e as Error).message) + JSON.stringify((e as any).problems ?? []); } };
  assert.match(problems(p => { p.services[0].skills[0].tools[0].name = "job_get"; }), /tool name job_get is reserved/);
  assert.match(problems(p => { p.services[1].skills[0].tools[0].name = "assessment_create_item"; }), /tool name assessment_create_item is used by both/);
  assert.match(problems(p => { p.services[0].skills[0].tools[1].operation = "create"; }), /an operation is exposed twice/);
  assert.match(problems(p => { p.surfaces.mcp = [{ path: "/mcp", families: ["items", "services"] }]; }), /service tools at a path of their own/);
  assert.match(problems(p => { p.services[0].skills[0].skillId = "author_l0176"; }), /skillId/, "public skill ids never encode a language number");
  assert.equal(problems(() => {}), "", "the fixture itself is valid");
});

test("a service surface can't take one of the MCP server's own routes", () => {
  const problems = (path: string) => { try { loadProfile(variant(p => { p.surfaces.mcp[1].path = path; })); return ""; } catch (e) { return JSON.stringify((e as any).problems ?? []); } };
  for (const path of ["/about", "/privacy", "/health", "/", "/oauth/token", "/oauth", "/widget/x"]) {
    assert.match(problems(path), /one of the server's own routes/, path);
  }
  // A path with a dot (the discovery files under /.well-known) fails the path pattern first.
  assert.notEqual(problems("/.well-known/agent.json"), "");
  assert.equal(problems("/assessments/mcp"), "");
});

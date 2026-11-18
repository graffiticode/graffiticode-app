// Discovery files (installations plan, P2, discovery): generated from the
// validated profile and what this release serves. The example installation
// always runs; the Graffiticode parity check is an integration gate
// (GRAFFITICODE_PROFILE_DIR). The committed Graffiticode files are guarded
// against drift from the runtime catalog either way.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discovery } from "../src/profile/cli.js";
import { resetInstallation } from "../src/profile/runtime.js";
import { SURFACE_FAMILIES } from "../src/surfaces.js";

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
const PACKAGES = new URL("../../", import.meta.url).pathname;
afterEach(() => resetInstallation());

const out = () => mkdtempSync(join(tmpdir(), "discovery-"));
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
function variant(edit: (p: any, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  edit(p, dir);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}

test("the example installation's three files agree on its brand, endpoint and tools", async () => {
  const o = out();
  const receipt = await discovery(EXAMPLE, o, { APP_VERSION: "rel-1", PROFILE_REF: "v1" } as any);
  const tools = [...SURFACE_FAMILIES.items.tools];
  const llms = read(o, "app/llms.txt");
  assert.equal(llms, `# Example — the Example viewer\n\nItems are made through the Example MCP server:\n\n  https://mcp.example.test/mcp\n\nMCP tools available: ${tools.join(", ")}.\n`);
  const mcp = JSON.parse(read(o, "app/.well-known/mcp.json"));
  assert.deepEqual(mcp, {
    mcp_endpoint: "https://mcp.example.test/mcp",
    site: "https://app.example.test",
    description: "The Example viewer renders items made through its MCP server.",
    tools,
    product_url: "https://example.test",
    console_url: "https://console.example.test",
    forum_url: "https://forum.example.test",
    github_url: "https://example.test/source",
  });
  const meta = JSON.parse(read(o, "skills/plugin.meta.json"));
  assert.equal(meta.name, "app-example");
  assert.deepEqual(meta.mcpServers, { example: { type: "streamable-http", url: "https://mcp.example.test/mcp" } });
  assert.deepEqual(meta.interface.defaultPrompt, ["Make a quiz on fractions.", "Make a flashcard deck on planets."]);
  assert.equal(meta.interface.privacyPolicyURL, "https://mcp.example.test/privacy");
  assert.ok(readFileSync(join(o, "skills/assets/icon.png")).equals(readFileSync(join(EXAMPLE, "assets/icon.png"))), "the listing's icon is the installation's");
  // The receipt records the release, the profile and every file.
  assert.equal(receipt.appVersion, "rel-1");
  assert.equal(receipt.profileRef, "v1");
  assert.match(receipt.profileDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(read(o, "discovery-receipt.json")).files, receipt.files);
  assert.deepEqual(Object.keys(receipt.files).sort(), ["app/.well-known/mcp.json", "app/llms.txt", "skills/assets/icon.png", "skills/plugin.meta.json"]);
  assert.deepEqual(receipt.advertisedFamilies, ["items"]);
  assert.deepEqual(receipt.omittedFamilies, []);
  assert.ok(receipt.languages.includes("L0180"));
});

test("a family these files don't describe is advertised nowhere in them, and reported", async () => {
  const dir = variant(p => {
    p.services = [{ serviceId: "authoring", version: 1, name: "Authoring", responsibility: "Author content.",
      limits: { deadlineMs: 60000, retryWindowMs: 0, maxGenerationAttempts: 1 },
      skills: [{ skillId: "author_content", name: "Author", description: "Author.", capability: "generate-content", deliverableKind: "content", deliveryStates: ["prepared"], languages: ["0180"] }] }];
    p.surfaces.mcp.push({ path: "/services/mcp", families: ["services"] });
  });
  const o = out();
  const receipt = await discovery(dir, o, {} as any);
  assert.deepEqual(receipt.omittedFamilies, [{ family: "services", reason: "served at /services/mcp; these files describe the item endpoint only" }]);
  assert.deepEqual(JSON.parse(read(o, "app/.well-known/mcp.json")).tools, [...SURFACE_FAMILIES.items.tools]);
  assert.doesNotMatch(read(o, "app/llms.txt") + read(o, "skills/plugin.meta.json"), /services\/mcp|author_content/);
});

test("copy naming a vendor the installation doesn't offer is refused", async () => {
  const dir = variant((p, d) => {
    p.catalog = { languages: ["0180"] };
    writeFileSync(join(d, "copy/listing-long-description.md"), "Example also authors Learnosity items.\n");
  });
  await assert.rejects(discovery(dir, out(), {} as any), /copy listing\.longDescription names learnosity, which this installation doesn't offer/);
});

test("a missing discovery copy key is refused before anything is written", async () => {
  const dir = variant(p => { delete p.copy["discovery.app.description"]; });
  const o = out();
  await assert.rejects(discovery(dir, o, {} as any), /copy discovery\.app\.description is required/);
  assert.equal(existsSync(join(o, "discovery-receipt.json")), false);
});

test("the committed Graffiticode files agree with the runtime catalog", () => {
  const mcp = JSON.parse(readFileSync(join(PACKAGES, "app/public/.well-known/mcp.json"), "utf8"));
  assert.deepEqual(mcp.tools, [...SURFACE_FAMILIES.items.tools]);
  assert.match(readFileSync(join(PACKAGES, "app/public/llms.txt"), "utf8"), new RegExp(`MCP tools available: ${SURFACE_FAMILIES.items.tools.join(", ")}\\.`));
});

test("generated from the Graffiticode profile, the files are the committed ones", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, async () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  const o = out();
  await discovery(PROFILE!, o, {} as any);
  // The agent-app listing is byte-identical (it backs a submitted build).
  assert.equal(read(o, "skills/plugin.meta.json"), readFileSync(join(PACKAGES, "skills/plugin.meta.json"), "utf8"));
  assert.ok(readFileSync(join(o, "skills/assets/icon.png")).equals(readFileSync(join(PACKAGES, "skills/assets/icon.png"))));
  // The app files are the committed ones, which carry the recorded correction
  // (docs/installations-plan.md: all seven served tools, not five).
  assert.equal(read(o, "app/llms.txt"), readFileSync(join(PACKAGES, "app/public/llms.txt"), "utf8"));
  assert.equal(read(o, "app/.well-known/mcp.json"), readFileSync(join(PACKAGES, "app/public/.well-known/mcp.json"), "utf8"));
});

test("discovery never advertises an endpoint the server doesn't answer", async () => {
  // A profile can't move the item tools, and must select them where they're served.
  const { validateProfile } = await import("../src/profile/validate.js");
  const base = JSON.parse(readFileSync(join(EXAMPLE, "profile.json"), "utf8"));
  const moved = structuredClone(base); moved.surfaces.mcp = [{ path: "/alternate", families: ["items"] }];
  const problems = validateProfile(moved).problems;
  assert.ok(problems.some(x => x.path === "/surfaces/mcp/0/path" && /serves the items family only at \/mcp, not \/alternate/.test(x.message)), JSON.stringify(problems));
  assert.ok(problems.some(x => x.path === "/surfaces/mcp" && /select the "items" family there/.test(x.message)));
  // With no available family selected, nothing falls back to a default endpoint.
  const { derivedVariables } = await import("../src/profile/template.js");
  const { generateDiscoveryFiles } = await import("../src/profile/discovery-files.js");
  const none = structuredClone(base); none.surfaces.mcp = [{ path: "/services/mcp", families: ["services"] }];
  assert.deepEqual(derivedVariables(none), { "discovery.mcpEndpoint": "", "discovery.itemTools": "" });
  const r = generateDiscoveryFiles({ profile: none, installed: { profile: none, digest: "d" }, copy: () => "x", readFile: () => new Uint8Array() });
  assert.ok(r.problems.includes("no available MCP family is selected; there is no endpoint to advertise"));
});

test("regenerating replaces the whole output: files from an earlier generation don't survive", async () => {
  const o = out();
  await discovery(EXAMPLE, o, {} as any);
  assert.ok(existsSync(join(o, "skills/plugin.meta.json")));
  const noListing = variant(p => { delete p.listing; });
  const receipt = await discovery(noListing, o, {} as any);
  assert.equal(existsSync(join(o, "skills")), false, "the earlier listing and icon are gone");
  assert.deepEqual(Object.keys(receipt.files).sort(), ["app/.well-known/mcp.json", "app/llms.txt"]);
  assert.deepEqual(JSON.parse(read(o, "discovery-receipt.json")).files, receipt.files);
  // No staging or previous trees are left beside it.
  const { readdirSync } = await import("node:fs");
  const { dirname, basename } = await import("node:path");
  assert.deepEqual(readdirSync(dirname(o)).filter(n => n.startsWith(`.${basename(o)}.`)), []);
});

test("concurrent generations for different installations never mix", async () => {
  const alpha = variant(p => {
    p.installation.id = "alpha"; p.brand.name = "Alpha"; p.listing.pluginName = "app-alpha";
    p.catalog = { languages: ["0180", "0176"] };
  });
  const beta = variant((p, d) => {
    p.installation.id = "beta"; p.brand.name = "Beta"; p.listing.pluginName = "app-beta";
    p.catalog = { languages: ["0180"] };
    writeFileSync(join(d, "copy/listing-long-description.md"), "Beta makes quizzes.\n");
  });
  const [oa, ob] = [out(), out()];
  const [ra, rb] = await Promise.all([discovery(alpha, oa, {} as any), discovery(beta, ob, {} as any), discovery(alpha, out(), {} as any), discovery(beta, out(), {} as any)]);
  assert.equal(ra.installationId, "alpha");
  assert.equal(rb.installationId, "beta");
  assert.equal(JSON.parse(read(oa, "skills/plugin.meta.json")).name, "app-alpha");
  assert.equal(JSON.parse(read(ob, "skills/plugin.meta.json")).name, "app-beta");
  assert.match(read(oa, "app/llms.txt"), /^# Alpha/);
  assert.match(read(ob, "app/llms.txt"), /^# Beta/);
  assert.ok(ra.languages.includes("L0176"));
  assert.deepEqual(rb.languages, ["L0180"], "each receipt uses its own catalog policy");
  // Generation installs nothing in the process.
  const { installedProfile } = await import("../src/profile/current.js");
  assert.equal(installedProfile(), null);
});

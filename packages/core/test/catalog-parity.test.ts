// Catalog policy parity (installations plan, P2, catalog). What an
// installation decides about the platform's languages (which are offered,
// discoverable, hidden, open to the free plan, sponsored) is recorded here
// from the code before it moves to the profile, and compared without a profile
// and with the Graffiticode profile (integration gate, GRAFFITICODE_PROFILE_DIR).
// UPDATE_PARITY_SNAPSHOTS=1 re-records.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as langs from "../src/lib/languages.js";
import { isDiscoverable } from "../src/discovery.js";
import { loadInstallation, resetInstallation } from "../src/profile/runtime.js";

const SNAPSHOT = new URL("./snapshots/graffiticode-catalog.json", import.meta.url).pathname;
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
afterEach(() => resetInstallation());

const ALL = Array.from({ length: 200 }, (_, i) => String(i).padStart(4, "0"));
const ids = (ls: { id: string }[]) => ls.map(l => l.id);

export async function catalogPolicy() {
  const known = ALL.filter(id => langs.findLanguageById(id));
  return {
    known,
    discoverable: ALL.filter(id => isDiscoverable(id)),
    listed: ids(await langs.listLanguages({})),
    listedQuiz: ids(await langs.listLanguages({ search: "quiz" })),
    listedLearnosity: ids(await langs.listLanguages({ search: "learnosity items" })),
    listedDomain: ids(await langs.listLanguages({ domain: "learnosity" })),
    selected: ids(langs.selectLanguages()),
    freePlan: langs.freePlanLanguageIds(),
    inFreePlan: known.filter(id => langs.isLanguageInFreePlanScope(id)),
    sponsored: Object.fromEntries(known.filter(id => langs.isLanguageSponsored(id)).map(id => [id, { name: langs.languageSponsor(id), uid: langs.languageSponsorUid(id) }])),
    status: Object.fromEntries(known.map(id => [id, langs.findLanguageById(id)!.status ?? null])),
    sponsorUrl: Object.fromEntries(known.map(id => [id, langs.findLanguageById(id)!.sponsorUrl ?? null]).filter(([, v]) => v)),
  };
}

test("without a profile, catalog policy is unchanged", async () => {
  const now = await catalogPolicy();
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile, catalog policy is identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, async () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  loadInstallation({ PROFILE_DIR: PROFILE! });
  assert.deepEqual(await catalogPolicy(), JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

const EXAMPLE = new URL("./fixtures/installation-example", import.meta.url).pathname;
async function withCatalog(edit: (p: any) => void) {
  const { cpSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(`${dir}/profile.json`, "utf8"));
  edit(p);
  writeFileSync(`${dir}/profile.json`, JSON.stringify(p));
  loadInstallation({ PROFILE_DIR: dir });
}

test("a profile's catalog decides what is offered, discoverable, hidden, free and sponsored", async () => {
  await withCatalog(p => {
    p.catalog = {
      languages: ["0176", "0177", "0178", "0179", "0180"],
      hidden: ["0177"],
      discovery: { minLanguage: 177, include: [], exclude: ["0179"] },
      sponsors: { "0176": { name: "Example Inc.", url: "https://example.test", uid: "sponsor-uid" } },
    };
    p.freePlan = { enabled: true, languages: ["0180"] };
  });
  // Offered: listed and selectable; others still resolve by id.
  assert.deepEqual(ids(langs.selectLanguages()), ["0176", "0177", "0178", "0179", "0180"]);
  assert.deepEqual(ids(await langs.listLanguages({})), ["0176", "0178", "0179", "0180"], "hidden 0177 isn't listed");
  assert.ok(langs.findLanguageById("0184"), "a language not offered still resolves (existing items)");
  assert.equal(langs.isLanguageOffered("0184"), false);
  // Discovery: offered, from 177 up, minus the exclusion.
  assert.deepEqual(ALL.filter(id => isDiscoverable(id)), ["0177", "0178", "0180"]);
  // Free plan and sponsors.
  assert.deepEqual(langs.freePlanLanguageIds(), ["0180"]);
  assert.equal(langs.isLanguageInFreePlanScope("L0176"), false);
  assert.equal(langs.languageSponsor("0176"), "Example Inc.");
  assert.equal(langs.languageSponsorUid("0176"), "sponsor-uid");
  assert.equal(langs.findLanguageById("0176")!.status, "Sponsored");
  // The code's own policy no longer applies: L0000 isn't sponsored here.
  assert.equal(langs.isLanguageSponsored("0000"), false);
  assert.notEqual(langs.findLanguageById("0000")!.status, "Sponsored");
  // Brand routing only reaches offered languages.
  assert.deepEqual(langs.brandedLanguageIds("a FigJam board"), []);
});

test("a language the installation doesn't offer can't start a new item", async () => {
  await withCatalog(p => { p.catalog = { languages: ["0180"] }; });
  const { assertItemCreateAllowed } = await import("../src/access.js");
  await assert.rejects(assertItemCreateAllowed({ uid: "u", token: "t" } as any, "L0186"), (e: any) => e.name === "NotFoundError" && /L0186 isn't available here/.test(e.message));
  const { getLanguageInfo } = await import("../src/languages-info.js");
  assert.equal(await getLanguageInfo("L0186"), null, "no detail for a language that isn't offered");
});

test("without catalog policy, a profile offers and discovers every platform language", async () => {
  await withCatalog(() => {});
  assert.equal(ids(langs.selectLanguages()).length, (JSON.parse(readFileSync(SNAPSHOT, "utf8")).known as string[]).length);
  assert.ok(isDiscoverable("0003"), "no floor unless the profile sets one");
  assert.equal(langs.isLanguageSponsored("0000"), false, "no sponsor unless the profile names one");
  assert.deepEqual(langs.freePlanLanguageIds(), []);
});

test("an explicit empty free-plan list allows nothing; an absent one allows every offered language", async () => {
  await withCatalog(p => { p.catalog = { languages: ["0179", "0180"] }; p.freePlan = { enabled: true, languages: [] }; });
  assert.deepEqual(langs.freePlanScope(), { restricted: true, ids: [] });
  assert.equal(langs.isLanguageInFreePlanScope("L0180"), false);
  resetInstallation();
  await withCatalog(p => { p.catalog = { languages: ["0179", "0180"] }; p.freePlan = { enabled: true }; });
  assert.deepEqual(langs.freePlanScope(), { restricted: false, ids: [] });
  assert.equal(langs.isLanguageInFreePlanScope("L0180"), true);
});

test("naming a vendor the installation doesn't offer is refused, never routed to a generic language", async () => {
  await withCatalog(p => { p.catalog = { languages: ["0180"] }; });
  assert.deepEqual(langs.unavailableBrandsNamed("a Learnosity quiz on fractions"), ["learnosity"]);
  assert.deepEqual(langs.brandedLanguageIds("a Learnosity quiz on fractions"), []);
  assert.deepEqual(ids(await langs.listLanguages({ search: "Learnosity quiz" })), [], "not the plain quiz language");
  assert.deepEqual(ids(await langs.listLanguages({ search: "quiz" })), ["0180"], "an unbranded search still finds it");
  const { classifyAndRoute } = await import("../src/lib/language-router.js");
  const r = await classifyAndRoute({ userRequest: "Make a Learnosity quiz on fractions", currentLang: "0180" });
  assert.deepEqual(r, { inScope: false, routedLang: null, reason: "request names learnosity, which this installation doesn't offer" });
  // Offered, the vendor routes as before.
  resetInstallation();
  await withCatalog(p => { p.catalog = { languages: ["0176", "0180"] }; });
  assert.deepEqual(langs.unavailableBrandsNamed("a Learnosity quiz"), []);
  assert.deepEqual(langs.brandedLanguageIds("a Learnosity quiz"), ["0176"]);
});

test("sponsorship never undoes deprecation", async () => {
  await withCatalog(p => { p.catalog = { sponsors: { "0158": { name: "Example Inc.", uid: "u" } } }; });
  const l = langs.findLanguageById("0158")!;
  assert.equal(l.status, "Deprecated");
  assert.equal(langs.languageSponsor("0158"), "Example Inc.", "it is still sponsored for billing");
  assert.ok(!ids(await langs.listLanguages({})).includes("0158"), "and still not listed");
  assert.ok(!langs.brandedLanguageIds("a Learnosity item").includes("0158"));
});

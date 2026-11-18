// The drain check (scripts/drained-revisions.mjs) over recorded Cloud Run
// answers and a real git history. No cloud calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrained, digestFrom, gitAncestry, reachable } from "../../scripts/drained-revisions.mjs";

// A history: old -> dualread -> later, and a side branch off old.
function history() {
  const dir = mkdtempSync(join(tmpdir(), "drain-git-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
  git("init", "-q", "-b", "main");
  const commit = name => { writeFileSync(join(dir, "f"), name); git("add", "f"); git("commit", "-q", "-m", name); return git("rev-parse", "HEAD"); };
  const old = commit("old");
  const dualread = commit("dualread");
  const later = commit("later");
  git("checkout", "-q", "-b", "side", old);
  const side = commit("side");
  return { dir, old, dualread, later, side, missing: "f".repeat(40) };
}
const H = history();
const isAncestor = gitAncestry(H.dir);

const digest = n => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const IMAGE = "us-docker.pkg.dev/p/r/mcp";
// What the registry says each release's build tag points at.
const BUILT = { rnew: digest(1), rlater: digest(2), rold: digest(3), rside: digest(4) };
const imageDigest = async (_image, release) => {
  if (!(release in BUILT)) throw new Error(`NOT_FOUND: ${release}`);
  return BUILT[release];
};
const revision = (name, release, commit, over = {}) => ({
  metadata: { name, labels: { "gc-release": release, "commit-sha": commit, "gc-dirty": "false", ...(over.labels ?? {}) } },
  spec: { containers: [{ image: `${IMAGE}@${over.digest ?? BUILT[release]}`, env: [{ name: "GC_RELEASE", value: over.gcRelease ?? release }] }] },
});
const RECEIPT = { version: 1, id: "rnew", service: "mcp-service", status: "released", dirty: false, commit: H.dualread };
const TARGETS = [{ name: "mcp", service: "mcp-service", project: "p", region: "r" }, { name: "openapi", service: "openapi-service", project: "p", region: "r" }];

async function check({ services, revisions, receipt = RECEIPT }) {
  return checkDrained({
    receipt, mcpService: "mcp-service", targets: TARGETS, imageDigest, isAncestor,
    describeService: async t => {
      if (!(t.service in services)) throw new Error("PERMISSION_DENIED");
      return { status: { traffic: services[t.service] } };
    },
    describeRevision: async (_t, name) => {
      if (!(name in revisions)) throw new Error("NOT_FOUND");
      return revisions[name];
    },
  });
}
const verdicts = report => report.services.flatMap(s => s.revisions.map(r => `${s.service}/${r.revision}: ${r.verdict}`));

const GOOD = {
  services: { "mcp-service": [{ revisionName: "mcp-rnew", percent: 100, tag: "rnew" }], "openapi-service": [{ revisionName: "openapi-rlater", percent: 100 }] },
  revisions: { "mcp-rnew": revision("mcp-rnew", "rnew", H.dualread), "openapi-rlater": revision("openapi-rlater", "rlater", H.later) },
};

test("drained: every reachable revision contains the required release", async () => {
  const r = await check(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  assert.deepEqual(r.required, { commit: H.dualread, release: "rnew" });
});

test("an older revision reachable only through its tag fails the check", async () => {
  const r = await check({
    services: { ...GOOD.services, "mcp-service": [...GOOD.services["mcp-service"], { revisionName: "mcp-rold", percent: 0, tag: "rold" }] },
    revisions: { ...GOOD.revisions, "mcp-rold": revision("mcp-rold", "rold", H.old) },
  });
  assert.equal(r.ok, false);
  const old = r.services[0].revisions.find(x => x.revision === "mcp-rold");
  assert.deepEqual([old.verdict, old.reachableBy], ["older", ["tag rold"]]);
});

test("older is lineage, not time: a later build of a side branch fails", async () => {
  const r = await check({
    services: { ...GOOD.services, "openapi-service": [{ revisionName: "openapi-rside", percent: 100 }] },
    revisions: { ...GOOD.revisions, "openapi-rside": revision("openapi-rside", "rside", H.side) },
  });
  assert.deepEqual(verdicts(r), ["mcp-service/mcp-rnew: ok", "openapi-service/openapi-rside: older"]);
});

test("whatever can't be verified fails the check", async () => {
  const cases = {
    "no gc-deploy labels": { metadata: { labels: {} }, spec: { containers: [{ image: `${IMAGE}@${digest(1)}` }] } },
    "dirty build": revision("x", "rnew", H.dualread, { labels: { "gc-dirty": "true" } }),
    "release env disagrees": revision("x", "rnew", H.dualread, { gcRelease: "rother" }),
    "image not the release's": revision("x", "rnew", H.dualread, { digest: digest(9) }),
    "release build tag unreadable": revision("x", "rgone", H.dualread, { digest: digest(5) }),
    "commit not in this clone": revision("x", "rnew", H.missing),
  };
  for (const [label, rev] of Object.entries(cases)) {
    const r = await check({ services: { ...GOOD.services, "openapi-service": [{ revisionName: "openapi-x", percent: 100 }] }, revisions: { ...GOOD.revisions, "openapi-x": rev } });
    assert.equal(r.ok, false, label);
    assert.equal(r.services[1].revisions[0].verdict, "unverifiable", label);
  }
  const unread = await check({ services: { ...GOOD.services, "openapi-service": [{ revisionName: "openapi-gone", percent: 100 }] }, revisions: GOOD.revisions });
  assert.equal(unread.services[1].revisions[0].verdict, "unverifiable", "a revision that can't be described");
  const noName = await check({ services: { ...GOOD.services, "openapi-service": [{ latestRevision: true, percent: 100 }] }, revisions: GOOD.revisions });
  assert.equal(noName.services[1].revisions[0].verdict, "unverifiable", "a traffic entry naming no revision");
  const noService = await check({ services: { "mcp-service": GOOD.services["mcp-service"] }, revisions: GOOD.revisions });
  assert.equal(noService.ok, false);
  assert.match(noService.services[1].problem, /couldn't describe/);
});

test("the required release must be a released, clean gc-deploy release of the MCP service", async () => {
  for (const [label, receipt] of Object.entries({
    staged: { ...RECEIPT, status: "staged" },
    dirty: { ...RECEIPT, dirty: true },
    "another service": { ...RECEIPT, service: "openapi-service" },
    missing: { id: "rnope", missing: "ENOENT" },
    "short commit": { ...RECEIPT, commit: H.dualread.slice(0, 7) },
  })) {
    const r = await check({ ...GOOD, receipt });
    assert.equal(r.ok, false, label);
    assert.ok(r.required.problems.length > 0, label);
    assert.deepEqual(r.services, [], `${label}: nothing is judged against an unusable baseline`);
  }
});

test("reachability: traffic and tags; a 0% untagged entry isn't reachable", () => {
  const by = reachable({ status: { traffic: [
    { revisionName: "a", percent: 90 }, { revisionName: "b", percent: 10, tag: "canary" }, { revisionName: "c", percent: 0, tag: "old" }, { revisionName: "d", percent: 0 },
  ] } });
  assert.deepEqual(Object.fromEntries(by), { a: ["traffic 90%"], b: ["traffic 10%", "tag canary"], c: ["tag old"] });
});

test("git ancestry: true, false, or unknown", async () => {
  assert.equal(await isAncestor(H.dualread, H.later), true);
  assert.equal(await isAncestor(H.dualread, H.dualread), true);
  assert.equal(await isAncestor(H.dualread, H.old), false);
  assert.equal(await isAncestor(H.dualread, H.side), false);
  assert.equal(await isAncestor(H.dualread, H.missing), null);
});

test("the image digest is read from gcloud's describe output", () => {
  assert.equal(digestFrom({ image_summary: { digest: digest(1) } }), digest(1));
  assert.equal(digestFrom({ image_summary: { fully_qualified_digest: `${IMAGE}@${digest(2)}` } }), digest(2));
  assert.equal(digestFrom({}), null);
});

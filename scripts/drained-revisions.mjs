#!/usr/bin/env node
// The OAuth-store cutover's drain check (installations plan, P5; runbook
// step 3): before the legacy store is fenced, no MCP or REST revision older
// than the dual-read release may still be reachable.
//
//   npm run check:drained -- --release <mcp release id> [--env production]
//
// The required release is a gc-deploy receipt (.gc-deploy/releases/<id>.json):
// released, from a clean tree. Its commit is the baseline. For each service
// (mcp, openapi), every revision reachable through traffic or a tag must:
//   - be a gc-deploy release built from a clean tree: its gc-release label,
//     its GC_RELEASE environment value and its commit-sha label present and
//     agreeing, and gc-dirty "false";
//   - run the image built for that release: the digest of <image>:<release>
//     in the registry;
//   - contain the baseline: git merge-base --is-ancestor <baseline> <commit>.
// "Older" is decided by code lineage, not by time: a revision made later from
// older code is older. Anything that can't be established (a revision not
// made by gc-deploy, a commit this clone doesn't have, an image whose build tag
// can't be read) is unverifiable, and fails the check like an older one.
//
// Read-only: it describes services, revisions and images (gcloud) and asks
// git about ancestry. It changes nothing. Exit 0 only when every reachable
// revision passed; it prints one JSON report either way.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const SERVICES = ["mcp", "openapi"];

// Which revisions a service can be reached at, and how.
export function reachable(service) {
  const by = new Map();
  for (const entry of service?.status?.traffic ?? []) {
    if (!(entry.percent > 0) && !entry.tag) continue;
    const name = entry.revisionName ?? null;
    const how = [...(by.get(name) ?? [])];
    if (entry.percent > 0) how.push(`traffic ${entry.percent}%`);
    if (entry.tag) how.push(`tag ${entry.tag}`);
    by.set(name, how);
  }
  return by;
}

const env = (revision, name) => (revision?.spec?.containers?.[0]?.env ?? []).find(e => e.name === name)?.value;

// The verdict on one reachable revision: ok, older, or unverifiable.
export async function judgeRevision(revision, baseline, { imageDigest, isAncestor }) {
  const labels = revision?.metadata?.labels ?? {};
  const release = labels["gc-release"];
  const commit = labels["commit-sha"];
  if (!revision) return { verdict: "unverifiable", reason: "the revision couldn't be read" };
  if (!release || !commit) return { verdict: "unverifiable", reason: "not a gc-deploy release (no gc-release or commit-sha label)" };
  if (labels["gc-dirty"] !== "false") return { verdict: "unverifiable", reason: `built from a dirty tree, or unknown (gc-dirty=${labels["gc-dirty"] ?? "absent"})` };
  if (env(revision, "GC_RELEASE") !== release) return { verdict: "unverifiable", reason: `GC_RELEASE (${env(revision, "GC_RELEASE") ?? "absent"}) doesn't match its gc-release label (${release})` };
  const image = revision?.spec?.containers?.[0]?.image ?? "";
  const running = image.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(running ?? "")) return { verdict: "unverifiable", reason: `its image isn't pinned by digest (${image})` };
  let built;
  try {
    built = await imageDigest(image.split("@")[0], release);
  } catch (err) {
    return { verdict: "unverifiable", reason: `the image built for ${release} couldn't be read: ${String(err?.message ?? err).slice(0, 120)}` };
  }
  if (built !== running) return { verdict: "unverifiable", reason: `it runs ${running}, not the image built for ${release} (${built ?? "none"})` };
  const contains = await isAncestor(baseline, commit);
  if (contains === null) return { verdict: "unverifiable", reason: `commit ${commit} isn't in this clone (fetch it, then re-run)` };
  if (!contains) return { verdict: "older", reason: `commit ${commit} doesn't contain the required release's commit ${baseline}` };
  return { verdict: "ok", release, commit };
}

// The required release, from its receipt.
export function baselineOf(receipt, { service }) {
  const problems = [];
  if (receipt?.version !== 1) problems.push("not a gc-deploy receipt (version 1)");
  if (receipt?.service !== service) problems.push(`it's a release of ${receipt?.service}, not ${service}`);
  if (receipt?.status !== "released") problems.push(`its status is ${receipt?.status}, not released`);
  if (receipt?.dirty !== false) problems.push("it was built from a dirty tree");
  if (!/^[0-9a-f]{40}$/.test(receipt?.commit ?? "")) problems.push("it records no full commit");
  return problems.length ? { problems } : { commit: receipt.commit, release: receipt.id };
}

// The whole check, over injected reads (tests pass recorded answers).
export async function checkDrained({ receipt, mcpService, targets, describeService, describeRevision, imageDigest, isAncestor }) {
  const base = baselineOf(receipt, { service: mcpService });
  if (base.problems) return { ok: false, required: { release: receipt?.id ?? null, problems: base.problems }, services: [] };
  const services = [];
  for (const t of targets) {
    const entry = { service: t.service, project: t.project, region: t.region, revisions: [] };
    let service;
    try {
      service = await describeService(t);
    } catch (err) {
      entry.problem = `couldn't describe the service: ${String(err?.message ?? err).slice(0, 160)}`;
      services.push(entry);
      continue;
    }
    const routes = reachable(service);
    if (!routes.size) entry.problem = "no revision is reachable, which can't be right for a serving service";
    for (const [name, how] of [...routes.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
      if (!name) {
        entry.revisions.push({ revision: null, reachableBy: how, verdict: "unverifiable", reason: "a traffic entry names no revision" });
        continue;
      }
      let revision = null;
      try {
        revision = await describeRevision(t, name);
      } catch {
        revision = null;
      }
      entry.revisions.push({ revision: name, reachableBy: how, ...(await judgeRevision(revision, base.commit, { imageDigest, isAncestor })) });
    }
    services.push(entry);
  }
  const ok = services.every(s => !s.problem && s.revisions.every(r => r.verdict === "ok"));
  return { ok, required: base, services };
}

// --- the reads ------------------------------------------------------------------

// Whether commit a is an ancestor of (or is) commit b in the clone at cwd:
// true, false, or null when git can't say (a commit it doesn't have).
export const gitAncestry = cwd => async (a, b) => {
  try {
    await run("git", ["merge-base", "--is-ancestor", a, b], { cwd });
    return true;
  } catch (err) {
    return err?.code === 1 ? false : null;
  }
};

// The digest in `gcloud artifacts docker images describe --format=json`.
export const digestFrom = d => d?.image_summary?.digest ?? d?.image_summary?.fully_qualified_digest?.split("@")[1] ?? null;

// --- the command ----------------------------------------------------------------

async function gcloudJson(args) {
  const { stdout } = await run("gcloud", [...args, "--format=json", "--quiet"], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// loadConfig returns a context; Cloud Run targets live inside its config.
export async function loadTargets({ config = "deploy.json", env = "production" } = {}) {
  const { loadConfig } = await import("@graffiticode/deploy/src/config.js");
  const targets = [];
  for (const name of SERVICES) {
    const { config: resolved } = await loadConfig({ config, env, service: name });
    targets.push({ name, service: resolved.service, project: resolved.project, region: resolved.region, image: resolved.image });
  }
  return targets;
}

async function main(argv) {
  const opts = { env: "production", config: "deploy.json" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!["release", "env", "config"].includes(key) || argv[i + 1] === undefined) {
      console.error("usage: npm run check:drained -- --release <mcp release id> [--env production] [--config deploy.json]");
      process.exit(2);
    }
    opts[key] = argv[i + 1];
  }
  if (!opts.release) {
    console.error("usage: npm run check:drained -- --release <mcp release id> [--env production]");
    process.exit(2);
  }
  const { readReceipt } = await import("@graffiticode/deploy/src/release.js");
  const root = path.dirname(path.resolve(opts.config));
  const targets = await loadTargets(opts);
  let receipt = null;
  try {
    receipt = await readReceipt(root, opts.release);
  } catch (err) {
    receipt = { id: opts.release, missing: String(err?.message ?? err) };
  }
  const report = await checkDrained({
    receipt,
    mcpService: targets.find(t => t.name === "mcp").service,
    targets,
    describeService: t => gcloudJson(["run", "services", "describe", t.service, `--project=${t.project}`, `--region=${t.region}`]),
    describeRevision: (t, name) => gcloudJson(["run", "revisions", "describe", name, `--project=${t.project}`, `--region=${t.region}`]),
    imageDigest: async (image, release) => digestFrom(await gcloudJson(["artifacts", "docker", "images", "describe", `${image}:${release}`])),
    isAncestor: gitAncestry(root),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));

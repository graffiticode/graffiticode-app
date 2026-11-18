// TTL provisioning (storage-ttl.ts): the script names its target explicitly,
// is idempotent, and covers every field the code writes for cleanup. It runs
// here only against a stand-in gcloud on PATH; nothing reaches the cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTL_POLICIES, TtlTargetError, ttlProvisioningScript } from "../src/storage-ttl.js";

const TARGET = { project: "example-installation", database: "example-db" };

test("every gcloud call names the installation's project and database", () => {
  const script = ttlProvisioningScript(TARGET);
  const calls = script.split("\n").filter(l => l.includes("gcloud "));
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.ok(c.includes("--project='example-installation' --database='example-db'"), c);
  for (const p of TTL_POLICIES) assert.ok(script.includes(`ensure_ttl '${p.collectionGroup}' '${p.field}'`), p.collectionGroup);
  execFileSync("bash", ["-n"], { input: script }); // parses
});

test("a target that isn't a project or database id is refused, so nothing unsafe reaches the shell", () => {
  for (const t of [{ project: "x; rm -rf /", database: "(default)" }, { project: "example-installation", database: "db'$(id)'" }, { project: "", database: "(default)" }]) {
    assert.throws(() => ttlProvisioningScript(t), TtlTargetError, JSON.stringify(t));
  }
  assert.ok(ttlProvisioningScript({ project: "graffiticode-app", database: "(default)" }).includes("--database='(default)'"));
});

test("idempotent: enables only what isn't already ACTIVE or CREATING, and a second run changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ttl-gcloud-"));
  const state = join(dir, "state.json");
  const log = join(dir, "calls.log");
  // A stand-in gcloud: describe answers from state.json; update records itself and marks the field CREATING.
  writeFileSync(join(dir, "gcloud"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const group = (args.find(a => a.startsWith("--collection-group=")) || "").split("=")[1];
const field = args[3];
if (args[1] === "indexes" && args[3] === "describe") process.stdout.write((s[group + "." + args[4]] || "") + "\\n");
else if (args[1] === "fields" && args[2] === "ttls" && args[3] === "update") { s[group + "." + args[4]] = "CREATING"; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); }
else { process.stderr.write("unexpected gcloud " + args.join(" ")); process.exit(9); }
`);
  chmodSync(join(dir, "gcloud"), 0o755);
  writeFileSync(state, JSON.stringify({ "idempotency-keys.expiresAt": "ACTIVE", "oauth_codes.expireAt": "NEEDS_REPAIR" }));
  writeFileSync(log, "");
  const script = join(dir, "ttl.sh");
  writeFileSync(script, ttlProvisioningScript(TARGET));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const updates = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter((a: string[]) => a[2] === "ttls");

  execFileSync("bash", [script], { env });
  const first = updates().map((a: string[]) => `${a.find(x => x.startsWith("--collection-group="))!.split("=")[1]}.${a[4]}`);
  assert.deepEqual(first.sort(), TTL_POLICIES.map(p => `${p.collectionGroup}.${p.field}`).filter(k => k !== "idempotency-keys.expiresAt").sort(),
    "everything but the already-active policy, including the one needing repair");
  for (const a of updates()) assert.ok(a.includes("--project=example-installation") && a.includes("--database=example-db") && a.includes("--enable-ttl"), a.join(" "));

  writeFileSync(log, "");
  execFileSync("bash", [script], { env });
  assert.equal(updates().length, 0, "a second run enables nothing");
});

test("the policies match the fields the code writes", () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("idempotency.ts"), /idempotency-keys\/[\s\S]*expiresAt: new Date\(/);
  assert.match(src("service-jobs.ts"), /service-job-keys\/[\s\S]*expiresAt: new Date\(/);
  assert.match(src("oauth-grants.ts"), /"oauth-grants"[\s\S]*expireAt: admin\.firestore\.Timestamp\.fromMillis/);
  // The OAuth store's three are checked against real documents in tests/baseline/oauth-store.test.ts.
  assert.deepEqual(TTL_POLICIES.filter(p => p.collectionGroup.startsWith("oauth_")).map(p => p.field), ["expireAt", "expireAt", "expireAt"]);
});

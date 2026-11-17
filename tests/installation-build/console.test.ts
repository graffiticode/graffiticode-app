// Production-build gate for console server loading (installations plan, P2):
// one `next build`, then the standalone server started with no profile and
// with two distinct profiles. Checks the behavior of real routes, not just a
// health response:
//   - /api/health reports each installation's receipt;
//   - the GraphQL route (/api) serves each installation's catalog policy;
//   - /api/generate runs the generation path the queue worker runs, and the
//     router refuses a vendor the installation doesn't offer;
//   - the queue worker's route (/api/generate-job) names the installation its
//     bundle runs with;
//   - an invalid profile stops the server from starting.
// Run with `npm run test:installation-build` (builds first; Firestore emulator).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SERVER_DIR = join(ROOT, "packages/console/.next/standalone/packages/console");
const EXAMPLE = join(ROOT, "packages/core/test/fixtures/installation-example");

let auth: http.Server;
let authOrigin = "";
before(async () => {
  assert.ok(existsSync(join(SERVER_DIR, "server.js")), "build the console first (npm run test:installation-build does)");
  // The auth service, as far as token verification goes: `user:<uid>` is valid.
  auth = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const token = body ? JSON.parse(body).idToken ?? "" : "";
      res.writeHead(token.startsWith("user:") ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(token.startsWith("user:") ? { status: "success", data: { uid: token.slice(5), token } } : { status: "error" }));
    });
  });
  await new Promise<void>(r => auth.listen(0, "127.0.0.1", () => r()));
  authOrigin = `http://127.0.0.1:${(auth.address() as any).port}`;
});
after(() => auth?.close());

// A profile variant of the example installation, pointed at the fake auth service.
function profile(id: string, edit: (p: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), `profile-${id}-`));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  p.installation.id = id;
  p.brand.name = id[0].toUpperCase() + id.slice(1);
  p.hosts.auth = authOrigin;
  p.hosts.api = authOrigin;
  edit(p);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(p));
  return dir;
}

async function freePort() {
  const s = http.createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as any).port;
  await new Promise(r => s.close(r));
  return port;
}

async function startConsole(env: Record<string, string>) {
  const port = await freePort();
  const child = spawn("node", ["server.js"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH!, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1",
      // No project here: each run states its own (a profile, or GOOGLE_CLOUD_PROJECT).
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "",
      INTERNAL_JOB_SECRET: "job-secret", FREE_PLAN_NAMESPACE_SALT: "salt",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", d => { output += d; });
  child.stderr!.on("data", d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok && child.exitCode === null) return { base, child, output: () => output };
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw Object.assign(new Error("console did not start"), { output });
}
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null) return;
  const exited = new Promise(r => child.once("exit", r));
  child.kill();
  await exited;
};

const gql = async (base: string, query: string) =>
  (await (await fetch(`${base}/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;
const generate = async (base: string, prompt: string, language: string) => {
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "user:alice" },
    body: JSON.stringify({ prompt, language }),
  });
  return { status: r.status, installation: r.headers.get("x-installation"), body: JSON.parse((await r.text()).trim().split("\n").pop()!) };
};
const workerHeader = async (base: string) =>
  (await fetch(`${base}/api/generate-job`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).headers.get("x-installation");

test("no profile: built-in policy, no installation, vendor requests route as before", async () => {
  const s = await startConsole({ NEXT_PUBLIC_GC_AUTH_URL: authOrigin, NEXT_PUBLIC_GC_API_URL: authOrigin, GOOGLE_CLOUD_PROJECT: "demo-installation" });
  try {
    assert.deepEqual(await (await fetch(`${s.base}/api/health`)).json(), { ok: true });
    assert.equal(await workerHeader(s.base), null);
    const r = await generate(s.base, "Make a Learnosity quiz on fractions", "0180");
    assert.notEqual(r.body.errors?.[0]?.code, "out_of_scope", JSON.stringify(r.body));
  } finally {
    await stop(s.child);
  }
});

test("two profiles, one build: each route runs with its own installation", async () => {
  const alpha = profile("alpha", p => { p.catalog = { languages: ["0176", "0180"] }; p.installation.project = "alpha-installation"; });
  const beta = profile("beta", p => { p.catalog = { languages: ["0180"] }; p.installation.project = "beta-installation"; });
  for (const [dir, id, offersLearnosity] of [[alpha, "alpha", true], [beta, "beta", false]] as const) {
    const s = await startConsole({ PROFILE_DIR: dir });
    try {
      // Startup itself (instrumentation register()) loaded the profile, before any route.
      assert.match(s.output(), new RegExp(`\\[installation\\] \\{[^\\n]*"installationId":"${id}"`));
      const health = await (await fetch(`${s.base}/api/health`)).json();
      assert.equal(health.installation.installationId, id);
      const digest = health.installation.profileDigest.slice(0, 12);
      // The queue worker's bundle runs with the same installation.
      assert.equal(await workerHeader(s.base), `${id}; profile=${digest}`);
      // The GraphQL route serves this installation's catalog policy.
      const search = await gql(s.base, `query { languages(search: "Learnosity items") { id } }`);
      const ids = (search.data?.languages ?? []).map((l: any) => l.id);
      if (offersLearnosity) assert.ok(ids.includes("0176"), JSON.stringify(search));
      else assert.deepEqual(ids, [], JSON.stringify(search));
      // The generation path (the worker's) routes under this installation's policy.
      const r = await generate(s.base, "Make a Learnosity quiz on fractions", "0180");
      assert.equal(r.installation, `${id}; profile=${digest}`);
      if (offersLearnosity) assert.notEqual(r.body.errors?.[0]?.code, "out_of_scope", JSON.stringify(r.body));
      else {
        assert.equal(r.body.errors?.[0]?.code, "out_of_scope", JSON.stringify(r.body));
        assert.match(r.body.errors[0].message, /request names learnosity, which this installation doesn't offer/);
      }
    } finally {
      await stop(s.child);
    }
  }
});

test("an invalid profile stops the console from starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-bad-"));
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ profileVersion: 1 }));
  await assert.rejects(startConsole({ PROFILE_DIR: dir }), (e: any) => /console did not start/.test(e.message) && /Invalid installation profile/.test(e.output));
});

// Application storage (P3, slice 1): each installation's writes land in its
// own project, and nothing falls back to a built-in one.
async function emulatorDoc(project: string, path: string) {
  const admin = (await import("firebase-admin")).default;
  const name = `check:${project}`;
  const app = admin.apps.find(a => a?.name === name) ?? admin.initializeApp({ projectId: project }, name);
  return (await app.firestore().doc(path).get()).exists;
}
const createUser = async (base: string, uid: string) =>
  (await fetch(`${base}/api/user`, { method: "POST", headers: { authorization: `user:${uid}` } })).status;

test("two profiles, one build: each installation's writes land in its own project", async () => {
  const alpha = profile("alpha", p => { p.installation.project = "alpha-installation"; });
  const beta = profile("beta", p => { p.installation.project = "beta-installation"; });
  for (const [dir, uid] of [[alpha, "alice-a"], [beta, "bob-b"]] as const) {
    const s = await startConsole({ PROFILE_DIR: dir });
    try {
      assert.equal(await createUser(s.base, uid), 200);
    } finally {
      await stop(s.child);
    }
  }
  assert.equal(await emulatorDoc("alpha-installation", "users/alice-a"), true);
  assert.equal(await emulatorDoc("beta-installation", "users/bob-b"), true);
  assert.equal(await emulatorDoc("beta-installation", "users/alice-a"), false);
  assert.equal(await emulatorDoc("alpha-installation", "users/bob-b"), false);
  assert.equal(await emulatorDoc("graffiticode-app", "users/alice-a"), false, "nothing reaches a built-in project");
});

test("a project the environment contradicts, or no project at all, stops the start", async () => {
  const alpha = profile("alpha", p => { p.installation.project = "alpha-installation"; });
  await assert.rejects(startConsole({ PROFILE_DIR: alpha, GOOGLE_CLOUD_PROJECT: "graffiticode-app" }),
    (e: any) => /contradicts the installation profile's project/.test(e.output));
  // Without a profile or a project, the console doesn't start: there is no
  // built-in project to fall back to.
  await assert.rejects(startConsole({ NEXT_PUBLIC_GC_AUTH_URL: authOrigin, NEXT_PUBLIC_GC_API_URL: authOrigin }),
    (e: any) => /console did not start/.test(e.message) && /GOOGLE_CLOUD_PROJECT is required: there is no built-in project/.test(e.output));
});

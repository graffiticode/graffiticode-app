// Production-build gate for the app package (installations plan, P3,
// slice 1, part 1b): one build, started with two profiles that keep their data
// in different projects. Each installation's writes, authenticated against its
// own auth host, land in its own project; a missing or contradicting project
// stops the start. APP_SERVER_DIR points at another build's standalone server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SERVER_DIR = process.env.APP_SERVER_DIR ?? join(ROOT, "packages/app/.next/standalone/packages/app");
const EXAMPLE = join(ROOT, "packages/core/test/fixtures/installation-example");

let auth: http.Server;
let authOrigin = "";
before(async () => {
  assert.ok(existsSync(join(SERVER_DIR, "server.js")), `build the app first (no server at ${SERVER_DIR})`);
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

function profile(id: string, project: string) {
  const dir = mkdtempSync(join(tmpdir(), `profile-${id}-`));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  Object.assign(p.installation, { id, project });
  Object.assign(p.hosts, { auth: authOrigin, api: authOrigin });
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

async function startApp(env: Record<string, string>) {
  const port = await freePort();
  const child = spawn("node", ["server.js"], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH!, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", d => { output += d; });
  child.stderr!.on("data", d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/form`)).status < 500 && child.exitCode === null) return { base, child, output: () => output };
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw Object.assign(new Error("app did not start"), { output });
}
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null) return;
  const exited = new Promise(r => child.once("exit", r));
  child.kill();
  await exited;
};

async function emulatorDoc(project: string, path: string) {
  const admin = (await import("firebase-admin")).default;
  const name = `check:${project}`;
  const app = admin.apps.find(a => a?.name === name) ?? admin.initializeApp({ projectId: project }, name);
  return (await app.firestore().doc(path).get()).data();
}
const putUser = async (base: string, uid: string) =>
  (await fetch(`${base}/api/user/${uid}`, { method: "PUT", headers: { authorization: `user:${uid}`, "content-type": "application/json" }, body: JSON.stringify({ name: uid }) })).status;

test("two profiles, one app build: each installation's writes land in its own project", async () => {
  for (const [id, project, uid] of [["alpha", "alpha-installation", "app-alice"], ["beta", "beta-installation", "app-bob"]]) {
    const s = await startApp({ PROFILE_DIR: profile(id, project) });
    try {
      assert.match(s.output(), new RegExp(`\\[installation\\] \\{[^\\n]*"installationId":"${id}"`));
      assert.equal(await putUser(s.base, uid), 200, s.output());
    } finally {
      await stop(s.child);
    }
  }
  assert.equal((await emulatorDoc("alpha-installation", "users/app-alice"))?.name, "app-alice");
  assert.equal((await emulatorDoc("beta-installation", "users/app-bob"))?.name, "app-bob");
  assert.equal(await emulatorDoc("beta-installation", "users/app-alice"), undefined);
  assert.equal(await emulatorDoc("alpha-installation", "users/app-bob"), undefined);
  assert.equal(await emulatorDoc("graffiticode", "users/app-alice"), undefined, "not the old emulator fallback");
  assert.equal(await emulatorDoc("graffiticode-app", "users/app-alice"), undefined, "not a built-in project");
});

test("a missing or contradicting project stops the app", async () => {
  await assert.rejects(startApp({}), (e: any) => /GOOGLE_CLOUD_PROJECT is required: there is no built-in project/.test(e.output));
  await assert.rejects(startApp({ PROFILE_DIR: profile("alpha", "alpha-installation"), GOOGLE_CLOUD_PROJECT: "graffiticode-app" }),
    (e: any) => /contradicts the installation profile's project/.test(e.output));
});

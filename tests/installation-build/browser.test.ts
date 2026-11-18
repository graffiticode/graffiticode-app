// Browser gate for the public configuration (installations plan, P3, slice 2):
// one production build of the console and of the app, started with two
// profiles, driven by headless Chrome. Each page loads /api/config before it
// initializes anything; the Firebase app it initializes, and the Privy app it
// calls, are its own installation's. A failed, malformed or unsupported-version
// /api/config shows a configuration error, and no provider initializes and no
// request leaves for Firebase, Privy, Stripe or an auth host: there is no
// built-in setting to fall back to.
//
// Requests leaving for anywhere but the server under test are recorded and
// blocked, so the gate touches no real service. Skipped without Chrome
// (CHROME_PATH, or the macOS default). CONSOLE_SERVER_DIR and APP_SERVER_DIR
// point at another build's standalone servers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chrome, chromeAvailable } from "./chrome.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const EXAMPLE = join(ROOT, "packages/core/test/fixtures/installation-example");
const SERVERS = {
  console: process.env.CONSOLE_SERVER_DIR ?? join(ROOT, "packages/console/.next/standalone/packages/console"),
  app: process.env.APP_SERVER_DIR ?? join(ROOT, "packages/app/.next/standalone/packages/app"),
};
const skip = !chromeAvailable() && "no Chrome: set CHROME_PATH";

const INSTALLATIONS = {
  alpha: { authProject: "alpha-auth", privyAppId: "calphaprivyapp00000000001" },
  beta: { authProject: "beta-auth", privyAppId: "cbetaprivyapp000000000001" },
};
type Name = keyof typeof INSTALLATIONS;

function profile(id: Name) {
  const dir = mkdtempSync(join(tmpdir(), `profile-${id}-`));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const { authProject, privyAppId } = INSTALLATIONS[id];
  Object.assign(p.installation, { id, project: `${id}-installation` });
  p.brand.name = id;
  p.brand.operator.supportEmail = `help@${id}.test`;
  p.brand.links.support = `https://support.${id}.test/help`;
  p.hosts.app = `https://app.${id}.test`;
  p.hosts.api = `https://api.${id}.test`;
  p.hosts.languageServer = `https://l{id}.${id}.test`;
  p.auth.firebase = { apiKey: `${id}-web-key`, authDomain: `${authProject}.firebaseapp.com`, projectId: authProject, appId: `1:1:web:${id}` };
  p.auth.privyAppId = privyAppId;
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

const running: ChildProcess[] = [];
async function start(server: keyof typeof SERVERS, profileDir: string) {
  assert.ok(existsSync(join(SERVERS[server], "server.js")), `build the ${server} first (no server at ${SERVERS[server]})`);
  const port = await freePort();
  const child = spawn("node", ["server.js"], {
    cwd: SERVERS[server],
    env: {
      PATH: process.env.PATH!, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1",
      PROFILE_DIR: profileDir, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:9",
      INTERNAL_JOB_SECRET: "gate", FREE_PLAN_NAMESPACE_SALT: "gate",
    },
    stdio: "ignore",
  });
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return base; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${server} didn't start`);
}

let chrome: Chrome;
const bases: Record<string, string> = {};
before(async () => {
  if (skip) return;
  chrome = await Chrome.launch();
  const dirs = { alpha: profile("alpha"), beta: profile("beta") };
  for (const server of ["console", "app"] as const) {
    for (const name of ["alpha", "beta"] as const) bases[`${server}:${name}`] = await start(server, dirs[name]);
  }
});
after(async () => {
  for (const c of running) c.kill();
  await chrome?.close();
});

// Requests to the providers a page initializes from its configuration.
const PROVIDER = /privy\.io|firebaseapp\.com|googleapis\.com|stripe\.com|identitytoolkit|securetoken|auth\.graffiticode|graffiticode\.org/;

for (const server of ["console", "app"] as const) {
  for (const name of ["alpha", "beta"] as const) {
    test(`${server} as ${name}: initializes from its own installation's configuration`, { skip }, async () => {
      const base = bases[`${server}:${name}`];
      const { authProject, privyAppId } = INSTALLATIONS[name];
      const other = INSTALLATIONS[name === "alpha" ? "beta" : "alpha"];
      const config = await (await fetch(`${base}/api/config`)).json();
      assert.equal(config.installation.id, name);
      assert.equal(config.auth.firebase.projectId, authProject);
      const r = await chrome.visit(`${base}/`, { allowOrigin: base, until: "document.documentElement.dataset.authProject" });
      assert.equal(r.installation, name, r.text);
      assert.equal(r.installationError, null);
      assert.equal(r.authProject, authProject, "the Firebase app initialized with the installation's auth project");
      assert.ok(r.requested.includes(`${base}/api/config`));
      assert.ok(r.requested.some(u => u.startsWith(`https://auth.privy.io/api/v1/apps/${privyAppId}`)), `Privy called with ${privyAppId}: ${r.requested.join(" ")}`);
      const all = r.requested.join(" ");
      assert.ok(!all.includes(other.privyAppId) && !all.includes(other.authProject), "nothing of the other installation");
      assert.ok(!/cmom2ijrw00040cl4hd9qvjnq|656973052505/.test(all), "nothing of the built-in Graffiticode settings");
      assert.deepEqual(r.requested.filter(u => /graffiticode\.org/.test(u)), [], "no request to a built-in host");
    });
  }
}

// What each installation's pages show comes from its own configuration
// (slice 2b): the app's name and MCP endpoint, the console's support channels.
for (const name of ["alpha", "beta"] as const) {
  test(`app as ${name}: the home page shows its own installation`, { skip }, async () => {
    const r = await chrome.visit(`${bases[`app:${name}`]}/`, { allowOrigin: bases[`app:${name}`], until: "document.documentElement.dataset.authProject" });
    assert.match(r.text, new RegExp(`This is where ${name} artifacts are rendered`), r.text);
    assert.match(r.text, /mcp\.example\.test\/mcp/);
    assert.doesNotMatch(r.text, /Graffiticode|graffiticode\.org/i);
    assert.doesNotMatch(r.text, new RegExp(name === "alpha" ? "beta" : "alpha"));
  });

  test(`console as ${name}: the support page shows its own channels`, { skip }, async () => {
    const r = await chrome.visit(`${bases[`console:${name}`]}/support`, { allowOrigin: bases[`console:${name}`], until: "document.documentElement.dataset.authProject" });
    assert.match(r.text, new RegExp(`help@${name}\\.test`), r.text);
    assert.match(r.text, new RegExp(`support\\.${name}\\.test`));
    assert.doesNotMatch(r.text, /graffiticode\.org/i);
  });
}

// Core's API client in the browser (spec pages: the spec frame, and language
// assets) uses the installation's API host, from its configuration: never a
// build-time value or Graffiticode's default.
for (const name of ["alpha", "beta"] as const) {
  for (const [what, path, expected] of [
    ["the spec frame", "/specs/0180", `https://api.${name}.test/L0180/spec.html`],
    ["a language asset", "/specs/0180?view=usage-guide", `https://api.${name}.test/L0180/`],
  ] as const) {
    test(`console as ${name}: ${what} comes from its own API host`, { skip }, async () => {
      const base = bases[`console:${name}`];
      const r = await chrome.visit(`${base}${path}`, {
        allowOrigin: base,
        until: `performance.getEntriesByType("resource").some(e => e.name.startsWith(${JSON.stringify(expected)}))`,
      });
      assert.ok(r.requested.some(u => u.startsWith(expected)), `expected a request to ${expected}: ${r.requested.filter(u => !u.startsWith(base)).join(" ")}\n${r.text.slice(0, 300)}`);
      assert.deepEqual(r.requested.filter(u => /graffiticode\.org/.test(u)), [], "no request to a built-in host");
      assert.ok(!r.requested.some(u => u.includes(`api.${name === "alpha" ? "beta" : "alpha"}.test`)));
    });
  }
}

const FAILURES = {
  "a failed request": { status: 500, body: "oops", expect: /answered 500/ },
  "a malformed response": { status: 200, body: "<html>not json</html>", contentType: "text/html", expect: /didn't return JSON/ },
  "an incomplete configuration": { status: 200, body: JSON.stringify({ configVersion: 1, installation: { id: "x" } }), expect: /brand is missing/ },
  "an unsupported version": { status: 200, body: "", expect: /unsupported configuration version 2/ },
};

// The pages each server is checked on. /billing imports the payment forms,
// so Stripe.js must not load there before the configuration has.
const PAGES = { console: ["/", "/billing"], app: ["/"] };

for (const server of ["console", "app"] as const) {
  for (const path of PAGES[server]) for (const [what, failure] of Object.entries(FAILURES)) {
    test(`${server} ${path} with ${what} from /api/config: a configuration error, and nothing initializes`, { skip }, async () => {
      const base = bases[`${server}:alpha`];
      // A real configuration with only the version changed, so only the version is wrong.
      const body = failure.body || JSON.stringify({ ...(await (await fetch(`${base}/api/config`)).json()), configVersion: 2 });
      const r = await chrome.visit(`${base}${path}`, {
        allowOrigin: base,
        respond: url => (new URL(url).pathname === "/api/config" ? { status: failure.status, body, contentType: (failure as any).contentType } : null),
        until: "document.documentElement.dataset.installationError",
      });
      assert.equal(r.config, "error", r.text);
      assert.match(r.text, /couldn.t load its configuration/);
      assert.match(r.text, failure.expect);
      assert.equal(r.installation, null);
      assert.equal(r.authProject, null, "no Firebase app initialized");
      assert.deepEqual(r.requested.filter(u => PROVIDER.test(u)), [], "no provider request");
      assert.deepEqual(r.iframes, [], "no provider frame");
      assert.deepEqual(r.scripts.filter(src => !src.startsWith(base)), [], "no provider script inserted");
    });
  }
}

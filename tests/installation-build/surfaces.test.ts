// Production-build gate for what the console and the app serve from the
// installation (installations plan, P3, slice 3): one build, started as two
// installations and with no profile.
//
// - Security headers: each document's policy is built from its own
//   installation's hosts, in its mode; without a profile, the console's header
//   is today's byte for byte and the app sends none. /api/config never carries
//   one.
// - Metadata: the prerendered HTML is byte-identical across all three; once
//   the configuration has loaded, the title and description are the
//   installation's, and stay so across client-side navigation, with exactly
//   one description in the document.
// - Brand images: each fixed URL answers with the installation's icon (bytes
//   and type), and with today's files without a profile.
// - Failure: a profile with a missing or invalid icon stops the server.
//
// Skipped without Chrome for the browser checks (CHROME_PATH, or the macOS
// default). CONSOLE_SERVER_DIR and APP_SERVER_DIR point at another build.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { Chrome, chromeAvailable } from "./chrome.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const EXAMPLE = join(ROOT, "packages/core/test/fixtures/installation-example");
const SERVERS = {
  console: process.env.CONSOLE_SERVER_DIR ?? join(ROOT, "packages/console/.next/standalone/packages/console"),
  app: process.env.APP_SERVER_DIR ?? join(ROOT, "packages/app/.next/standalone/packages/app"),
};
const noChrome = !chromeAvailable() && "no Chrome: set CHROME_PATH";

// Today's console policy, verbatim from next.config.mjs before slice 3.
const TODAY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.stripe.com https://*.firebaseio.com https://*.googleapis.com https://apis.google.com https://*.privy.io https://auth.privy.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: https://*.privy.io; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.stripe.com https://api.graffiticode.org https://auth.graffiticode.org https://*.privy.io https://auth.privy.io wss://*.privy.io https://api.openai.com https://api.anthropic.com; frame-src 'self' https://*.stripe.com https://*.privy.io https://auth.privy.io; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";
const TODAY_ICON = readFileSync(join(ROOT, "packages/console/public/favicon.png"));

// A small PNG of one color: each installation's own icon.
function png(rgba: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill(rgba).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(8).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const ICONS = { alpha: png([200, 30, 30, 255]), beta: png([30, 30, 200, 255]) };
// A 1x1 Adam7-interlaced PNG whose row filter is 5 (there is no filter 5).
const UNDECODABLE = (() => {
  const ok = png([1, 2, 3, 255]);
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr.set([8, 6, 0, 0, 1], 8);
  return Buffer.concat([ok.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([5, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))]);
})();
type Name = keyof typeof ICONS;

function profile(id: Name, edit: (p: any, dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), `profile-${id}-`));
  cpSync(EXAMPLE, dir, { recursive: true });
  const p = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  Object.assign(p.installation, { id, project: `${id}-installation` });
  p.brand.name = id;
  Object.assign(p.hosts, { api: `https://api.${id}.test`, auth: `https://auth.${id}.test` });
  writeFileSync(join(dir, "assets/icon.png"), ICONS[id]);
  edit(p, dir);
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
function spawnServer(server: keyof typeof SERVERS, env: Record<string, string>, port: number) {
  assert.ok(existsSync(join(SERVERS[server], "server.js")), `build the ${server} first (no server at ${SERVERS[server]})`);
  const child = spawn("node", ["server.js"], {
    cwd: SERVERS[server],
    env: {
      PATH: process.env.PATH!, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1",
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:9",
      INTERNAL_JOB_SECRET: "gate", FREE_PLAN_NAMESPACE_SALT: "gate", ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  running.push(child);
  return child;
}

async function start(server: keyof typeof SERVERS, env: Record<string, string>) {
  const port = await freePort();
  spawnServer(server, env, port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return base; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${server} didn't start`);
}

type Mode = Name | "none";
const MODES: Mode[] = ["alpha", "beta", "none"];
const bases: Record<string, string> = {};
let chrome: Chrome | null = null;

before(async () => {
  const env: Record<Mode, Record<string, string>> = {
    alpha: { PROFILE_DIR: profile("alpha") },
    beta: { PROFILE_DIR: profile("beta") },
    none: { GOOGLE_CLOUD_PROJECT: "demo-none" },
  };
  for (const server of ["console", "app"] as const) {
    for (const mode of MODES) bases[`${server}:${mode}`] = await start(server, env[mode]);
  }
  if (!noChrome) chrome = await Chrome.launch();
});
after(async () => {
  for (const c of running) c.kill();
  await chrome?.close();
});

// The page each server's document checks use: static, and open without sign-in.
const PAGE = { console: "/support", app: "/" } as const;

test("security headers: each installation's own policy; without a profile, today's", async () => {
  for (const mode of MODES) {
    const consoleRes = await fetch(`${bases[`console:${mode}`]}${PAGE.console}`);
    const appRes = await fetch(`${bases[`app:${mode}`]}${PAGE.app}`);
    assert.equal(consoleRes.headers.get("content-security-policy"), null, mode);
    assert.equal(appRes.headers.get("content-security-policy"), null, mode);
    const consoleCsp = consoleRes.headers.get("content-security-policy-report-only");
    const appCsp = appRes.headers.get("content-security-policy-report-only");
    if (mode === "none") {
      assert.equal(consoleCsp, TODAY, "the console's header is today's, byte for byte");
      assert.equal(appCsp, null, "the app sends none without a profile, as before");
    } else {
      const other = mode === "alpha" ? "beta" : "alpha";
      assert.match(consoleCsp ?? "", new RegExp(`connect-src [^;]*https://api\\.${mode}\\.test https://auth\\.${mode}\\.test`), mode);
      assert.match(appCsp ?? "", new RegExp(`frame-src 'self' https://api\\.${mode}\\.test`), mode);
      for (const h of [consoleCsp, appCsp]) assert.doesNotMatch(h ?? "", new RegExp(`${other}\\.test|graffiticode\\.org`), mode);
    }
    // Images and API responses carry the console's policy too, as next.config.mjs's headers() did.
    assert.equal((await fetch(`${bases[`console:${mode}`]}/favicon.png`)).headers.get("content-security-policy-report-only"), consoleCsp, mode);
    const config = await (await fetch(`${bases[`console:${mode}`]}/api/config`)).text();
    assert.doesNotMatch(config, /Content-Security-Policy|"csp"|default-src/i, "/api/config never carries security policy");
  }
});

test("brand images: each installation's icon at the fixed URLs; without a profile, today's files", async () => {
  const urls = [["console", "/favicon.png"], ["console", "/logo.png"], ["app", "/icon.png"]] as const;
  for (const mode of MODES) {
    for (const [server, path] of urls) {
      const res = await fetch(`${bases[`${server}:${mode}`]}${path}`);
      assert.equal(res.status, 200, `${server}${path} as ${mode}`);
      assert.equal(res.headers.get("content-type"), "image/png", `${server}${path} as ${mode}`);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(mode === "none" ? TODAY_ICON : ICONS[mode]), `${server}${path} as ${mode}: the wrong image`);
    }
  }
});

test("the prerendered HTML is the same for every installation", async () => {
  for (const server of ["console", "app"] as const) {
    const html = await Promise.all(MODES.map(async m => (await fetch(`${bases[`${server}:${m}`]}${PAGE[server]}`)).text()));
    assert.equal(html[0], html[1], `${server}: alpha and beta`);
    assert.equal(html[0], html[2], `${server}: alpha and no profile`);
    assert.equal((html[0].match(/<meta name="description"/g) ?? []).length, 1, `${server}: one description`);
  }
});

const EXPECTED: Record<Mode, { console: { title: string; description: string }; app: { title: string; description: string } }> = {
  alpha: {
    console: { title: "alpha Console", description: "alpha Console" },
    app: { title: "alpha", description: "Render alpha items and tasks as forms — created via the alpha MCP server at mcp.example.test/mcp" },
  },
  beta: {
    console: { title: "beta Console", description: "beta Console" },
    app: { title: "beta", description: "Render beta items and tasks as forms — created via the beta MCP server at mcp.example.test/mcp" },
  },
  none: {
    console: { title: "Console", description: "Graffiticode - A software studio" },
    app: { title: "Graffiticode", description: "Render Graffiticode items and tasks as forms — created via the Graffiticode MCP server at mcp.graffiticode.org/mcp" },
  },
};

for (const mode of MODES) {
  test(`console as ${mode === "none" ? "no profile" : mode}: the installation's title and description, across navigation`, { skip: noChrome }, async () => {
    const base = bases[`console:${mode}`];
    const { title, description } = EXPECTED[mode].console;
    const r = await chrome!.visit(`${base}${PAGE.console}`, {
      allowOrigin: base,
      until: `document.documentElement.dataset.installation && document.title === ${JSON.stringify(title)}`,
      steps: [
        { run: `window.next.router.push("/claim")`, until: `location.pathname === "/claim" && document.title.endsWith(" - Claim")` },
        { run: `window.next.router.push("/support")`, until: `location.pathname === "/support" && !document.title.includes(" - ")` },
      ],
    });
    assert.equal(r.installation, mode === "none" ? "graffiticode" : mode);
    assert.equal(r.afterSteps.length, 2);
    const [claim, back] = r.afterSteps;
    assert.deepEqual({ ...claim }, { path: "/claim", title: `${title} - Claim`, descriptions: [description] });
    assert.deepEqual({ ...back }, { path: "/support", title, descriptions: [description] });
  });

  test(`app as ${mode === "none" ? "no profile" : mode}: the installation's title and description, across navigation`, { skip: noChrome }, async () => {
    const base = bases[`app:${mode}`];
    const { title, description } = EXPECTED[mode].app;
    const r = await chrome!.visit(`${base}/`, {
      allowOrigin: base,
      until: `document.documentElement.dataset.installation && document.title === ${JSON.stringify(title)}`,
      steps: [{ run: `document.querySelector('a[href="/form"]').click()`, until: `location.pathname === "/form"` }],
    });
    assert.equal(r.title, title);
    assert.deepEqual(r.descriptions, [description]);
    assert.deepEqual({ ...r.afterSteps[0] }, { path: "/form", title, descriptions: [description] });
  });
}

test("item pages carry the installation's own metadata in their HTML", async () => {
  for (const mode of MODES) {
    const html = await (await fetch(`${bases[`app:${mode}`]}/form/some-item`)).text();
    const endpoint = mode === "none" ? "https://mcp.graffiticode.org/mcp" : "https://mcp.example.test/mcp";
    assert.match(html, new RegExp(`<title>${EXPECTED[mode].app.title}</title>`), mode);
    assert.match(html, new RegExp(`<meta name="mcp-server" content="${endpoint.replace(/\./g, "\\.")}"`), mode);
    assert.equal((html.match(/<meta name="description"/g) ?? []).length, 1, mode);
  }
});

test("a profile with a missing or invalid image stops the server", async () => {
  const icon = /brand\/assets\/icon|brand\.assets\.icon/;
  const cases: Record<string, [string, RegExp]> = {
    "a missing icon file": [profile("alpha", (_, dir) => unlinkSync(join(dir, "assets/icon.png"))), icon],
    "an icon that isn't an image": [profile("alpha", (_, dir) => writeFileSync(join(dir, "assets/icon.png"), "not an image")), icon],
    "a PNG icon cut after its header": [profile("alpha", (_, dir) => writeFileSync(join(dir, "assets/icon.png"), ICONS.alpha.subarray(0, 33))), icon],
    // Structurally whole, but its one row's filter (5) doesn't exist: only a decoder refuses it.
    "a PNG icon that doesn't decode": [profile("alpha", (_, dir) => writeFileSync(join(dir, "assets/icon.png"), UNDECODABLE)), /brand\/assets\/icon.*doesn't decode/],
    "an SVG icon": [profile("alpha", (_, dir) => writeFileSync(join(dir, "assets/icon.png"), '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>')), icon],
    "an ICO favicon naming no images": [profile("alpha", (_, dir) => writeFileSync(join(dir, "assets/favicon.ico"), Buffer.from([0, 0, 1, 0, 1, 0]))), /brand\/assets\/favicon/],
  };
  for (const server of ["console", "app"] as const) {
    for (const [what, [dir, expected]] of Object.entries(cases)) {
      const port = await freePort();
      const child = spawnServer(server, { PROFILE_DIR: dir }, port);
      let stderr = "";
      child.stderr!.on("data", d => { stderr += d; });
      const code = await new Promise<number | null>(r => {
        const timer = setTimeout(() => r(null), 20_000);
        child.once("exit", c => { clearTimeout(timer); r(c); });
      });
      assert.notEqual(code, null, `${server} with ${what} kept running`);
      assert.notEqual(code, 0, `${server} with ${what}`);
      assert.match(stderr, expected, `${server} with ${what}: ${stderr.slice(0, 300)}`);
    }
  }
});

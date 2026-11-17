// Host resolution precedence and consistency (installations plan, P2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveHosts, languageServerOrigin, HostConfigError } from "../src/profile/hosts.js";
import { configFromEnv } from "../src/config.js";
import { setInstalledProfile } from "../src/profile/current.js";

const EXAMPLE = JSON.parse(readFileSync(new URL("./fixtures/installation-example/profile.json", import.meta.url), "utf8"));
const profile = (edit: (p: any) => void = () => {}) => { const p = structuredClone(EXAMPLE); edit(p); return p; };

test("without a profile: today's defaults", () => {
  assert.deepEqual(resolveHosts(null, {}), {
    mcp: "https://mcp.graffiticode.org",
    console: "https://console.graffiticode.org",
    app: "https://app.graffiticode.org",
    api: "https://api.graffiticode.org",
    auth: "https://auth.graffiticode.org",
    openapi: "https://openapi.graffiticode.org",
    widgetAssets: "https://mcp.graffiticode.org",
    languageServer: "https://l{id}.graffiticode.org",
    issuer: "https://mcp.graffiticode.org",
    mcpResource: "https://mcp.graffiticode.org/mcp",
    openapiResource: "https://openapi.graffiticode.org/v1",
    consoleApi: "https://console.graffiticode.org/api",
  });
});

test("without a profile: each environment variable overrides its default", () => {
  const h = resolveHosts(null, {
    MCP_SERVER_URL: "http://localhost:3001/",
    GRAFFITICODE_CONSOLE_BASE_URL: "http://console.local",
    GRAFFITICODE_APP_URL: "http://app.local",
    NEXT_PUBLIC_GC_API_URL: "http://api.local",
    GRAFFITICODE_AUTH_URL: "http://auth.local",
    OPENAPI_PUBLIC_URL: "http://openapi.local/v1",
    WIDGET_ASSET_ORIGIN: "http://assets.local",
    GRAFFITICODE_CONSOLE_URL: "http://console-internal.local/api",
  });
  assert.equal(h.mcp, "http://localhost:3001");
  assert.equal(h.mcpResource, "http://localhost:3001/mcp");
  assert.equal(h.issuer, "http://localhost:3001", "the MCP server is its own issuer");
  assert.equal(h.console, "http://console.local");
  assert.equal(h.app, "http://app.local");
  assert.equal(h.api, "http://api.local");
  assert.equal(h.auth, "http://auth.local");
  assert.equal(h.openapi, "http://openapi.local");
  assert.equal(h.openapiResource, "http://openapi.local/v1");
  assert.equal(h.widgetAssets, "http://assets.local");
  assert.equal(h.consoleApi, "http://console-internal.local/api");
  // The REST server names the MCP server only as its issuer: it is the MCP host too.
  const rest = resolveHosts(null, { MCP_OAUTH_URL: "https://mcp.staging.test" });
  assert.equal(rest.issuer, "https://mcp.staging.test");
  assert.equal(rest.mcp, "https://mcp.staging.test");
});

test("two variables naming the same host must agree", () => {
  assert.equal(resolveHosts(null, { CONSOLE_URL: "https://c.test", GRAFFITICODE_CONSOLE_BASE_URL: "https://c.test/" }).console, "https://c.test");
  assert.throws(() => resolveHosts(null, { CONSOLE_URL: "https://c.test", GRAFFITICODE_CONSOLE_BASE_URL: "https://other.test" }),
    (e: any) => e instanceof HostConfigError && /CONSOLE_URL=https:\/\/c\.test and GRAFFITICODE_CONSOLE_BASE_URL=https:\/\/other\.test/.test(e.message));
});

test("with a profile: hosts come from the profile; internal wiring stays in the environment", () => {
  const h = resolveHosts(profile(), { GRAFFITICODE_CONSOLE_URL: "https://console-internal.run.app/api" });
  assert.equal(h.mcp, "https://mcp.example.test");
  assert.equal(h.console, "https://console.example.test");
  assert.equal(h.openapi, "https://api.example.test");
  assert.equal(h.issuer, "https://mcp.example.test");
  assert.equal(h.mcpResource, "https://mcp.example.test/mcp");
  assert.equal(h.openapiResource, "https://api.example.test/v1");
  assert.equal(h.widgetAssets, "https://mcp.example.test", "defaults to the MCP host");
  assert.equal(h.consoleApi, "https://console-internal.run.app/api");
  assert.equal(resolveHosts(profile(), {}).consoleApi, "https://console.example.test/api");
  // A proof revision loads its widget from its own tagged URL.
  assert.equal(resolveHosts(profile(), { WIDGET_ASSET_ORIGIN: "https://proof---mcp-service.run.app" }).widgetAssets, "https://proof---mcp-service.run.app");
});

test("with a profile: the environment may repeat it but never contradict it", () => {
  // deploy.json repeats public hosts today.
  const same = resolveHosts(profile(), { MCP_SERVER_URL: "https://mcp.example.test/", OPENAPI_PUBLIC_URL: "https://api.example.test/v1", MCP_OAUTH_URL: "https://mcp.example.test" });
  assert.equal(same.mcp, "https://mcp.example.test");
  for (const [name, value] of [
    ["MCP_SERVER_URL", "https://mcp.graffiticode.org"],
    ["CONSOLE_URL", "https://console.graffiticode.org"],
    ["OPENAPI_PUBLIC_URL", "https://openapi.graffiticode.org/v1"],
    ["MCP_OAUTH_URL", "https://mcp.graffiticode.org"],
  ]) {
    assert.throws(() => resolveHosts(profile(), { [name]: value }),
      (e: any) => e instanceof HostConfigError && e.message.includes(`${name}=${value} contradicts the installation profile`), name);
  }
});

test("advertised server URLs and OAuth resources must agree", () => {
  // Without a profile, the REST server's public base is its resource, so
  // servers[] and the resource can't drift apart; a resource off its host can.
  assert.throws(() => resolveHosts(null, { MCP_SERVER_URL: "https://mcp.a.test", MCP_OAUTH_URL: "https://mcp.b.test" }), /issuer https:\/\/mcp\.b\.test must be the MCP host/);
  // With a profile, the issuer must be the MCP host until P5 separates them.
  assert.throws(() => resolveHosts(profile(p => { p.auth.issuer = "https://auth.example.test"; }), {}), /must be the MCP host/);
  // Bypassing the profile validator, a resource off its host is still caught.
  assert.throws(() => resolveHosts(profile(p => { p.auth.resources.openapi = "https://elsewhere.test/v1"; }), {}), /REST resource https:\/\/elsewhere\.test\/v1 isn't on the REST host/);
  assert.throws(() => resolveHosts(profile(p => { p.auth.resources.mcp = "https://elsewhere.test/mcp"; }), {}), /MCP resource .* isn't on the MCP host/);
});

test("a language server's origin follows the pattern", () => {
  assert.equal(languageServerOrigin(resolveHosts(null, {}), "L0176"), "https://l0176.graffiticode.org");
});

test("core's configuration and the resolver always agree on public hosts", () => {
  const envs = [
    {},
    { GRAFFITICODE_API_URL: "https://api.staging.test", GRAFFITICODE_AUTH_URL: "https://auth.staging.test" },
    { NEXT_PUBLIC_GC_API_URL: "https://api.next.test", NEXT_PUBLIC_GC_AUTH_URL: "https://auth.next.test" },
    { GRAFFITICODE_CONSOLE_BASE_URL: "https://console.staging.test" },
    { CONSOLE_URL: "https://console.staging.test" },
  ];
  const saved = { NEXT_PUBLIC_GC_API_URL: process.env.NEXT_PUBLIC_GC_API_URL, NEXT_PUBLIC_GC_AUTH_URL: process.env.NEXT_PUBLIC_GC_AUTH_URL };
  delete process.env.NEXT_PUBLIC_GC_API_URL;
  delete process.env.NEXT_PUBLIC_GC_AUTH_URL;
  try {
    for (const env of envs) {
      const c = configFromEnv(env as any), h = resolveHosts(null, env);
      assert.deepEqual([c.apiUrl, c.authUrl, c.generationQueue.consoleUrl], [h.api, h.auth, h.console], JSON.stringify(env));
    }
    setInstalledProfile({ profile: profile(), digest: "d" });
    const c = configFromEnv({}), h = resolveHosts(profile(), {});
    assert.deepEqual([c.apiUrl, c.authUrl, c.generationQueue.consoleUrl], [h.api, h.auth, h.console]);
    assert.equal(c.generationQueue.consoleUrl, "https://console.example.test");
  } finally {
    setInstalledProfile(null);
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  }
});

test("a server's build-time NEXT_PUBLIC_* values never act as runtime configuration", () => {
  // On a server, Next inlines a literal process.env.NEXT_PUBLIC_* read at build
  // time. Simulated here by the process environment holding the build's
  // values while the runtime environment passed in doesn't.
  const saved = { api: process.env.NEXT_PUBLIC_GC_API_URL, auth: process.env.NEXT_PUBLIC_GC_AUTH_URL };
  process.env.NEXT_PUBLIC_GC_API_URL = "https://api.graffiticode.org";
  process.env.NEXT_PUBLIC_GC_AUTH_URL = "https://auth.graffiticode.org";
  const p = profile(x => { x.hosts.api = "https://api.example.test"; x.hosts.auth = "https://auth.example.test"; });
  setInstalledProfile({ profile: p, digest: "build-values" });
  try {
    const c = configFromEnv({});
    assert.equal(c.apiUrl, "https://api.example.test");
    assert.equal(c.authUrl, "https://auth.example.test");
    // A variable the server is actually running with is still checked.
    assert.throws(() => configFromEnv({ NEXT_PUBLIC_GC_API_URL: "https://api.graffiticode.org" }), /contradicts the installation profile/);
  } finally {
    setInstalledProfile(null);
    for (const [k, v] of [["NEXT_PUBLIC_GC_API_URL", saved.api], ["NEXT_PUBLIC_GC_AUTH_URL", saved.auth]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

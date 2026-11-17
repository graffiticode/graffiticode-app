// Where the REST server says it lives (installations plan, P2, hosts): the
// advertised server URL, the OAuth resource and its metadata, and the issuer
// all come from one resolution, after the profile is loaded, with the
// precedence core/test/hosts.test.ts pins.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { loadInstallation, resetInstallation } from "@graffiticode-app/core/profile/runtime";

const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;
const saved = { ...process.env };
afterEach(() => {
  resetInstallation();
  for (const k of ["OPENAPI_PUBLIC_URL", "OPENAPI_RESOURCE", "MCP_OAUTH_URL", "GRAFFITICODE_APP_URL"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

async function advertised() {
  const app = createApp();
  const spec = await (await app.request("http://x/v1/openapi.json")).json();
  const path = `/.well-known/oauth-protected-resource${new URL(spec.servers[0].url).pathname}`;
  const meta = await (await app.request(`http://x${path}`)).json();
  return { server: spec.servers[0].url, flow: spec.components.securitySchemes.oauth2.flows.authorizationCode, meta };
}

test("with a profile, the advertised server, the OAuth resource and the issuer agree", async () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE });
  const a = await advertised();
  assert.equal(a.server, "https://api.example.test/v1");
  assert.equal(a.meta.resource, a.server, "the resource is the advertised server");
  assert.deepEqual(a.meta.authorization_servers, ["https://mcp.example.test"]);
  assert.equal(a.flow.authorizationUrl, `https://mcp.example.test/oauth/authorize?resource=${encodeURIComponent(a.server)}`);
  assert.equal(a.flow.tokenUrl, "https://mcp.example.test/oauth/token");
  assert.equal(a.flow.refreshUrl, "https://mcp.example.test/oauth/token");
});

test("without a profile, the environment decides, and the same three still agree", async () => {
  process.env.OPENAPI_PUBLIC_URL = "https://openapi.staging.test/v1";
  process.env.MCP_OAUTH_URL = "https://mcp.staging.test";
  const a = await advertised();
  assert.equal(a.server, "https://openapi.staging.test/v1");
  assert.equal(a.meta.resource, a.server);
  assert.deepEqual(a.meta.authorization_servers, ["https://mcp.staging.test"]);
  // The description's OAuth flow names the same authorization server and resource.
  assert.equal(a.flow.authorizationUrl, `https://mcp.staging.test/oauth/authorize?resource=${encodeURIComponent(a.server)}`);
  assert.equal(a.flow.tokenUrl, "https://mcp.staging.test/oauth/token");
  assert.equal(a.flow.refreshUrl, "https://mcp.staging.test/oauth/token");
});

test("with a profile, an environment variable may repeat a host but not contradict it", () => {
  assert.ok(loadInstallation({ PROFILE_DIR: EXAMPLE, OPENAPI_PUBLIC_URL: "https://api.example.test/v1", MCP_OAUTH_URL: "https://mcp.example.test" }));
  resetInstallation();
  assert.throws(() => loadInstallation({ PROFILE_DIR: EXAMPLE, OPENAPI_PUBLIC_URL: "https://openapi.graffiticode.org/v1" }),
    /OPENAPI_PUBLIC_URL=https:\/\/openapi\.graffiticode\.org\/v1 contradicts the installation profile/);
  assert.throws(() => loadInstallation({ PROFILE_DIR: EXAMPLE, GRAFFITICODE_APP_URL: "https://app.graffiticode.org" }), /GRAFFITICODE_APP_URL=.* contradicts/);
});

test("without a profile, contradictory variables for one host stop the start", () => {
  assert.throws(() => loadInstallation({ OPENAPI_RESOURCE: "https://a.test/v1", OPENAPI_PUBLIC_URL: "https://b.test/v1" }), /name the same host differently/);
});

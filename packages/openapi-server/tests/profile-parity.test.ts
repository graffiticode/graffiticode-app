// Parity gate for the REST server's installation-bearing surfaces
// (installations plan, P2): the served description (JSON and YAML), the docs
// page, problem `type` URIs, the oEmbed provider and the free-plan signup
// link. Compared byte for byte with snapshots recorded before extraction,
// without a profile and with the Graffiticode profile installed.
// Re-record only for an intended change: UPDATE_PARITY_SNAPSHOTS=1.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { oembedProvider } from "../src/routes/items.ts";
import { signupUrl } from "../src/routes/account.ts";
import { loadInstallation, resetInstallation } from "@graffiticode-app/core/profile/runtime";

delete process.env.OPENAPI_PUBLIC_URL;
const SNAPSHOT = new URL("./snapshots/graffiticode-surfaces.json", import.meta.url).pathname;
const PROFILE = resolve(process.env.GRAFFITICODE_PROFILE_DIR ?? new URL("../../../../installation-graffiticode", import.meta.url).pathname);
const haveProfile = existsSync(`${PROFILE}/profile.json`);

afterEach(() => resetInstallation());

async function surfaces() {
  const app = createApp();
  const get = async (path: string) => {
    const r = await app.request(`http://x${path}`);
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  return {
    "GET /v1/openapi.json": await get("/v1/openapi.json"),
    "GET /v1/openapi.yaml": await get("/v1/openapi.yaml"),
    "GET /v1/docs": await get("/v1/docs"),
    "GET /v1/no-such-route": await get("/v1/no-such-route"),
    oembedProvider: oembedProvider(),
    signupUrl: signupUrl(),
  };
}

test("without a profile, every REST surface is unchanged", async () => {
  const now = await surfaces();
  if (process.env.UPDATE_PARITY_SNAPSHOTS === "1") {
    mkdirSync(new URL("./snapshots/", import.meta.url).pathname, { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
  }
  assert.deepEqual(now, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});

test("with the Graffiticode profile installed, every REST surface is byte-identical", { skip: !haveProfile && `no Graffiticode profile at ${PROFILE}` }, async () => {
  loadInstallation({ PROFILE_DIR: PROFILE });
  const now = await surfaces();
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const key of Object.keys(expected)) assert.deepEqual((now as any)[key], expected[key], key);
});

test("a different profile changes the REST surfaces", { skip: !haveProfile && `no Graffiticode profile at ${PROFILE}` }, async () => {
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(PROFILE, dir, { recursive: true, filter: src => !src.includes("/.git") });
  const p = JSON.parse(readFileSync(`${dir}/profile.json`, "utf8"));
  Object.assign(p.brand, { name: "Example", links: { ...p.brand.links, product: "https://example.test", signup: "https://example.test/signup" } });
  p.hosts.openapi = "https://api.example.test";
  p.hosts.mcp = "https://mcp.example.test";
  p.auth = { issuer: "https://mcp.example.test", resources: { mcp: "https://mcp.example.test/mcp", openapi: "https://api.example.test/v1" } };
  writeFileSync(`${dir}/profile.json`, JSON.stringify(p));
  loadInstallation({ PROFILE_DIR: dir });

  const app = createApp();
  const spec = await (await app.request("http://x/v1/openapi.json")).json();
  assert.deepEqual(spec.servers, [{ url: "https://api.example.test/v1" }]);
  assert.equal(spec.info.title, "Example API");
  assert.deepEqual(spec.info.contact, { name: "Example", url: "https://example.test" });
  assert.match(spec.info.description, /https:\/\/api\.example\.test\/problems\/<code>/);
  const flow = spec.components.securitySchemes.oauth2.flows.authorizationCode;
  assert.equal(flow.authorizationUrl, "https://mcp.example.test/oauth/authorize?resource=https%3A%2F%2Fapi.example.test%2Fv1");
  assert.equal(flow.tokenUrl, "https://mcp.example.test/oauth/token");
  assert.match(spec.components.securitySchemes.oauth2.description, /https:\/\/mcp\.example\.test\/oauth\/register/);
  assert.match(await (await app.request("http://x/v1/docs")).text(), /<title>Example API<\/title>/);
  const problem = await (await app.request("http://x/v1/no-such-route")).json();
  assert.equal(problem.type, "https://api.example.test/problems/not_found");
  assert.deepEqual(oembedProvider(), { name: "Example", url: "https://example.test", untitled: "Example item" });
  assert.equal(signupUrl(), "https://example.test/signup");
});

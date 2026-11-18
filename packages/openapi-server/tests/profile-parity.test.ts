// Parity gate for the REST server's installation-bearing surfaces
// (installations plan, P2): the served description (JSON and YAML), the docs
// page, problem `type` URIs, the oEmbed provider and the free-plan signup
// link. Compared byte for byte with snapshots recorded before extraction,
// without a profile, and (an integration gate, run when
// GRAFFITICODE_PROFILE_DIR names it) with the Graffiticode profile installed.
// The example installation's checks always run, from the committed fixture.
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
const PROFILE = process.env.GRAFFITICODE_PROFILE_DIR ? resolve(process.env.GRAFFITICODE_PROFILE_DIR) : null;
const EXAMPLE = new URL("../../core/test/fixtures/installation-example", import.meta.url).pathname;

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

test("with the Graffiticode profile installed, every REST surface is byte-identical", { skip: !PROFILE && "integration gate: set GRAFFITICODE_PROFILE_DIR to the Graffiticode profile" }, async () => {
  assert.ok(existsSync(`${PROFILE}/profile.json`), `no profile at ${PROFILE}`);
  loadInstallation({ PROFILE_DIR: PROFILE! });
  const now = await surfaces();
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  for (const key of Object.keys(expected)) assert.deepEqual((now as any)[key], expected[key], key);
});

test("the example installation's REST surfaces are its own", async () => {
  loadInstallation({ PROFILE_DIR: EXAMPLE });
  const app = createApp();
  const spec = await (await app.request("http://x/v1/openapi.json")).json();
  assert.deepEqual(spec.servers, [{ url: "https://api.example.test/v1" }]);
  assert.equal(spec.info.title, "Example API");
  assert.equal(spec.info.summary, "Example summary.");
  assert.equal(spec.info.description, "Problems are https://api.example.test/problems/<code>.");
  assert.deepEqual(spec.info.contact, { name: "Example", url: "https://example.test" });
  const oauth2 = spec.components.securitySchemes.oauth2;
  assert.equal(oauth2.description, "Register at https://mcp.example.test/oauth/register; tokens are issued for https://api.example.test/v1.");
  const flow = oauth2.flows.authorizationCode;
  assert.equal(flow.authorizationUrl, "https://mcp.example.test/oauth/authorize?resource=https%3A%2F%2Fapi.example.test%2Fv1");
  assert.equal(flow.tokenUrl, "https://mcp.example.test/oauth/token");
  assert.equal(flow.refreshUrl, "https://mcp.example.test/oauth/token");
  assert.match(await (await app.request("http://x/v1/docs")).text(), /<title>Example API<\/title>/);
  assert.equal((await (await app.request("http://x/v1/no-such-route")).json()).type, "https://api.example.test/problems/not_found");
  assert.deepEqual(oembedProvider(), { name: "Example", url: "https://example.test", untitled: "Example item" });
  assert.equal(signupUrl(), "https://example.test/signup");
  assert.equal((await (await app.request("http://x/health")).json()).installation.installationId, "example");
});

test("a copy template naming a value the profile doesn't have fails the load", () => {
  const dir = mkdtempSync(`${tmpdir()}/profile-`);
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(`${dir}/copy/openapi-info-title.txt`, "{{brand.nmae}} API\n");
  assert.throws(() => loadInstallation({ PROFILE_DIR: dir }), /openapi\.info\.title refers to \{\{brand\.nmae\}\}/);
});

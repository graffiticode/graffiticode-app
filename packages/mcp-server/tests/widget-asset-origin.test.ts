/**
 * The widget's asset origin is its own setting, apart from MCP_SERVER_URL.
 *
 * MCP_SERVER_URL is also the OAuth issuer, protected resource and introspection
 * audience. A proof revision on a tagged URL must load its widget from that URL
 * while presenting exactly production's OAuth metadata; otherwise promoting it
 * would reject every existing token as minted for another resource. This file
 * sets WIDGET_ASSET_ORIGIN before anything reads it, as a proof revision does.
 */
import assert from "node:assert/strict";
import test from "node:test";

const PROOF = "https://widgetproof---mcp-service-example-uc.a.run.app";
delete process.env.MCP_SERVER_URL;
process.env.WIDGET_ASSET_ORIGIN = PROOF;

const { widgetAssetOrigin, widgetCsp, generateWidgetHtml } = await import("../src/widget/index.js");
const { handleAuthServerMetadata, handleProtectedResourceMetadata } = await import("../src/oauth/handlers.js");
const { INTROSPECTION_AUDIENCE } = await import("../src/oauth/introspection.js");

/** Calls a metadata handler with a fake response and returns the JSON it sent. */
function metadata(handler: (req: never, res: never) => void): Record<string, unknown> {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() { return res; },
    end(chunk?: string) { body = chunk ?? ""; },
  };
  handler({} as never, res as never);
  return JSON.parse(body);
}

test("the widget loads from WIDGET_ASSET_ORIGIN", () => {
  assert.equal(widgetAssetOrigin(), PROOF);
  assert.deepEqual(widgetCsp().camel.resourceDomains, [PROOF]);
  assert.deepEqual(widgetCsp().snake.resource_domains, [PROOF]);
  assert.match(generateWidgetHtml(widgetAssetOrigin()), new RegExp(`__MCP_ORIGIN__ = "${PROOF.replace(/[.]/g, "\\.")}"`));
});

test("the OAuth metadata stays production's", () => {
  const as = metadata(handleAuthServerMetadata);
  assert.equal(as.issuer, "https://mcp.graffiticode.org");
  assert.equal(as.token_endpoint, "https://mcp.graffiticode.org/oauth/token");
  const pr = metadata(handleProtectedResourceMetadata);
  assert.equal(pr.resource, "https://mcp.graffiticode.org/mcp");
  assert.deepEqual(pr.authorization_servers, ["https://mcp.graffiticode.org"]);
  assert.equal(INTROSPECTION_AUDIENCE, "https://mcp.graffiticode.org/oauth/introspect");
});

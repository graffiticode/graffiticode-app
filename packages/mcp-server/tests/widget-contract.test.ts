import assert from "node:assert/strict";
import test from "node:test";
import { mergeToolPayload } from "../src/widget/browser/renderer.js";
import {
  CLAUDE_WIDGET_MIME_TYPE,
  matchWidgetUri,
  widgetCsp,
  widgetContentHash,
  widgetResourceMeta,
  widgetResourceUris,
} from "../src/widget/index.js";

test("current and historical Claude widget URIs resolve with a strict hash", () => {
  assert.equal(matchWidgetUri(widgetResourceUris().mcp), "mcp");
  assert.equal(matchWidgetUri("ui://graffiticode/widget-mcp.deadbeef.html"), "mcp");
  assert.equal(matchWidgetUri("ui://graffiticode/claude-form-widget.html"), "mcp");
  assert.equal(matchWidgetUri("ui://graffiticode/widget-mcp.anything.html"), null);
  assert.equal(matchWidgetUri("ui://graffiticode/widget-mcp.deadbeef00.html"), null);
});

test("resource policy changes invalidate the widget cache key", () => {
  const origin = process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";
  const meta = widgetResourceMeta();
  const current = widgetContentHash(origin, meta);
  const oldPolicy = widgetContentHash(origin, { ui: meta.ui });
  assert.notEqual(current, oldPolicy);
  assert.equal(widgetResourceUris().mcp, `ui://graffiticode/widget-mcp.${current}.html`);
});

test("retired OpenAI widget pointers are classified but not confused with MCP Apps", () => {
  assert.equal(matchWidgetUri("ui://graffiticode/form-widget.html"), "openai");
  assert.equal(matchWidgetUri("ui://graffiticode/widget-oai.cafebabe.html"), "openai");
  assert.equal(CLAUDE_WIDGET_MIME_TYPE, "text/html;profile=mcp-app");
});

test("Claude CSP declares only the component bundle origin", () => {
  const csp = widgetCsp();
  assert.deepEqual(Object.keys(csp.camel), ["resourceDomains"]);
  assert.deepEqual(Object.keys(csp.snake), ["resource_domains"]);
});

// ChatGPT's web sandbox reads `openai/widgetCSP`, not `ui.csp`. Without it the
// per-language import() is refused in the browser and the widget falls back to the card.
test("widget resource declares its CSP in both the MCP Apps and Apps SDK dialects", () => {
  const meta = widgetResourceMeta();
  const csp = widgetCsp();
  assert.deepEqual(meta.ui, { csp: csp.camel });
  assert.deepEqual(meta["openai/widgetCSP"], csp.snake);
});

test("renderer merges namespaced hydration with compact structured content", () => {
  const merged = mergeToolPayload({
    structuredContent: {
      item_id: "item-1",
      status: "ready",
      language: "L0166",
      name: "Fixture",
    },
    meta: {
      graffiticode: {
        data: { data: { type: "spreadsheet" }, errors: [] },
        view_url: "https://app.graffiticode.org/form/item-1",
      },
    },
  });
  assert.equal(merged.item_id, "item-1");
  assert.deepEqual(merged.data, { data: { type: "spreadsheet" }, errors: [] });
  assert.equal(merged.view_url, "https://app.graffiticode.org/form/item-1");
});

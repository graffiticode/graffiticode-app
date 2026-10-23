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

// The whole policy, pinned: the bundle origin, and exactly one frame origin (L0176's own
// /form, the framed language). Never connectDomains, never a wildcard, nothing else.
test("CSP declares the bundle origin and only L0176's /form as a frame", () => {
  const origin = process.env.WIDGET_ASSET_ORIGIN || process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";
  const csp = widgetCsp();
  assert.deepEqual(csp.camel, {
    resourceDomains: [origin],
    frameDomains: ["https://l0176.graffiticode.org"],
  });
  assert.deepEqual(csp.snake, {
    resource_domains: [origin],
    frame_domains: ["https://l0176.graffiticode.org"],
  });
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

test("the widget resource asks ChatGPT not to narrate what it shows (openai/widgetDescription)", async () => {
  const { widgetResourceMeta, WIDGET_DESCRIPTION } = await import("../src/widget/index.js");
  const meta = widgetResourceMeta() as Record<string, unknown>;
  assert.equal(meta["openai/widgetDescription"], WIDGET_DESCRIPTION);
  assert.match(WIDGET_DESCRIPTION, /need not restate its contents/);
});

test("the widget build id is the bundle's hash, injected into the HTML without a cycle", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { widgetBuildId, generateWidgetHtml, widgetContentHash } = await import("../src/widget/index.js");
  const bundle = readFileSync(new URL("../dist/widget/widget.bundle.js", import.meta.url), "utf8");
  const id = widgetBuildId();
  assert.equal(id, createHash("sha256").update(bundle).digest("hex").slice(0, 8));
  assert.equal(widgetBuildId(), id, "stable");
  const html = generateWidgetHtml("https://mcp.graffiticode.org");
  assert.ok(html.includes(`window.__WIDGET_BUILD__ = ${JSON.stringify(id)};`));
  // The resource hash covers the HTML (and so the build id) and its metadata; a
  // metadata-only change moves the resource hash but never the build id.
  assert.notEqual(widgetContentHash("https://mcp.graffiticode.org", { a: 1 }), widgetContentHash("https://mcp.graffiticode.org", { a: 2 }));
  assert.equal(widgetBuildId(), id);
});

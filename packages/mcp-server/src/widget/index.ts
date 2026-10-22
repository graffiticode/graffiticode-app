/**
 * Widget module exports for the native inline widget.
 *
 * OpenAI clients DO receive widget metadata and the widget resource, as of
 * 2026-08-31 — the same resource and the same bundles Claude gets, keyed
 * differently (`openai/outputTemplate` alongside `ui.resourceUri`). The route is
 * decided in `widgetRouteFor()`; see CLAUDE.md for which client takes which.
 *
 * Only the RETIRED OpenAI-shaped URIs below are unserved: they point at the old
 * card template, and `matchWidgetUri` keeps classifying them so a stale pointer
 * fails loudly instead of looking like a typo.
 */
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { widgetContentHash } from "./widget-html.js";
import { FRAMED_LANGUAGES } from "./languages.js";

export { generateWidgetHtml, widgetContentHash } from "./widget-html.js";
export { NATIVE_LANGUAGES, FRAMED_LANGUAGES, framedLanguage } from "./languages.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";

/**
 * The origin the widget loads its bundles and beacons from, and so the origin its
 * CSP admits in `resourceDomains`.
 *
 * Its own setting, NOT `MCP_SERVER_URL`: that one is also the OAuth issuer, the
 * protected resource, the callbacks and the introspection audience. A proof
 * revision on a tagged URL needs its widget to load from that URL while its OAuth
 * metadata stays exactly production's, or promoting it would reject every existing
 * token as minted for another resource. Production sets it explicitly
 * (deploy.json), so a release always overwrites a proof value: the deploy CLI's
 * `--update-env-vars` keeps any variable it isn't given.
 */
export function widgetAssetOrigin(): string {
  return process.env.WIDGET_ASSET_ORIGIN || MCP_SERVER_URL;
}

// Claude / MCP Apps resource. mimeType is the official MCP Apps content type
// (`text/html;profile=mcp-app`) from the ext-apps SDK.
export const CLAUDE_WIDGET_MIME_TYPE = RESOURCE_MIME_TYPE;

/**
 * Widget resource URIs, content-hashed.
 *
 * The host caches a widget by its resource URI (the spike proved this the hard
 * way — a stable URI made Claude replay a stale build across every redeploy). So
 * the served HTML's hash is baked into the URI: any change mints a new URI and the
 * host must re-read. Two URIs because the two hosts need different mimeTypes.
 */
let cachedUris: { mcp: string } | null = null;

export function widgetResourceUris(): { mcp: string } {
  if (!cachedUris) {
    const h = widgetContentHash(widgetAssetOrigin(), widgetResourceMeta());
    cachedUris = {
      mcp: `ui://graffiticode/widget-mcp.${h}.html`,
    };
  }
  return cachedUris;
}

/**
 * Classify known widget URI shapes a host might have cached.
 *
 * Only MCP/Claude URIs are served. OpenAI URIs remain classified so tests and
 * diagnostics can distinguish an intentionally retired pointer from a typo.
 * Hashes are exactly the eight lowercase hex characters minted above; accepting
 * arbitrary suffixes would turn a content-addressed resource into a wildcard.
 */
export function matchWidgetUri(uri: string): "openai" | "mcp" | null {
  if (uri === "ui://graffiticode/form-widget.html" || /^ui:\/\/graffiticode\/widget-oai\.[a-f0-9]{8}\.html$/.test(uri)) {
    return "openai";
  }
  if (uri === "ui://graffiticode/claude-form-widget.html" || /^ui:\/\/graffiticode\/widget-mcp\.[a-f0-9]{8}\.html$/.test(uri)) {
    return "mcp";
  }
  return null;
}

/**
 * Widget CSP. The native widget loads per-language bundles from our own origin
 * and makes no other network calls (formula/chart evaluation is client-side), so
 * `resourceDomains` admits only that origin, and there is still no
 * `connectDomains`. Claude verified our origin in `resourceDomains` reaches
 * `script-src`, which is all the bundle import needs.
 *
 * `frameDomains` lists exactly the origins of the FRAMED languages (L0176's
 * `/form`; see FRAMED_LANGUAGES for why it can't render natively), and nothing
 * else. Declaring any frame domain draws OpenAI's extra manual review; that was
 * accepted on 2026-10-22, because the native alternative needs a frame too
 * (Learnosity authenticates from a questions.learnosity.com iframe), plus more.
 */
export function widgetCsp(): { camel: Record<string, string[]>; snake: Record<string, string[]> } {
  const origin = widgetAssetOrigin();
  const frames = FRAMED_LANGUAGES.map((l) => l.origin);
  return {
    camel: { resourceDomains: [origin], frameDomains: frames },
    snake: { resource_domains: [origin], frame_domains: frames },
  };
}

/**
 * The `_meta` for the widget resource, in BOTH CSP dialects.
 *
 * `ui.csp` is the MCP Apps spelling and is what Claude reads. ChatGPT's web sandbox
 * reads the Apps SDK's own `openai/widgetCSP` (snake_case), and `snake` was computed
 * above but never emitted — so ChatGPT fell back to its default CSP, which does not
 * admit our origin, and the per-language `import()` was refused inside the sandbox
 * before any request left the browser. On screen that was "Interactive preview
 * unavailable" with `Failed to fetch dynamically imported module …/L0180.mjs`, and in
 * the logs a `resources/read` from openai-mcp followed by no bundle fetch at all.
 * A host ignores the dialect it does not speak, so sending both costs nothing.
 */
export function widgetResourceMeta(): Record<string, unknown> {
  const csp = widgetCsp();
  return { ui: { csp: csp.camel }, "openai/widgetCSP": csp.snake };
}

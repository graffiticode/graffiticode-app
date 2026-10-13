/**
 * The Claude MCP Apps widget HTML.
 *
 * The interactive logic is `browser/entry.ts`, bundled to a single IIFE by
 * scripts/build-widget.mjs and inlined here. The bundle picks the host adapter at
 * runtime. The Skybridge adapter remains in the browser seam for the separate
 * ChatGPT experiment, but production resource routing only serves this document
 * to MCP Apps hosts.
 *
 * `__MCP_ORIGIN__` (bundle origin, must match the CSP resourceDomains) and
 * `__NATIVE__` (languages with a native bundle) are injected here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NATIVE_LANGUAGES } from "./languages.js";

// esbuild always writes the bundle to dist/widget/. In production this module is
// itself in dist/widget/, so the module-relative path resolves directly. Under the
// test runner (tsx compiles from src/) the module lives in src/widget/, so we also
// try the built copy under the project root's dist/.
const BUNDLE_CANDIDATES = [
  fileURLToPath(new URL("./widget.bundle.js", import.meta.url)),
  join(process.cwd(), "dist/widget/widget.bundle.js"),
];

let cachedScript: string | null = null;

function loadBundle(): string {
  if (cachedScript === null) {
    for (const path of BUNDLE_CANDIDATES) {
      try {
        cachedScript = readFileSync(path, "utf8");
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (cachedScript === null) {
      throw new Error(
        `Widget bundle not found (looked in ${BUNDLE_CANDIDATES.join(", ")}). Run "npm run build".`
      );
    }
  }
  return cachedScript;
}

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* A frame scrollbar that comes and goes changes the content's width, and
     anything whose height depends on width (L0179's horizontally scrolling grid)
     then feeds back into the next height report — the spreadsheet jitter.
     Reserving the gutter makes the width independent of the scrollbar. Not
     overflow: hidden — a host that caps the frame height would clip the content
     with no way to reach it. */
  html { scrollbar-gutter: stable; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #fff; color: #111827; padding: 4px; }
  body.dark { background: #1f2937; color: #f9fafb; }
  #content.loading { display: flex; align-items: center; justify-content: center; height: 160px; color: #6b7280; }
  .error { padding: 20px; color: #dc2626; background: #fef2f2; border-radius: 8px; text-align: center; }
  body.dark .error { color: #fca5a5; background: #450a0a; }
  .card { padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px; background: #f9fafb; }
  body.dark .card { border-color: #374151; background: #111827; }
  .card-title { font-size: 16px; font-weight: 600; }
  .card-text { margin-top: 6px; font-size: 14px; color: #6b7280; }
  body.dark .card-text { color: #9ca3af; }
  .card-body { margin-top: 12px; }
  /* Shown when a native render was attempted and fell back to this card. Muted and
     italic: it explains a degraded preview, not a broken item, and the item itself
     is fine. The cause rides in the element's title attribute rather than on screen. */
  .card-note { margin-top: 10px; font-size: 12px; font-style: italic; color: #9ca3af; cursor: help; }
  body.dark .card-note { color: #6b7280; }
  .native-content { min-width: 0; }
  .card-pre { margin-top: 10px; padding: 10px; font-size: 12px; white-space: pre-wrap; overflow-x: auto;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; max-height: 320px; overflow-y: auto; }
.card-table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
.card-table th,.card-table td{border:1px solid var(--border,#d8d8d8);padding:4px 6px;text-align:left;vertical-align:top}
.card-table th{font-weight:600;background:rgba(127,127,127,.10)}
  body.dark .card-pre { background: #0b1220; border-color: #374151; }
  .q-list { margin-top: 10px; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
  .q-stim { font-weight: 500; }
  .q-template { margin-top: 4px; font-size: 14px; line-height: 1.5; }
  .q-opts { margin-top: 4px; padding-left: 16px; list-style: none; }
  .q-opts li { font-size: 13px; color: #6b7280; }
  .q-opts li.correct { color: #15803d; font-weight: 600; }
  body.dark .q-opts li.correct { color: #4ade80; }
  .footer-link { display: block; width: 100%; margin-top: 10px; font: inherit; font-size: 13px; cursor: pointer;
    padding: 6px; border: none; background: none; color: #2563eb; text-align: center; }
  .footer-link:hover { text-decoration: underline; }
  body.dark .footer-link { color: #60a5fa; }
`;

/** @param origin absolute origin serving /widget/lang/*.mjs (must match CSP resourceDomains) */
export function generateWidgetHtml(origin: string): string {
  const script = loadBundle();
  const native = JSON.stringify(NATIVE_LANGUAGES.map((l) => l.id));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${STYLES}</style>
</head>
<body>
  <div id="content" class="loading">Loading…</div>
  <script>
    window.__MCP_ORIGIN__ = ${JSON.stringify(origin)};
    window.__NATIVE__ = ${native};
  </script>
  <script>${script}</script>
</body>
</html>`;
}

/** The resource URI is the host's cache key (the spike proved this the hard way),
 * so hash the served HTML into it: any change to the widget mints a new URI and
 * the host is forced to re-read instead of replaying a stale build. */
export function widgetContentHash(origin: string, resourceMeta?: Record<string, unknown>): string {
  const hash = createHash("sha256").update(generateWidgetHtml(origin));
  // Hosts cache the resource's policy alongside its HTML. A metadata-only fix
  // must mint a new URI too, or the old sandbox policy can survive deployment.
  if (resourceMeta !== undefined) hash.update(JSON.stringify(resourceMeta));
  return hash.digest("hex").slice(0, 8);
}

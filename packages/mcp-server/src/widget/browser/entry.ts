/**
 * Widget browser entry — one file for both hosts.
 *
 * createHost() picks the ext-apps (Claude) or Skybridge (ChatGPT) adapter by
 * feature-detecting window.openai, so a single bundle serves both resources. The
 * two resources differ only in mimeType and CSP, declared server-side.
 *
 * Not compiled by tsc (browser-only) — bundled by scripts/build-widget.mjs.
 */
import { createHost } from "./host.js";
import { startRenderer } from "./renderer.js";

const host = createHost();
startRenderer(host);

host.connect().catch((err: unknown) => {
  const root = document.getElementById("content");
  if (root) {
    root.className = "error";
    root.textContent = "Failed to connect to host: " + (err instanceof Error ? err.message : String(err));
  }
});

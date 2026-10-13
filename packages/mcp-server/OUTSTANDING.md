# Outstanding issues

## ChatGPT-native inline rendering is unimplemented

**Status:** open (2026-07-15).

**Current production baseline (intentional and stable).** Rendering is per-host:

- **Claude (web + desktop)** renders items **natively inline** — a real interactive
  component (charts, spreadsheets, etc.) via the MCP Apps widget, with the per-language
  bundle loaded from our own origin (`resourceDomains` CSP, no iframe).
- **ChatGPT / Codex (web + desktop)** gets **no widget**. The tool result's text
  summary is shown with an "Open in Graffiticode" link. `toolsForClient()` strips the
  widget metadata for OpenAI hosts on purpose.

**Why ChatGPT gets no widget.** ChatGPT's sandbox cannot load our component bundles
from our origin: its `script-src` is a fixed CDN allowlist, so a same-origin
`import()` of our per-language `.mjs` is blocked. The text-plus-link experience is a
clean, defensible tools-only baseline that avoids OpenAI's "static frame with no
meaningful interaction" review rule.

**The only demonstrated path to ChatGPT-native rendering** is loading components from
an allowlisted CDN (e.g. `esm.sh`) instead of our origin. That exists **only as a
branch experiment**, not on `main`. Before it could ship it needs:

1. Verification across ChatGPT **web + desktop + mobile**.
2. **Claude regression testing** — the same widget serves Claude, and the CDN import
   path must not degrade the native Claude experience.
3. Confidence in the CDN dependency (availability, versioning, CSP/CORS) as a
   production render path.

Until then, the Claude-native / ChatGPT-text-link split above is the shipped behavior.

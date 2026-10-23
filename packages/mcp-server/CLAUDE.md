# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run build         # Compile TS to dist/ (tsc) + bundle the MCP Apps widget (esbuild)
npm run build:widget  # Bundle only the widget (src/widget/browser → dist/widget/widget.bundle.js + per-language dist/widget/lang/<id>.mjs)
npm run clean         # Remove dist/ directory
npm run start         # Run Streamable HTTP server (reads PORT env, defaults to 3001)
npm run gcp:logs      # View Cloud Run logs
```

## Deploy

**Deploys are manual and go through gc-deploy**, using the `mcp` entry in the root `deploy.json` (Cloud Run service `mcp-service`, us-central1). Run from the **repo root** on a clean, merged `main`:

```bash
npm run deploy -- deploy mcp --plan   # preview the release; no cloud calls
npm run deploy -- deploy mcp          # build → candidate revision → verify → promote
npm run rollback -- mcp --env production --release <id>   # printed at the end of every deploy
```

A release deploys a tagged revision with **no traffic**. Then it runs `verify/mcp.mjs` and the smoke paths (`/health`, `/widget/lang/L0180.mjs`, `/health?deep=1`) against that revision. Only then does it move 100% of traffic to it. It refuses a revision below the R1 baseline in `deploy.json`. **`npm run gcp:build` and `gcp:deploy` are legacy — don't use them.** They deploy straight to traffic, which skips verification and bypasses gc-deploy's pinned-revision traffic, `deploy.json` env and secret versions.

`deploy.json` owns this service's protocol/queue env (`GRAFFITICODE_BACKEND`, `GENERATION_*`, `CONSOLE_URL`, …) and its secret mounts at **pinned versions** (`INTERNAL_JOB_SECRET`, `FREE_PLAN_API_KEY`, `FREE_PLAN_NAMESPACE_SALT`, `ACT_AS_GRANT_SECRET`). To change one of these, edit `deploy.json` and deploy; an out-of-band change is overwritten by the next release. Anything set out-of-band must use `--update-env-vars`/`--update-secrets` (additive), and creates a revision with **no traffic**, because gc-deploy pins traffic by revision. Move traffic to it with `gcloud run services update-traffic mcp-service --to-revisions <rev>=100`.

## Testing / debugging

There is no unit-test suite. Two **eval harnesses** stand in for one; both hit a
live console and cost real API calls, so run them deliberately, not on every edit.

```bash
# Routing eval: does a model pick the RIGHT language for a prompt?
ANTHROPIC_API_KEY=… GRAFFITICODE_API_KEY=… npm run eval:routing
ANTHROPIC_API_KEY=… GRAFFITICODE_API_KEY=… npm run eval:routing -- --catalog-only

# Cross-language eval: exercises the get_spec adoption path end-to-end
GRAFFITICODE_API_KEY=… npx tsx scripts/eval-cross-language.ts
```

`scripts/eval-routing.ts` puts a real model in front of the real agent-facing surface
(`SERVER_INSTRUCTIONS` + the live `list_languages`/`get_language_info` schemas and handlers,
plus SKILL.md bodies read from the monorepo's `packages/skills` (`../skills` from here) — override with
`GRAFFITICODE_SKILLS_PATH`) and asserts which `language` it passes to a stubbed `create_item`.
Nothing is generated. It exists to lock down a specific regression: prompts that merely
*mention* an assessment ("a 5-question quiz on the water cycle") routing to the **vendor-gated**
Learnosity languages (L0158/L0176), which may only be chosen when the user names Learnosity.
Routing is stochastic, so each case runs N times (`EVAL_RUNS`, default 3) — a 1-of-N failure is
still a regression. **Run this after touching `SERVER_INSTRUCTIONS`, tool descriptions, the
language catalog, or the skills repo** — those are exactly the inputs it guards.

For manual testing, the standard tool is the **MCP Inspector** — the official MCP server
testing/debugging app (`npx @modelcontextprotocol/inspector`). When the user says "the
inspector" or "the MCP test app", they mean this. Point it at the running server
(`npm run start`, default `http://localhost:3001/mcp`, Streamable HTTP transport) to exercise
tools, resources, and the MCP Apps widget.

## Architecture

This is a thin-router MCP server for Graffiticode. It provides a fixed set of language-agnostic tools that route to language-specific backends. The client specifies which language to use; all language expertise lives in the backend.

```
┌─────────────────────────────────────────────────────────────────────┐
│  MCP Server (thin router)                                           │
│  Tools: create_item, update_item, render_item, get_item, get_spec,  │
│         list_languages, get_language_info                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Graffiticode API → Language-specific backends                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Entry Points

- **`src/server.ts`** - Streamable HTTP transport for hosted deployments. Auth via `Authorization: Bearer <api-key>` header, OAuth 2.1 access token, or no auth at all (free-plan path: server forwards calls to console with `X-Free-Plan-Session: <mcp-session-id>` instead). Endpoint: `/mcp`

### Core Modules

- **`src/api.ts`** - GraphQL client for Graffiticode API. All language discovery and code generation is backend-driven. Defines `AuthContext`, the value threaded through every handler: `{ type: "firebase", token, source: "oauth" | "raw" }` or `{ type: "freePlan", sessionId }`. `buildAuthHeaders` turns the former into `Authorization: Bearer` and the latter into `X-Free-Plan-Session`. There is **no** `src/auth.ts` and no Firebase custom-token/ID-token exchange in this repo — `resolveBearer()` in `server.ts` classifies the incoming bearer and the console does the rest.
- **`src/events.ts`** - Structured funnel events (`mcp_connect`, `mcp_listed`, `mcp_resource`, `mcp_session_started`, `mcp_tool`) emitted as one JSON line per event to stdout → Cloud Logging, aggregated by the console's `scripts/mcp-funnel-report.ts` and its hourly digest (`console/src/lib/funnel-digest.ts`). `mcp_listed` (first `tools/list`-family request per session) and `mcp_resource` (a `resources/read`, logged only for our own `graffiticode://` namespace) are the stages between "a transport opened" and "someone asked for something" — without them a directory validator and an agent host that loaded the catalog and passed are the same event. All of these are emitted from ONE place: the `transport.onmessage` wrapper in `server.ts`, which the existing-session path reuses, so a single hook sees every message of a session. Every event also carries `tns`, the stable per-transport namespace: `session` becomes the console's workspace handle once a call adopts a workspace, so connect↔tool joins must key on `tns`. Instrumentation is best-effort and must never break a request. The privacy contract is load-bearing and asserted in the user-facing copy: never log raw prompts (only `desc_len`), never log raw session UUIDs or bearer tokens (only a one-way hash), never log the client IP (only coarse `CF-IPCountry` geo). The free-plan session hash reuses `deriveSessionNamespace` so the logged `session` joins to what the console stamps on items and claims.
- **`src/tools.ts`** - MCP tool definitions and handlers. Routes requests to backend based on language parameter.
- **`src/resources.ts`** - MCP resource handlers: per-language user guides, and **agent skills** discovered at request time from `packages/skills` in the public `graffiticode-app` GitHub repo (core/skills.ts) (each top-level dir = one skill `<id>/SKILL.md`, exposed as `graffiticode://skills/<id>`). Catalog is fetched via the GitHub contents API + raw content, cached ~60s (stale-while-revalidate). Adding a skill to that repo surfaces it with no rebuild/redeploy; nothing is vendored into this repo.
- **`src/oauth/`** - OAuth 2.1 + PKCE for hosted mode: dynamic client registration, authorize/callback/token endpoints, Firestore-backed store. Hosted auth accepts either an OAuth access token or a raw Graffiticode API key as the Bearer credential.
- **`src/widget/`** - A **native** inline widget that renders items *in the host sandbox* — no iframe. `toolsForClient()` (in `tools.ts`) wires the widget resource onto each widget-bearing tool's `_meta` (mimeType `text/html;profile=mcp-app`) on **two separate routes**, decided by `widgetRouteFor()`:
  - **`mcp-apps`** (Claude) — requires BOTH that the client declared `capabilities.extensions["io.modelcontextprotocol/ui"]` at `initialize` AND that its name matches `isWidgetHost()` = `/claude/i`. The declaration is load-bearing: `claude-code` matches the name but declares nothing, and was handed a widget it cannot mount — that is what rendered "Unable to reach Graffiticode" on every `render_item`. Emits nested `ui.resourceUri` + legacy `ui/resourceUri`.
  - **`openai`** (ChatGPT/Codex) — admitted by NAME only, `isOpenAIClient()` = `/openai|chatgpt|codex/i`, because ChatGPT does not declare the UI extension; it reads `openai/outputTemplate`, which the Apps SDK documents as a compatibility alias for `_meta.ui.resourceUri`. **Same resource, same bundles** — the keys differ, the artifact does not. Also sets `openai/toolInvocation/invoking`+`invoked`.
  - **Cowork is `claude-code`.** Verified 2026-09-04 by diffing its handshake against the terminal CLI's: both send `name=claude-code`, `title=Claude Code`, `caps=[elicitation,roots]`, and NEITHER declares `io.modelcontextprotocol/ui`. They are indistinguishable at the MCP layer, so Cowork takes the `none` route and gets no inline widget — and no rule can admit it without also admitting the terminal CLI, which is the client that rendered "Unable to reach Graffiticode" when it was last handed widget metadata. The fix has to come from Cowork declaring the extension. **Do not spend time re-deriving this**; the `[widget] tools/list` log line records name, version, title and the full capability set for exactly this purpose.
  - **`none`** — everyone else: no widget/UI `_meta`, no hydration `_meta`, no widget resource in `resources/list`; just the text summary plus its "Open in Graffiticode" link. Non-widget `_meta` (`securitySchemes`) is preserved on ALL routes.

  **This supersedes the earlier Claude-only whitelist**, under which ChatGPT was deliberately served no widget for app-directory submission. Serving OpenAI became safe once the widget stopped latching on the first result and sitting on "Loading…" forever (the "stuck Generating…" bug), and a native mount that draws nothing now falls back to the content card — the worst case is the card. **Caveat worth knowing:** `/openai|chatgpt|codex/i` is the same pattern that, as a blacklist, once MISSED ChatGPT's consumer app; as an allow-list that failure mode inverts into the consumer app silently getting no widget. 30 days of `mcp_connect` events show only `codex-mcp-client` / `openai-mcp` — no consumer ChatGPT name — so which way it falls is UNVERIFIED. Only `create_item`/`update_item` are non-widget-bearing (they return "generating"); `render_item`/`get_item` carry the widget marker. There is **no** `form_url` / token-bearing render URL, and no iframe.
  - **`browser/host.ts`** — the one seam: `HostAdapter` interface with `ExtAppsHost` (Claude, wraps the ext-apps `App` class: `ui/initialize` handshake, `ontoolresult`, theme, auto-resize) and `SkybridgeHost` (`window.openai`). `createHost()` feature-detects which to use, so one build serves both hosts. The Skybridge path IS now reachable in production via the `openai` route, but has not been confirmed rendering by a person.
  - **`browser/renderer.ts`** — the shared body: unwrap the tool result; for a natively-renderable language (see `languages.ts`) **dynamic-`import()` the per-language bundle from our own origin and `mount()` the component**; otherwise render a substantive content card (question list with correct answers marked / spec prose / data preview) with an "Open in Graffiticode" footer link. The widget deliberately carries **no refine/follow-up input**: it renders inside a chat, so a text box that only forwards to `host.sendMessage` duplicates the composer the user is already typing in — refinement is a plain chat turn that routes to `update_item`.
  - **`languages.ts`** — the registry of which languages get a native bundle. **Every language the catalog lists is in it** (11 as of 2026-09-01): each ships a React `Form` view, so a listed language with no entry silently degrades to the content card, which reads as a broken render rather than a deliberate one. This replaced a `NON_RENDERABLE_LANGUAGES` set that exempted `L0158/L0176/L0177/L0170` as unrenderable — wrong on the facts (each has a `Form` in its repo's `packages/view`), and imported nowhere, so it documented a policy the code never implemented. The props contract is uniform: `Form: ({ state })` from `@graffiticode/l0000-view` plus a `./style.css` subpath. Note the view package is `<lang>-view` where one exists — `@graffiticode/l0175` is the COMPILER and has no `Form`. **None of the 8 added 2026-09-01 has been seen rendering a real item by a person**; L0169 is the cautionary case, added on a clean build and then failing to mount in production.
  - **`scripts/build-widget.mjs`** bundles `browser/entry.ts` → `dist/widget/widget.bundle.js` (inlined into the HTML) and one ESM module per native language → `dist/widget/lang/<id>.mjs` (served over HTTP, React bundled in, uniform `mount(el,data)`/`styles` export). `browser/` is excluded from `tsc`. The generated per-language entry reproduces the non-networking half of l0000-view's `View`: **`state.apply` must be a React `useReducer` dispatch**, because every `Form` in the family is CONTROLLED (l0180 keeps the response in `state.data.response` and renders ✓/✗ + "Correct — 1 / 1 point" from it on the next render). An `apply` that only mutates a closure builds, mounts and draws — and then never selects or scores anything, which is how a scoring bug hid behind a passing build. `tests/widget-native-mount.test.ts` pins this by clicking a real L0180 payload in jsdom. The converse also holds for the UNCONTROLLED spreadsheet grid (L0179/L0166): it re-seeds whenever `interaction.cells` changes identity, so the entry mirrors `View`'s no-op guard and its `formModel: "loaded"` (set per language in `languages.ts`) — without them the grid rebuilt itself in an endless loop (jitter, untypeable cells); `tests/widget-l0179-reseed.test.ts` pins it. What is still NOT reproduced: each package's language-specific reducer, and `View`'s `/compile` round trip — so a language whose feedback is computed upstream rather than in the browser stays inert (the CSP declares no `connectDomains`). L0180 ships its own scorer and is not one of those.
  - **CSP / cache** — the resource `_meta.ui.csp` declares **`resourceDomains`** (the bundle origin, `widgetAssetOrigin()`: `WIDGET_ASSET_ORIGIN`, pinned in `deploy.json`, else `MCP_SERVER_URL`; kept apart from `MCP_SERVER_URL`, which is also the OAuth issuer/resource) and **`frameDomains` = exactly `https://l0176.graffiticode.org`**, and **no `connectDomains`** (formula/chart eval is client-side). The frame domain draws OpenAI's extra review; accepted 2026-10-22 because L0176 can't render natively (Learnosity authenticates from its own iframe, runs a blob: worker, and accepts only a request signed for the page's exact hostname). **Framed languages** (`FRAMED_LANGUAGES` in `languages.ts`, L0176 only): for every L0176 item (free plan and signed in) `render_item` adds `frame_url` = `<origin>/form?source=parent` (hydration only; no task id, token or user id). The page fetches nothing: it posts `preview-awaiting-data`, and the widget answers once with the hydration `data` (the compile envelope, signed for the page's domain) to exactly that frame and origin, which is how a signed-in user's private item renders with no credential in the frame. The renderer shows the content card at once and loads the frame (with `&origin=<sandbox origin>`) behind it in a `.framed-pending` wrapper, in the viewport at opacity 0 (Chrome throttles an off-screen, `visibility:hidden` or fully clipped cross-origin frame, which then never reaches Learnosity's ready). It trusts only L0176's `preview-ready`/`preview-error` from that frame (origin AND `event.source`): ready removes the card and drops the wrapper class, revealing the frame in place (never moved, so never reloaded); an error or no ready in 20 s removes the frame and leaves the card (beacons `mounted` / `frameerror` / `frametimeout`). Card-first because a host whose CSP lacks the frame domain (the published ChatGPT app keeps its submission snapshot's CSP; Claude.ai blocks the frame) can't be detected, and frame-first showed those users a blank box for 20 s. The resource URI is **content-hashed** (`widgetResourceUris()`) because the host caches by URI — a stable URI makes the host replay a stale build. Per-language `.mjs` bundles are served from `handleRequest` with `Access-Control-Allow-Origin: *` (module scripts are always CORS-fetched from the opaque sandbox origin) and ETag revalidation.

### Implementation notes

- **Two independent stream keepalives, for two different failures.** The `CallTool` handler emits a protocol notification every 10s *during* a tool call, so a client's read timeout doesn't fire during a 60–110s generation. Separately, `startSseKeepalive` (`src/sse-keepalive.ts`, wired into both `/mcp` `handleRequest` call sites) writes an SSE comment every `SSE_KEEPALIVE_MS` into *any* open event stream — including the standalone `GET /mcp` notification stream, which carries no tool call, sends nothing on its own, and was therefore being cut by Cloudflare's 100s idle timeout (`524`). A comment is bytes on the wire but has no event id and no data, so it's invisible to the MCP layer and to stream resumability; the transport enqueues each event as one complete string, so a comment can only land between events, never inside one.
- **Conversation history.** `update_item` reads the item's `help` field (JSON array of prior user messages), builds a contextual prompt from the last 6 entries plus current `src`, calls `generateCode`, then appends a new entry and writes the updated array back. Iterative edits depend on this round-trip — don't drop the `help` write.
- **Language ID normalization.** Clients may pass `L0166` or `0166`; handlers strip the leading `L` before calling the API, and responses re-add it.
- **`create_item` flow.** Creates an empty item from the language template, then delegates to `handleUpdateItem` with the user's description — so template seeding and first-turn generation share one code path.
- **Item view links.** The native widget renders from the tool result's `data` and needs no render URL — there is no `form_url` and no token exchange. `view_url` (`${APP_URL}/form/<itemId>`, via `buildViewUrl`) is always set as the "Open in Graffiticode" secondary link; free-plan items also carry `claim_url`/`claim_message`.
- **`render_item` vs `get_item`.** `render_item` is the preferred user-facing retrieval: it waits for completion and returns a **compact** result (`item_id`, `status`, `language`, `name`, `view_url` (+ `claim_url`/`claim_message` on free-plan), summary) while isolating the language-private `src`/`data` needed to hydrate the Claude widget in `_meta.graffiticode` — hidden from the model transcript. The links are deliberately real fields, not just prose inside `summary`: non-widget clients (ChatGPT, Codex) have `_meta.graffiticode` stripped, so a link living only in the summary text would be the one thing they need and cannot address. `get_item` returns the raw `src`/`data`/metadata inline and is for programmatic clients only.

### MCP Tools (fixed set, language-agnostic)

| Tool | Purpose |
|------|---------|
| `create_item(language, description)` | Create item in any language (async; returns `status: "generating"`) |
| `update_item(item_id, modification)` | Update item (language auto-detected; async) |
| `render_item(item_id)` | Preferred user-facing retrieval — waits for completion, returns a compact result, hydrates the Claude widget (keeps `src`/`data` out of the transcript) |
| `get_item(item_id)` | Retrieve RAW `src`/`data`/metadata for programmatic clients (long-polls to completion; prefer `render_item` for normal use) |
| `get_spec(item_id)` | Platform-neutral English spec — the only sanctioned cross-language bridge |
| `list_languages(domain?, search?)` | Discover available languages |
| `get_language_info(language)` | Get language docs, examples, React usage |

- **Authoring never writes outside Graffiticode, and the seven tools stay seven.** Graffiticode is a language router: `create_item` routes and composes languages; don't split it per language or add operation tools. MCP authoring passes core a trusted `{ externalWrites: false }` (`core-backend.ts` `MCP_AUTHORING`), so the console worker records and sends no connection write for any language, composition or retry. Saving to a Learnosity item bank is a console action (`https://console.graffiticode.org/items/<item_id>`), never `update_item` (OpenAI's 2.2.0 review flagged exactly that hidden write). A deployed server (`K_SERVICE`) refuses to author outside `GRAFFITICODE_BACKEND=core`, because the GraphQL mode can't carry the marker (`assertAuthoringBackend`).
- **A tool result must be self-sufficient in `structuredContent` alone.** Claude Code and Cowork surface `structuredContent` and DROP `content[0].text` for any tool carrying an `outputSchema` — a reading the spec invites, since it says a structured result should mirror itself in the text block and ours carried prose instead. So `formatToolResult` keeps `summary` in BOTH, and every item-shaped `outputSchema` declares it (they are `additionalProperties: false`, so an undeclared field is a validation failure, not a silent extra). This is not cosmetic: the item's content and its markdown link live only in the summary, and while they lived only in the text block a Cowork answer was "Made a single-item MCQ on frog metamorphosis…" with nothing to click. The companion is the `message` field on the ready path, which says the link is for SHOWING — `view_url` alone reads as metadata and the model writes prose around it. `message` is the one lever proven to steer a model here; the generating path uses it to ask for a `render_item` call and gets one essentially every time.

### User-facing docs

The privacy and terms pages exist **twice**: as hardcoded HTML template literals in
`src/server.ts` (`PRIVACY_HTML`, `TERMS_HTML`, `ABOUT_HTML` — these are what users
actually read at `/privacy`, `/terms`, `/about`) and as `PRIVACY.md` / `TERMS.md`.
**They are matched pairs — change both together.** They previously drifted: the
markdown gained a "Usage Analytics" section that the served page never got.

Anything asserted in the privacy copy must trace to real behavior: `src/events.ts`
for what is logged (metadata only; never the prompt, never the client IP) and
`src/oauth/firestore-store.ts` for what is persisted (OAuth records include the
user's email plus access/refresh tokens). Also keep the tool list in sync in three
places: `ABOUT_HTML`, `MCP_DISCOVERY`, and `README.md`.

### Environment Variables

- `GRAFFITICODE_CONSOLE_URL` - Console GraphQL API endpoint (default: `https://console.graffiticode.org/api`). Note this ends in `/api`.
- `GRAFFITICODE_CONSOLE_BASE_URL` - Console bare host used to build user-facing claim URLs (default: `https://console.graffiticode.org`).
- `GRAFFITICODE_API_URL` - Graffiticode API host. Serves language templates and backend code generation (default: `https://api.graffiticode.org`).
- `GRAFFITICODE_APP_URL` - App host used to build user-facing item view links (`/form/<id>`) (default: `https://app.graffiticode.org`).
- `GRAFFITICODE_AUTH_URL` - Auth endpoint (default: `https://auth.graffiticode.org`).
- `GRAFFITICODE_SKILLS_REPO` - Public GitHub repo (`owner/name`) discovered at request time to serve agent skills as MCP resources (default: `graffiticode/graffiticode-app`).
- `GRAFFITICODE_SKILLS_SUBDIR` - The directory in that repo holding one directory per skill (default: `packages/skills`; empty for a repo of skills alone).
- `GRAFFITICODE_SKILLS_REF` - Git ref/branch for skill discovery (default: `main`).
- `GRAFFITICODE_SKILLS_TTL_MS` - Skill catalog cache TTL in ms (default: `60000`).
- `FREE_PLAN_NAMESPACE_SALT` - Shared HS256 secret used to mint trial-claim JWTs. **Must be the identical value the console deploys with** — both come from the same Secret Manager entry populated by the console's `scripts/set-free-plan-secrets.sh`. Here it is mounted by gc-deploy at the version pinned in `deploy.json` (`mcp` and `openapi` both pin it), while the console mounts `:latest` out-of-band (`set-free-plan-secrets.sh`). After a rotation, bump the pinned version for `mcp` and `openapi` and deploy both, or this service and the console will hold different salts and claim links will fail. If unset, trial responses still succeed but omit `claim_url`/`claim_message` (single warning logged at startup).
- `OPENAI_APPS_CHALLENGE_TOKEN` - Token served **verbatim** (exact bytes, no JSON/prefix) as `text/plain` with `Cache-Control: no-store` at `/.well-known/openai-apps-challenge`, for OpenAI app-directory domain verification. OpenAI fetches it from the **root of the registered host** (`mcp.graffiticode.org`; the `/mcp` path is ignored). Set it on the **already-tested image** at submission time — `gcloud run services update mcp-service --update-env-vars=OPENAI_APPS_CHALLENGE_TOKEN=<token>`, then move traffic to the new no-traffic revision (see Deploy) — then verify in the portal. The route **404s while unset**, so it's inert until submission. Pure seam in `src/challenge.ts`.
- `SSE_KEEPALIVE_MS` - How often to write an SSE comment into an open `/mcp` event stream, in ms (default: `30000`; `0` disables). Cloudflare cuts an idle streaming response at 100s, and a client's standalone `GET /mcp` notification stream is idle by nature — clients saw `StreamableHTTPError: Failed to open SSE stream … code: 524` and reconnect churn. See `src/sse-keepalive.ts`.
- `PORT` - HTTP server port (default: 3001).

### Trial-claim JWT (free-plan only)

Free-plan `create_item` and `update_item` responses include three extra fields so the user can transfer the item into a real Graffiticode account on first sign-in:

- `view_url` — `${APP_URL}/form/<id>`
- `claim_url` — `${CONSOLE_URL}/claim?token=<jwt>&src=chat&agent=<host>`
- `claim_message` — two lines: the URL, then a reconnect hint chosen for `<host>`

`src` attributes the click (chat link vs render-host footer). `agent` is the coarse
host bucket from `classifyClientHost` (`claude-code` | `claude-app` | `openai` |
`editor` | `unknown`) — never the raw `clientInfo.name` — so the claim page opens on
the right connect instructions instead of asking someone who just signed in to
identify their own agent. **This repo owns that taxonomy**; adding a bucket means
adding it here first, then teaching the console's `ConnectAgentInstructions`. It is
`agent=` and not `client=` because the console already reads `?client=` app-wide as
the item source surface (`console|mcp|front`).

The reconnect hint exists because a claimed user is still connected *anonymously* —
their next item lands back in a trial workspace. What fixes that differs by host:
`claude-code`/`editor` take an `Authorization` header, so they're pointed at the key
the claim page mints; `claude-app`/`openai` connector UIs have no header field, so
until `OAUTH_RECONNECT_ENABLED` is on they are told plainly that new items keep
starting out anonymous rather than sent at a sign-in that isn't offered yet.

The JWT contract (defined in `src/claim-token.ts` and verified by the console at `console/src/lib/claim-token.ts`):

- HS256, secret = `FREE_PLAN_NAMESPACE_SALT` (UTF-8 bytes)
- Audience: `graffiticode-claim`
- Expiry: 24h
- Payload: `{ sessionNamespace, sessionUuid }` where `sessionNamespace = sha256(salt + ":" + sessionUuid)`

The `sessionUuid` comes from the MCP transport's session id (set during the MCP `initialize` POST and read off the free-plan auth context as `auth.sessionId`).

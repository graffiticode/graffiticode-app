# Installations: one open-source frontend, independently branded and tooled

## Context

`graffiticode-app` becomes a reusable frontend product, in the way Discourse is: one open-source codebase, run as independent *installations*. Each installation supplies its own branding, legal content, service catalog, storage and credentials. Graffiticode is the first installation and Artcompiler (Learnosity services) the second.

`artcompiler-app` is dropped, and the earlier plans for it are superseded. The work that was in flight is reused:
- **Kept:** the service-job core that is already merged (`packages/core/src/service-*.ts`).
- **Generalized:** the uncommitted `/learnosity/mcp` work (`packages/mcp-server/src/learnosity.ts`, `core/src/service-runner.ts`) becomes a service-tool family that profiles select.

Two surveys this session found:
- **Hard-coded branding.** About 250 brand mentions and about 55 hard-coded hosts. The biggest concentrations are `mcp-server/src/tools.ts`, `mcp-server/src/server.ts` (HTML pages, discovery) and `core/src/lib/languages.ts`.
- **Single-deployment assumptions:**
  - fallbacks to the `graffiticode-app` project;
  - `PRODUCTION_PROJECT`;
  - one trusted console identity for act-as and Policy;
  - a global MCP OAuth store behind `INTERNAL_API_KEY`;
  - `NEXT_PUBLIC_*` values compiled into the browser bundles.

**Principles** (from review):
1. **An installation is the whole frontend system.** Console, views, MCP, A2A, REST and background workers share one configuration and one application database. In-process `core` shares implementation, never items, jobs or projects across installations.
2. **Profiles are external, versioned and declarative.** The repo owns the schema, the capability registry and the validator. Operators own their profiles elsewhere. Every release records the app version and the profile version together. A running job keeps the service definition it started under.
3. **Profiles select capabilities; code defines them.** "Implemented", "writes externally" and the authorization a capability needs come from registered code, never from a profile. Selection is enforced when a request is executed, not only when the catalog is listed.
4. **The data boundary is explicit:** database, queues and worker routing, storage, schedulers and credentials. Which backend resources are shared is a separate, recorded decision.
5. **The authorization server and the protected resource are distinct.** Each installation's endpoints are resources of their own, and every token is bound to its resource (RFC 8707). Shared Graffiticode authentication is a per-installation setting.
6. **Same release, not necessarily one image.** Public configuration reaches browser bundles at runtime, not through `NEXT_PUBLIC_*`.

**Acceptance test:** Graffiticode and Artcompiler run from the same release with external profiles and separate databases. Their catalogs, links, authentication and background jobs each stay inside their own installation.

## Decisions (defaults; confirm or change)

- **D-I1. Operators.** Installations run by us first. The backend tells installations apart by registered client identity, designed so that third parties can register later.
- **D-I2. Accounts.** Graffiticode authentication is shared by our installations, set as an installation setting. Items, billing and usage live in each installation's database. Other identity providers come later.
- **D-I3. Backend resources.**
  - **Shared and installation-aware:** the API and compilers, Policy and the Broker, command and execution records. Each is tagged with the calling installation's client identity, which D-3 (the issuer of the scope claim) already requires.
  - **Per installation:** billing (its own Stripe account or products).
  - **Connections are an open decision.** Today Policy keys a user's connections by uid. Either they are visible in every installation the user signs into, or they are scoped to the installation that created them. The default is scoped, as the safer choice.
- **D-I4. Profile delivery.**
  - A profile is a directory in its own repo: `profile.json`, assets, legal Markdown, and copy templates.
  - gc-deploy fetches it at a pinned ref, validates it, and mounts it for the servers.
  - Its digest is recorded in the release receipt.
  - Browser bundles read the public subset from the installation's `/config` at runtime.

## Phases

### P1. Profile schema, loader and validator (`graffiticode-app`)
- **Schema.** `packages/core/src/profile/` holds the versioned JSON Schema and types, with these sections:
  - `installation`: id, production flag, project;
  - `brand`: names, operator, assets, legal docs;
  - `hosts`: every public origin, plus the language-server pattern;
  - `auth`: authorization server issuer and the installation's resource ids;
  - `catalog`: the installation's policy over the platform's languages: which are offered, hidden and discoverable, and who sponsors them (the free-plan allowlist is `freePlan.languages`);
  - `services`: service definitions that reference capability ids;
  - `surfaces`: which MCP endpoints and tool families, A2A on or off, REST;
  - `copy`: templates for instructions and tool descriptions;
  - `billing`: plans and Stripe price ids;
  - `freePlan`.
- **Loader.** `loadProfile(path)` runs once at startup and hangs the profile off `coreConfig()` (`core/src/config.ts`, which already supports injection through `setCoreConfig`).
  - The host settings currently spread over 10+ env vars (`CONSOLE_URL`, `GRAFFITICODE_CONSOLE_*`, `MCP_SERVER_URL`, `NEXT_PUBLIC_GC_*`, ...) collapse into `profile.hosts`.
  - Env stays only for secrets and runtime wiring.
- **Validator.** A `gc-profile validate <dir>` CLI checks the schema, checks the profile against the capability registry (P4), and confirms that every referenced asset and document exists.
- **Release receipt.** It records `{appVersion, profileRepo, profileRef, profileDigest}` (gc-deploy, `deploy.json`).

### P2. Extract Graffiticode as the first profile, with no behavior change
- Create the external profile repo, for example `graffiticode/installation-graffiticode`. It contains:
  - today's copy: `SERVER_INSTRUCTIONS`, tool descriptions, privacy, terms and about pages, `MCP_DISCOVERY`, OpenAPI `info`;
  - today's hosts and assets;
  - today's catalog *policy*, not the catalog entries.

  **Catalog boundary (decided).** What a language is stays in code: its description, routing hint, keywords, vendor gate and brands, composition permissions, internal and deprecated status, and the provider it writes to (`core/src/lib/languages.ts`, `connectable.ts`). An installation's profile only decides, over those languages:
  - which are offered (listed, discoverable, creatable; others still resolve by id for existing items);
  - which are hidden;
  - the discovery floor and its exceptions;
  - sponsors;
  - the free-plan allowlist (`freePlan.languages`: absent means every offered language, an explicit `[]` means none).

  Brands are recognized platform-wide, so a request or search naming a vendor the installation doesn't offer is refused rather than routed to a generic language. Sponsorship never changes deprecation.

  **Completion note (amended).** The catalog slice's worker-side enforcement, the router refusing an unavailable vendor, runs in the console's generation worker. It is complete only from the console-loading gate below on: before that, only the MCP and REST processes loaded the profile.
- **Console server loading (prerequisite, verified on its own before billing settings).** The console's server, its API routes and its generation worker all load the installation:
  - **Initialized before any policy work.** `instrumentation.ts` `register()` loads and validates the profile at startup with a Node-only dynamic import, and exits on failure. API and worker entry points that do policy work are wrapped in an idempotent guard (`console/src/lib/with-installation.ts`).
  - **Fail closed, pinned.** With `PROFILE_DIR` set, reading the profile before it is installed throws (`core/src/profile/current.ts`), so no route falls back to built-in policy; a guarded route that can't load it answers 503. The profile is pinned for the server's life: re-initialization reuses it, and a different `PROFILE_DIR` is an error. Installation state is process-wide (on `globalThis`), because the console's build inlines core into its chunks and module instances aren't guaranteed to be shared.
  - **Read at use time.** Profile-dependent constants (`PLANS`, the free-plan item lifetime) become accessors in the billing slice, and their callers are checked for values captured earlier.
  - **Gate (`npm run test:installation-build`):** one production build, started with no profile and with two distinct profiles: each server's startup log and `/api/health` receipt, the GraphQL route's catalog search, `/api/generate`'s router refusal of an unavailable vendor (the worker's generation path), the queue worker route's installation header, and an invalid profile stopping the start.
- Replace the literals in, among others:
  - `mcp-server/src/tools.ts` and `server.ts`;
  - `openapi-server/openapi.yaml` and `problems.ts`;
  - `free-plan-*.ts` and `plans-config.ts`.

  Console and app metadata moved to P3 (see there): both are Next.js builds whose pages are prerendered at build time, so their metadata can only follow a runtime profile through P3's browser configuration.
- Generate the static discovery files (`app/public/llms.txt`, `.well-known/mcp.json`, `skills/plugin.meta.json`) from the profile.
- Leave wire identifiers alone: `Graffiticode-Workspace` headers, the `graffiticode://` and `ui://graffiticode` URIs, storage keys, `@graffiticode/*` package names, and the DSL name in code-generation prompts.
- **Parity gate.** Snapshot tests taken before and after extraction must match byte for byte:
  - MCP `tools/list` and instructions;
  - the HTML pages and discovery JSON;
  - the OpenAPI document.

  `eval:routing` must also be unchanged. **Pending gate:** it makes paid model calls and hasn't been run for P2. Its script (`packages/mcp-server/scripts/eval-routing.ts`) must also load the selected profile (`PROFILE_DIR`) before it can check profile-specific routing; until then it measures the built-in installation only.

### P3. Installation isolation (`graffiticode-app`)
- **All Firestore access goes through `core/src/db.ts`.**
  - Fix the modules that bypass it: `core/src/utils/db/index.ts` and `app/src/server/db.ts`.
  - Remove the `graffiticode-app` and `graffiticode` project fallbacks (`utils/db/index.ts:18`, `config.ts:19`). A missing project becomes a startup error.
- **`PRODUCTION_PROJECT`** (`core/src/generation-protocol.ts:78`) becomes `profile.installation.production`.
- **The browser bundles' public configuration is served at runtime** from `/config`:
  - Firebase web config (`console/src/lib/firebase.ts`, `auth-react/src/firebase-config.ts`);
  - Privy app id, Stripe publishable key, hosts and brand.

  This removes those `NEXT_PUBLIC_*` values from the build. `/config` never carries security policy.
- **Console and app metadata follow `/config` in the browser** (moved from P2). The console has no `_app.getInitialProps` and no page uses `getServerSideProps`, so Next prerenders every page, `_document` included, at build time; the app package is prerendered the same way. Metadata can't come from a profile loaded at server start without rendering per request, and branding alone doesn't justify that cost. So:
  - **One owner for titles and descriptions.** After `/config` loads, a single client component sets the document title and the meta description, and keeps them right across client-side navigation. `_document` and per-page `next/head` stop setting competing descriptions; the host-sniffing `getTitle()` (`console/src/lib/utils.ts`) goes away.
  - **Fixed asset URLs, runtime assets.** `/favicon.png`, `/logo.png` and the app's icons keep their URLs, so the initial HTML is unchanged. A `beforeFiles` rewrite routes each to a handler that serves the installed profile's asset, falling back to today's file when no profile is installed.
  - **Pricing display follows `/config` here too** (`console/src/utils/plans.ts`). Until it does, installations must not activate different commercial terms: checkout, quota enforcement, the advertised prices and Stripe's configured prices must agree.
  - **Default metadata in the initial HTML is accepted.** Crawlers and link previews see the build's defaults. If a public page later needs accurate link previews, that page renders per request (`getServerSideProps`); the console as a whole doesn't.
- **Security headers are set by the server from the loaded profile**, on every document response, independent of `/config`:
  - **Console and app:** the CSP and related headers are set from Next.js middleware per request, with sources derived from `profile.hosts`. The static CSP in `console/next.config.mjs` goes away.
    - **Extraction keeps today's mode.** The console currently sends `Content-Security-Policy-Report-Only` (`next.config.mjs:53`). P3 keeps report-only and keeps every source it lists today, including the third-party sources that sign-in, payments and rendering rely on: Privy, Stripe, the auth host, the L0176 frame host.
    - **The mode is a profile setting:** `csp.mode`, `report-only` or `enforce`. The Graffiticode profile starts as `report-only`.
    - **Enforcement is a separate, later gate per installation**, opened only after violation reports have been reviewed and browser checks pass for sign-in (email and wallet), Stripe checkout and setup, item rendering, and the L0176 frame.
  - **MCP server:** headers on its HTML pages, and the widget's `_meta.ui.csp` (`widget/index.ts`), derived from the same hosts.
  - **Origin allowlists move to the profile:** the OAuth consent page's `*.graffiticode.org` origin regex (`console/src/pages/oauth/consent.tsx:41`) and `front/token.ts`'s allowed origin.
- **The data boundary is listed per installation:**
  - the Cloud Tasks queue and worker URL (`GENERATION_*`);
  - scheduler jobs;
  - storage bucket (replacing the `graffiticode.appspot.com` uploads);
  - service accounts;
  - secrets (`INTERNAL_JOB_SECRET`, `FREE_PLAN_NAMESPACE_SALT`, `ACT_AS_GRANT_SECRET`, Stripe, OpenAI);
  - seeding the RAG corpus and writing the protocol floor.
- **`docs/gcp-bootstrap.md` becomes a parameterized `scripts/bootstrap-installation.sh`**, covering project, Firestore, indexes, TTL policies, queues, scheduler, service accounts and IAM. The 36 console and shell scripts that name the project take it from the installation instead.
- **`deploy.json` gets one gc-deploy environment per installation** (`environments.<id>`, with per-service overrides). The settings applied by hand today (`POLICY_URL`, Stripe prices, sizing) move into it.

### P4. Capability registry, pinned definitions and the service-tool family (`graffiticode-app`)
- **Registry in code.** `core/src/capabilities.ts` registers each implementation as `{id, implemented, externalWrites, requiresExecution, authorization, deliverables, handler}`. Examples: `generate-content`, `plan-data-job`, later `save-revision`.
- **Profiles reference capabilities.** A profile's service definition names skills and points each at a capability id, with its languages and copy. The validator rejects:
  - an unknown or unimplemented capability;
  - a writing capability before execution is ready;
  - a capability whose authorization the installation can't satisfy.
- **Admitting new work is separate from replaying or continuing existing work.**
  - `createServiceJob` first resolves an existing, live idempotency binding for `(scope, key)` that belongs to the caller. If one exists, it returns that job, whatever the current profile selects. This fixes today's order (`core/src/service-jobs.ts`), where the availability check runs first and so blocks a same-key retry after a skill is deselected.
  - Only a new job is checked against the current profile and the registry.
- **Deselecting a skill in the profile blocks new jobs only.** Existing jobs continue under their pinned definition: steps already started, answers to their questions, settlement and completion. `job_get` and `job_cancel` are always available for existing jobs, whatever the profile says.
- **Withdrawing a capability is a different, operator-only action**, a registry kill switch for safety, not a profile edit. It stops *new step starts*. Jobs that have no step in flight end `failed` with reason `capability-withdrawn`. Backend executions already in flight still settle under their own contracts, and status and cancel stay available.
- **Definitions are pinned per job.** The envelope already carries `serviceVersion`. It gains `definitionDigest` and a snapshot of the definition it started under, and completion is judged against that snapshot.
- **The Learnosity definitions move out of code.** `LEARNOSITY_AUTHORING` / `LEARNOSITY_DATA` leave `core/src/service-registry.ts` and go to the Artcompiler profile. `service-registry.ts` then serves definitions from the profile.
- **`learnosity.ts` becomes the generic service-tool family** (`mcp-server/src/service-tools.ts`). Tools are generated from the profile's skills: names, descriptions and output schema come from the definitions, and `job_get` / `job_cancel` are shared.
  - It keeps the runner (`core/src/service-runner.ts`), the write-free generation path, and the uncommitted tests, which get generalized.
  - Each profile's `surfaces` decides which endpoints serve which families: generic item tools, service tools, or both.
- **A2A cards** (M4) and discovery files come from the same definitions.

### P5. Authentication boundary (`graffiticode-app` and backend `graffiticode`)
- **Separate the issuer from the resource.**
  - `mcp-server/src/oauth/handlers.ts` (lines 21-36), `introspection.ts` and `openapi-server/src/oauth.ts` read `profile.auth.issuer` separately from `profile.auth.resources`.
  - Protected-resource metadata, `ALLOWED_RESOURCES` and the token audience check are driven per installation and resource.
  - A token issued for one installation's resource fails everywhere else.
- **The OAuth store moves into each installation's database.** The installation becomes the OAuth server for its own resources and delegates sign-in to the shared authentication. Today the store lives on the auth service behind `INTERNAL_API_KEY` (`mcp-server/src/oauth/firestore-store.ts`). A token missing from the store reads as revoked, and refresh needs the store, so the cutover must be a compatible migration, not a relinking rollout:
  - **Clients first.** A copy script moves registered clients (`oauth-clients/`) for the Graffiticode installation before cutover, so existing `client_id`s keep working and new authorization flows start normally.
  - **Dual read, local write.** After cutover, every new code, access token and refresh token is written locally. Lookups read local first, then fall back to the legacy auth-service store. The fallback applies to the Graffiticode installation only; a new installation has none.
  - **Writer handoff: the legacy store gets a fence at the source.** A local claim alone can't stop an old MCP revision rotating the same token in the legacy store. So the auth service gains a per-installation *migration fence*, set before cutover.
    - **Once set, it refuses every legacy-path write for that installation:** token rotation, issuing or consuming a code, and token writes or deletes through the ordinary flow-store GET/PATCH/DELETE routes. Reads continue.
    - **The only writes it accepts after the fence** are new conditional migration operations:
      - `consumeCode(hash)`: atomic single use;
      - `markMigrated(hash, mode, claimId)`: a compare-and-set with three outcomes:
        - **`applied`**, for the first mark;
        - **`applied` again** when the record already carries the *same* `claimId`, an idempotent acknowledgement, so a commit whose response was lost can be recovered;
        - **a definitive refusal** when the record is revoked, or already marked with a different claim.

        Transport errors and 5xx responses are transient, never a refusal.
      - `revoke(hash)`.

      These are new transactional operations on the auth service. Today's flow store has no single-use or compare-and-set semantics.
    - **Old revisions are drained too.** Tag-addressed revisions stay reachable at their own URLs even after gc-deploy pins traffic, so the cutover runbook untags or deletes every MCP and REST revision older than the dual-read release before the fence is set. The fence is what guarantees safety; draining limits the errors that old revisions would otherwise surface.
    - **Order:**
      1. deploy the dual-read release everywhere;
      2. drain old revisions;
      3. set the fence;
      4. start new-path legacy claims and the inventory import.
  - **Each local record keyed by a legacy token's hash has exactly one migration record.** It is created in a single local transaction, create-if-absent, so a refresh claim and an inventory import exclude each other. Each record has a mode (`rotation` or `import`) and a state. **Only a source confirmation activates a credential.**
    - **`prepared`:** the local transaction records the `claimId` and the mode.
      - For a rotation, it also records the one replacement pair, generated inside that transaction.
      - For an import, it also records a copy of the original token's record.
      - A prepared credential can't authenticate, and no refresh response carries it. Lookups treat it as not yet valid: they neither fall back to the legacy store nor accept the prepared copy.
      - The original legacy refresh token is no longer honored through the fallback once a record exists.
    - **`confirmed`:** `markMigrated(hash, mode, claimId)` returned `applied` at the source, so the credential activates.
      - For a rotation, the recorded pair is now valid, and it is what the waiting refresh, any concurrent refresh, and any retry receive.
      - For an import, the original token now resolves locally through both the access-token and refresh-token lookups. A later refresh of it is an ordinary local refresh.
    - **`tombstoned`:** the source gave a definitive refusal (revoked, or already marked by another claim), or the source record was already consumed or orphaned. The credential never becomes live. A refresh that was waiting gets `invalid_grant`.
    - **Transient failures leave the record `prepared` and recoverable.**
      - A refresh that hits a transient failure answers with a retryable error (`temporarily_unavailable`). The client's retry finds the same claim and re-runs the confirmation with the same `claimId`.
      - A sweeper drives any record stuck in `prepared` to `confirmed` or `tombstoned`.
    - **No overwrites.** An import never overwrites an existing record, whatever its state. An import that finds the source revoked, or marked by another claim, ends `tombstoned`, or leaves the existing record as it is.
    - **Revocation during the overlap** goes through `revoke(hash)` at the source and updates the local record, whichever store the credential currently lives in.
  - **Legacy authorization codes are consumed at the source.** Exchanging a code found through the fallback first calls `consumeCode(hash)` on the auth service, which is the authority on single use, and only then issues tokens. A local tombstone keyed by the code's hash records the result. Pending authorizations are completed the same way.
  - **Retiring the fallback depends on an inventory, not on time.** Legacy refresh tokens have no expiry (none is set or checked in `oauth/handlers.ts`), so quiet metrics prove nothing about dormant credentials.
    - The inventory job lists the legacy store's live refresh tokens, live access tokens and clients for the Graffiticode installation, and imports them as above. Clients are copied in the same pass.
    - The fallback is retired only when a re-run of the inventory finds no record that isn't marked migrated or revoked at the source. Until then it stays.
  - **Introspection follows the same lookup.** REST (`openapi-server`) resolves tokens through the MCP introspection endpoint (`oauth/introspection.ts`).
- **Installation context, carried end to end** (backend work in the `graffiticode` repo, alongside D-3 in `execution-observation-plan.md`). Registering an installation doesn't isolate anything on its own. Every backend request must carry an *authenticated* installation context, and every check must enforce it:
  - **Authentication.** Each installation's service accounts call the API with their own Google identity, next to the user's token. The API resolves the caller against a client registry (`installationId`, service accounts, item-authority endpoint and audience, enabled roles). A user token alone, or an unregistered caller, gets no installation context: frontend command routes refuse it, and existing public routes keep today's behavior.
  - **Propagation.** The API passes `installationId` to Policy as an attested field. Policy accepts it only from the API's own identity, never from request input.
  - **Enforcement in Policy:**
    - **Allocation:** `installationId` joins the command's immutable admission binding, beside identity, principal, connection, digests, deadline and the D-3 scope digest.
    - **Key namespaces keep Graffiticode's existing lookups.**
      - `graffiticode` keeps today's derivation exactly. Command ids, key-allocation records and save keys still derive from `(uid, key)` with no prefix, so every key issued before the change finds its existing record.
      - Every other installation derives from `(installationId, uid, key)`. No other installation existed before the change, so the two derivations can't collide.
      - The admission check still compares the stored `installationId` (absent means `graffiticode`). A non-Graffiticode caller can therefore never reach an unprefixed record, even by constructing its key.
      - No alias records or rewriting of keys are needed.
    - **Reads** (`GET /command/:id`, its evidence, ledger and reconciliation records) need both a matching uid and a matching installation. A mismatch reads as `command-not-found`, keeping FAIL-01's existing classification.
    - **Replay, repair, materialize, reconciliation and dispatch** inherit and must match the original's installation.
    - **Runs and save heads** (D-2, D-5) carry the installation in the same binding, keyed so installations never share a head.
    - **Connections** are scoped to their creating installation (D-I3). Using another installation's connection is refused.
  - **Item authority.** C5's item-authority callback (`console/src/lib/item-authority.ts`, `DEFAULT_AUDIENCE`) is selected from the registry entry of the record's installation, never one fixed console.
  - **Act-as.** Grants carry the installation claim, with one secret per installation (`core/src/act-as.ts`; today there is one global secret and one caller). The auth service refuses a grant presented by a different installation's service account.
  - **Credentials.** Each installation gets a scoped credential in place of the shared `INTERNAL_API_KEY`.
  - **Existing untagged records** (commands, ledger entries, connections, save keys) belong to `graffiticode`.
    - Until a backfill tags them, an absent tag is read as `graffiticode` and matches no other installation.
    - The backfill is idempotent and verified by count.
    - Records written by a release that doesn't know about installations are refused for other installations by the same rule.
  - **Rollout guard.** Command records carry a required-capability marker, as D-3's do. Policy releases and workers that can't enforce installation context fail closed on them. The deploy tool refuses a rollback below that floor once a tagged record exists.

### P6. The Artcompiler installation: the acceptance test
- **Gate.** P6 starts only after:
  - P5's backend installation context is deployed: enforcement, untagged-record handling, the rollout guard, per-installation item authority and act-as;
  - the OAuth migration has cut over for Graffiticode.
- Create the profile repo in the Artcompiler project, for example `artcompiler/installation-artcompiler`:
  - Assessments branding, Artcompiler legal content;
  - the Learnosity services, selecting `generate-content` and `plan-data-job`;
  - surfaces: service tools on `/mcp`, and generic tools if wanted.
- Bootstrap a new GCP project with `bootstrap-installation.sh` and deploy the *same release* with `--env artcompiler`.
- Update the Assessments discovery generator (`artcompiler-assessments/scripts/generate-agent-discovery.mjs`) to consume the profile's discovery output. This also fixes the three mismatches found earlier.

## Verification

- **P1:** schema and validator unit tests. A profile is rejected when it:
  - is missing an asset;
  - references an unknown capability;
  - marks an unfinished capability implemented;
  - selects a writing capability early.
- **P2:** the parity snapshots match; the full baseline, `core`, `mcp-server` and `openapi-server` suites pass unchanged. `eval:routing` is a pending gate (see P2): run it, with the eval script loading the selected profile, before the first production profile deployment.
- **P3:**
  - a test (or lint rule) that only `core/src/db.ts` creates a Firestore handle;
  - startup fails without a project;
  - the console and app render brand and hosts from `/config` with no `NEXT_PUBLIC_*` brand values;
  - the Graffiticode console's CSP header after extraction matches today's byte for byte: still `Content-Security-Policy-Report-Only`, with the same sources;
  - document responses carry the CSP header in the mode the profile sets, built from the profile's hosts. This is asserted on the actual response headers of the console, the app and the MCP HTML pages, for both test profiles. `/config` contains no CSP;
  - the bootstrap script, dry-run against a scratch project;
  - **console and app metadata, with two profiles against one build, plus no profile:** after `/config` loads, the document title and meta description are each installation's, and stay correct after client-side navigation, with exactly one meta description in the document; `/favicon.png` and `/logo.png` (and the app's icons) return each profile's asset bytes and content type, and today's files with no profile; the initial HTML is byte-identical across the three.
- **P4:**
  - a job keeps its pinned definition after the profile changes;
  - after a skill is deselected:
    - a *new* job for it is refused;
    - a same-key retry still returns the recorded job;
    - an existing job continues to completion under its pinned definition;
    - `job_get` and `job_cancel` work throughout;
  - withdrawing a capability stops new step starts and fails jobs with no step in flight with `capability-withdrawn`. A step already in flight still settles;
  - the service tools generated from a test profile pass the ported `learnosity-mcp` and `service-runner` tests.
- **P5:**
  - a token issued for installation A's resource is refused by B's MCP and REST;
  - protected-resource metadata is correct per installation;
  - an act-as grant from A is refused when presented as B;
  - backend tests for the client-identity registry.
  - **One user, two installations** (backend tests, same uid in A and B):
    - the same idempotency key yields two separate commands;
    - B's read, replay, repair, materialize, reconciliation and dispatch of A's command all fail as `command-not-found`;
    - A's connection is refused in B;
    - item-authority callbacks for A's records reach A's endpoint only;
    - a request with no installation context is refused on frontend command routes.
  - **Original keys after cutover.** Retrying a save key issued before the change through the Graffiticode installation returns the same execution id and the same protocol (`legacy` or `command`), with zero provider writes. This covers a completed save, a failed one (retried only through its own path), and a queued `connection_write`.
  - **Untagged records:** a record written before the change is readable and replayable by `graffiticode` and invisible to B, both before and after the backfill. An older worker fails closed on a tagged record, and a rollback below the floor is refused.
  - **OAuth migration** (Graffiticode installation):
    - a client registered before cutover can start a new authorization;
    - an access token issued before cutover still works on MCP and on REST (through introspection);
    - a legacy refresh token yields exactly one local pair:
      - concurrent refreshes of the same legacy token all receive that same pair;
      - a crash after the claim and before legacy revocation leaves the legacy token unusable through the fallback, and the sweeper completes the revocation;
      - a crash during the claim transaction leaves no claim, and a retry succeeds;
    - **Writer fence:**
      - with the fence set, an old-revision refresh or code exchange through the legacy routes is refused;
      - concurrent old-path and new-path refreshes of the same token end with exactly one valid successor credential;
      - before the fence, the runbook check finds no revision older than the dual-read release still reachable.
    - **Codes:** a legacy authorization code exchanged through the fallback works once. A second exchange is refused, including two simultaneous exchanges racing at `consumeCode` and an exchange through the legacy path.
    - **Import vs rotate:**
      - an import never overwrites a rotation: rotate first and then import, or race the two, and the record ends `rotated` with the recorded pair;
      - importing a revoked or already-migrated source record never produces a live credential;
      - an imported credential resolves through both the access-token and the refresh-token lookups, works on MCP and on REST, and keeps the original token;
      - a crash after the local import and before `markMigrated` is completed by a re-run without duplicating anything;
    - **Preparation and confirmation:**
      - a prepared rotation or import authenticates nothing and returns no tokens;
      - a source revocation landing between preparation and confirmation ends the record `tombstoned`. The prepared pair, or the imported token, never authenticates, and the waiting refresh gets `invalid_grant`;
      - **lost acknowledgement:** the source commits `markMigrated`, but the response is lost. The retry with the same `claimId` is acknowledged as `applied` and the credential activates exactly once;
      - a transient source failure leaves the record `prepared`, answers `temporarily_unavailable`, and the client's retry or the sweeper confirms it;
      - the fallback stays until a re-run of the inventory finds nothing unmigrated;
    - a token revoked before cutover stays revoked;
    - a token that exists in neither store is refused;
    - the Artcompiler installation has no fallback.
- **P6 acceptance**, both installations deployed from one release:
  - their `tools/list`, discovery files and links differ as their profiles specify;
  - jobs, items and queue tasks appear only in their own installation's database;
  - cross-installation tokens fail;
  - a generation started in Artcompiler runs on Artcompiler's queue and worker.

## Order and handling of the in-flight work

1. Park the uncommitted `/learnosity/mcp` work on a branch (`wip-learnosity-endpoint`), unmerged. P4 generalizes it.
2. Then P1 → P2 → P3. P5's frontend part can run in parallel with P3; its backend part follows the `graffiticode` repo's C5a and D-3 sequencing.
3. Then P4 → P6.
4. Update `graffiticode/docs/execution-observation-plan.md` so that W6 and W7 sit on top of installations, and D-3's issuer is the installation's client identity.

Commits and merges happen only when you ask.

## Tracked items

- **gc-deploy release receipt (before the first production profile deployment).** P1 provides `profileReceipt()` (`packages/core/src/profile/load.ts`), but gc-deploy is vendored here (`vendor/graffiticode-deploy-0.1.0.tgz`). Its own repo needs to fetch the profile at a pinned ref, run `npm run profile -- validate`, mount it as `PROFILE_DIR`, and record `{appVersion, profileRepo, profileRef, profileDigest}` in the release receipt. Until then, services report the receipt from `/health`.
- **External profile repos.** P2 builds the Graffiticode profile locally; `graffiticode/installation-graffiticode` is created later.
- **Before deploying the hosts slice, check each live service's environment.** Host resolution (`packages/core/src/profile/hosts.ts`) now treats two variables naming the same host differently as a startup error, even without a profile (for example `CONSOLE_URL` and `GRAFFITICODE_CONSOLE_BASE_URL`, or `MCP_SERVER_URL` and `MCP_OAUTH_URL`). `deploy.json` is consistent, but variables set out of band on the Cloud Run services aren't visible from the repo: compare `gcloud run services describe <svc> --format='value(spec.template.spec.containers[0].env)'` for mcp, openapi and console against those pairs first.
- **Routing eval (pending gate).** `npm run eval:routing` makes paid model calls and hasn't been run for P2. Before the first production profile deployment: teach `packages/mcp-server/scripts/eval-routing.ts` to load the selected profile (`PROFILE_DIR`, through `loadInstallation`), then run it for the Graffiticode profile, and for any installation that restricts its catalog.
- **Free-plan scope in REST `/me` (done in the billing and free-plan slice).** `free_plan.languages_restricted` says whether `languages` is the whole allowlist (true, possibly empty) or unrestricted (false, with `languages` empty).
- **Billing and free-plan settings (P2).** Read through accessors at use time (`plans()`, `getPlan()`, `freePlanItemTtlMs()`, `freePlanEnabled()`); no caller captures them at import. A profile may state each plan's commercial terms (`billing.plans`), but tiers, hard caps and Stripe wiring stay code, and `COMMERCIAL_TERMS_CONFIGURABLE` (false) makes the validator refuse terms that differ from the code's until P3's pricing display and a check against Stripe's configured prices land. `freePlan.enabled` must be true for anonymous use; a profile without a `freePlan` section has none, and anonymous requests are refused (`free_plan_disabled`). `freePlan.itemTtlHours` sets the item lifetime; free-plan session tokens still expire at 48 hours.
- **Discovery files: recorded correction (P2, discovery).** The committed `packages/app/public/llms.txt` and `.well-known/mcp.json` listed five MCP tools (`create_item`, `update_item`, `get_item`, `list_languages`, `get_language_info`). The server serves seven: `render_item` and `get_spec` were missing. They are now generated (`npm run profile -- discovery`) from the Graffiticode profile, with the endpoint and tools taken from the release's surface registry (`packages/core/src/surfaces.ts`), so both list all seven. `packages/skills/plugin.meta.json` was already consistent and is byte-identical to the generated file. A test fails if the committed files drift from the runtime catalog again.
- **Discovery files in deployment.** For each installation, the build should run `npm run profile -- discovery <profile> --out <dir>` and serve `app/` from the app site's `public/`, keeping `discovery-receipt.json` with the release receipt. `packages/skills/scripts/build-plugin.mjs` reads `plugin.meta.json` from a git ref, so another installation's listing needs a `--meta <file>` option (with its icon) before its plugin can be packaged; the Graffiticode submission build is unchanged.
- **P3 slice 1, part 1a (storage isolation): done for core, the console, MCP and REST.** All Firestore access goes through `core/src/storage.ts` (one named Admin app per project, the database by id), which reads `core/src/profile/storage-config.ts`: the profile's `installation.project` and required `installation.database`, or, without a profile, `GOOGLE_CLOUD_PROJECT` with no built-in fallback. A source test fails if any other server module creates an Admin app or a Firestore handle. `deploy.json` now states each service's `GOOGLE_CLOUD_PROJECT`. The generation queue's default project is the installation's, and `removeFloorForStaging` asks the profile whether the installation is production. With `PROFILE_DIR` set, hosts and storage fail closed until the installation is initialized, so nothing (the RAG analytics service, created at import, included) can resolve or cache the environment's project or database first; analytics resolves its handle on each use. A server that uses storage validates it at startup: a missing or contradicting project stops the console, the REST server, and the MCP server in core mode. Found by the storage gate and fixed in the same part: the console's server routes read the auth host from the build-time `NEXT_PUBLIC_GC_AUTH_URL`; they now read it at use time through core's config.
- **P3 slice 1, part 1b (done): the app package.** It depends on core (`file:../core`; its Dockerfile installs and builds core first), initializes the installation at startup (`packages/app/src/instrumentation.ts`, exiting on failure), and its storage, request authentication and server-side hosts go through core: the installation's project and database, its auth host, its API host. The `graffiticode` emulator fallback and `GRAFFITICODE_APP_CREDENTIALS` are gone. The storage source test has no exceptions left. Its SSO routes still call `@graffiticode/auth-react/server` helpers that read the build-time auth host; they move with the authentication boundary (P5). Gate: `tests/installation-build/app.test.ts`, run by `npm run test:installation-build`. Server host resolution never treats a build-time `NEXT_PUBLIC_*` value as runtime configuration: Next inlines literal reads into server bundles, so core's config uses those literals only in the browser, and on a server resolves from the runtime environment alone, still checked against the profile. Both gates pass against builds made with the Dockerfile's public values (`CONSOLE_SERVER_DIR`, `APP_SERVER_DIR` point the gates at another build).
- **Ops scripts still name the project.** About 36 console and shell scripts hard-code `graffiticode-app`; they move to the installation's project with the parameterized bootstrap (`scripts/bootstrap-installation.sh`).
- **P3 slice 2, part 2a: the public configuration.** The console and the app load `/api/config` (contract and validator: `packages/core/src/profile/public-config.ts`; builder: `public-config-server.ts`) before mounting any provider. A failed, malformed, incomplete or unsupported-version response shows a configuration error and initializes nothing. The contract is a versioned allowlist, and the parser refuses any field outside it. With a profile, the profile is the only source of the browser's client ids (`auth.firebase` and `auth.privyAppId` are required, `billing.stripePublishableKey` is optional); without one, the built-in Firebase config and Privy app, and the runtime environment's Stripe key. Stripe.js loads only from its pure entry point, after the configuration. Gate: `tests/installation-build/browser.test.ts` (headless Chrome over the DevTools protocol, one build, two profiles, and the failure cases on the console's `/` and `/billing` and the app's `/`).
- **Stripe publishable key in production (before deploying 2a).** The production console's secret key is live, but no publishable key reaches its browser: the service has no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` at runtime, and the Dockerfile doesn't set one at build time, so the bundle has been falling back to a hard-coded test key (`pk_test_…` in `PaymentMethods`, and a different one always in `SetupForm`). A test publishable key can't work with a live secret key, so adding a payment method has most likely been failing. 2a removes the test-key fallbacks. The Graffiticode profile now carries the matching live key (checked against the production secret). Until production runs with the profile, set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to that key in the console service's runtime environment, or payment forms say payments aren't available.
- **Local builds and `auth-react`.** The console and the app use the local `packages/auth-react` through a `node_modules` link, still at version 0.7.4. Next's build cache treats packages under `node_modules` as unchanged while their version is, so an in-place rebuild can reuse a stale compile after editing it: clear `.next` (Docker builds start clean), or bump its version with each change.
- **P3 slice 2, part 2b: the remaining browser consumers.** The console's language picker and language lookups (`lib/catalog.ts`), its pricing display (`utils/plans.ts`, `usePlanDisplay`), the MCP endpoint in the connection instructions, the app host for "Open in form view", the auth host for linked emails, the console host as Stripe's return URL, the support page's channels, and the app's home page, footer and form iframe all come from `/api/config`. The contract gains `brand.supportEmail` (from `operator.supportEmail`), `brand.links.support` (also a new optional profile link), each language's public `routingHint`, and a nullable `overageRatePerItem`. Without a profile, the pricing display (plan cards, details, every button label and enrollment cap) and the catalog are unchanged; a console test holds them to a snapshot recorded from the old code. In a browser, core's configuration (`coreConfig()`, behind its API client) comes only from the validated public configuration: the configuration gate sets it (`configFromPublic`), and until then core refuses to resolve a host; it never falls back to a build-time value or a default. The catalog carries every language the installation resolves, each marked `offered`: the picker lists offered languages, while deep links and an item's own language resolve any of them, so existing items in a language the installation stopped offering keep working. The picker's domain filter is only one chosen explicitly (`?domain=`), and only when it selects an offered language; it is never derived from the hostname. A source test walks the browser's module graph from every page route into core and fails on a `NEXT_PUBLIC_*` read, a built-in host in any form (interpolated included), core's built-in catalog or plan terms, or a new core module imported by browser code without review; its remaining allowances are named, with reasons. The browser gate checks the spec pages' actual requests go to each installation's own API host. Local development: the console's form-view host is now the server setting `GRAFFITICODE_APP_URL` (`.env.development`). Left for slice 3: page metadata (the app's `lib/attribution.ts`, `_document`), the logo and other images (including the tools gallery's thumbnails, read from Graffiticode's storage bucket), and longer page copy that names Graffiticode (for example the console's home and about pages). `freePlan` is in the contract, but no browser text shows the item lifetime yet.
- **P3 slice 3: headers, metadata, images and copy.**
  - **Security headers** are built on the server from the pinned installation (`core/src/profile/security-headers.ts`). The console keeps today's report-only policy byte for byte, with its own API and auth hosts; the app's documents and the MCP server's HTML pages get a policy only with a profile, so without one their responses are unchanged. The mode is the profile's `csp.mode`. The console runs Next 15.4, whose stable builds refuse Node middleware, so each Next server computes its headers at startup (`instrumentation-node.ts`, `publishSecurityHeaders`) and its edge middleware reads them from the environment (`GC_INSTALLATION_SECURITY_HEADERS`, always overwritten at startup); without them the middleware answers 500. `next.config.mjs` no longer sets a CSP.
  - **Metadata:** pages stay prerendered, with the build's defaults in the initial HTML (byte-identical for every installation). In the console, one owner (`lib/document-metadata.tsx`, rendered by the configuration gate) sets the title and the one description; pages only name themselves (`<PageTitle suffix>`), and `getTitle()`/`getPageTitle()` are gone. In the app, the same after `/config` loads and on each navigation. Item pages (`/form/[id]`), already rendered per request, carry the installation's own metadata and MCP discovery tags in their HTML. The contract gains `metadata` (title and description per surface: the profile's copy `console.title`, `console.description`, `app.title`, `app.description`, else derived from the brand; without a profile, today's).
  - **Brand images:** the fixed URLs (`/favicon.png`, `/logo.png`, the app's `/icon.png`, now a public file) are rewritten to routes that serve the installation's icon, checked by its bytes and pinned at load (`core/src/profile/assets.ts`), or the build's file without a profile. `brand.assets.icon` and `brand.assets.logo` must be PNGs and the favicon a PNG or ICO, each checked by its whole structure (every PNG chunk's checksum, decompressed image data of exactly the size its header implies, and every ICO image complete) and then decoded in full by a maintained decoder (`pngjs`, a direct dependency of core), within the same size and dimension limits; SVG is refused everywhere until a namespace-aware allowlist parser admits it, since nothing serves one. A profile with a missing or invalid image doesn't load, so the server doesn't start.
  - **Copy:** the console's home and about pages render the installation's Markdown (`console.home`, `console.about`, else generic text from its brand; without a profile, today's pages unchanged), and short strings name the installation. The MCP client name in the connection instructions is the installation's id. Item thumbnails come from `hosts.thumbnails` (the platform's bucket by default).
  - **Origin allowlists:** the OAuth consent page's callback check moved to the server (`core/src/oauth-callbacks.ts`): `/api/oauth/grant` enforces it, the page asks `/api/oauth/callback-check`. Without a profile, today's patterns; with one, the installation's MCP and issuer origins over https, and local development outside production. `front/token`'s CORS origin is the installation's L0166 server.
  - **Gate:** `tests/installation-build/surfaces.test.ts`, one build as two installations and with no profile.
- **Follow-ups from slice 3.**
  - The console's `/docs` rewrite still proxies `docs.graffiticode.com` (build-time); it should follow the installation's `brand.links.docs`.
  - Without a profile, the consent callback check keeps today's `*.run.app` pattern, which admits any Cloud Run service; narrow it before relying on it.
  - The console's policy has no API host in `frame-src` although the console frames forms from it (today's policy, kept byte for byte); add it before any installation enforces.
  - With a profile, the console's home and about pages are Markdown rather than today's JSX, so they differ slightly in layout, and the home page's "New here?" note shows to everyone.
  - `/specs/[id]` can settle on a remembered language instead of the URL's when both sync effects race (pre-existing; the gate now isolates each visit).
- **P4: capabilities, pinned definitions and the service-tool family.**
  - **Capabilities stay code** (`core/src/capabilities.ts`): each capability's facts and now its operations (create, revise) with their input schemas; its handlers and authorization rule in `core/src/capability-handlers.ts` (`generate-content` runs one write-free generation in the skill's language; an account capability refuses a free-plan caller; a connection capability is refused until execution is ready). A profile's skill names a capability and may choose which operations it exposes and their tool names (`tools`); nothing else.
  - **Definitions from the profile** (`core/src/service-registry.ts`): the installation's services, each skill's facts taken from its capability. The Learnosity definitions left code; they are the services fixture (`core/test/fixtures/installation-services`), the starting point for P6's Artcompiler profile (its unimplemented skills, save and record execution, can't be listed until their capabilities are).
  - **One source** (`core/src/service-catalog.ts`): a job's pinned definition (the skill, its capability's facts and the service's limits) with its digest; MCP tools (one per exposed operation of each available skill, plus `job_get`/`job_cancel`); A2A skill declarations. A2A isn't served yet, so its declarations are generated and tested, not advertised.
  - **Admission** (`core/src/service-jobs.ts`): a live idempotency binding returns its job before anything else, so a same-key retry works after its skill is deselected (also through the MCP tool, `findLiveServiceJob`); only new work is checked against the current definition, the registry and the operator's switch, and pinned (envelope version 2: `definition`, `definitionDigest`). Jobs are judged and continued under their pin.
  - **Recovery and request identity.** A step's reservation is recovered from its claim (bound to the step's persisted key; the claim lasts as long as its job can, not generation's 24 hours) before any terminal decision. Recovery has three outcomes (reserved, in progress, none) or fails; a job whose generation step hasn't recorded its generation ends (refused, withdrawn, canceled or past its deadline) only through `endUnreserved`, and `transitionServiceJob` refuses any other terminal transition for it (`terminal_unfenced`), which, in one transaction, reads every step's claim and either finds a reservation (attached instead), a fresh claim (left in progress), or nothing, in which case it revokes each step's authority to reserve (a `revoked` claim generation can't bind) and ends the job. When that can't be established the job stays open and the caller is asked to retry. A job records the request it was made from (surface, tool, operation, validated input); a keyed request is identified by its surface, tool and arguments as sent (the arguments nested, so none can stand in for the others; a new request's arguments must be the tool's declared ones), resolves its recorded job before the current catalog is consulted, and resumes under its pin, so a redefined or deselected tool can't change what a retry does. A revise must target an item in one of the skill's languages (checked after access). Service surfaces can't take the MCP server's own routes (`RESERVED_MCP_PATHS`/`PREFIXES`, checked against `server.ts` by a test).
  - **Withdrawal** is an operator's switch, `CAPABILITIES_WITHDRAWN` (never a profile field): the capability's tools leave the catalog, new jobs are refused, a job whose step hasn't reserved its generation ends failed (`capability-withdrawn`), and a step in flight still settles; `job_get` and `job_cancel` keep working.
  - **The service-tool family** (`mcp-server/src/service-tools.ts`, generalized from the parked `/learnosity/mcp` endpoint): served at each path a profile's surface selects for `services` (not `/mcp`: one endpoint per OAuth resource until P5), API keys only, core mode only; the server refuses to start if a selected skill could write or needs execution before `EXECUTION_READY`. The discovery files describe the item endpoint only and report the services family as omitted, with its path.
  - **Follow-ups:** serving service tools on `/mcp` beside (or instead of) the item tools, and OAuth for service endpoints, wait for P5's per-resource tokens; a revise operation keeps the item's own language rather than requiring one of the skill's (as the parked endpoint did); `job_continue` and previews wait for the first skill that needs them; the parked stash (`stash@{0}`) is superseded and can be dropped.
- **P5 part 1: the OAuth boundary between installations and resources.** The OAuth store is still shared (the auth service) until the store handover, a separate migration slice, so each record carries the installation it belongs to, and an installation acts only on its own (`mcp-server/src/oauth/handlers.ts`).
  - **Declared resources.** `hosts.resources` holds the resources an installation declares: `auth.resources` with a profile, and today's MCP and REST resources without one. Its authorization server issues, refreshes and introspects only for those. A profile without a REST resource still resolves the REST server's public base, but no token can be bound to it. The REST server then accepts no OAuth token and advertises none: its served description drops the `oauth2` scheme and every OAuth security alternative, its protected-resource metadata answers 404, and its 401 challenge carries no `resource_metadata`.
  - **Binding.** Tokens, codes and pending authorizations are bound by their resource, and a client by the issuer it registered with (`issuer`, recorded at registration). Another installation's record reads as unknown and is left untouched: a code isn't consumed, a refresh token isn't rotated, and a pending authorization isn't deleted or redirected. Refresh needs the resource to be the installation's and the client's record to exist and be the installation's. Nothing deletes clients, so no legacy exception is needed: a missing client is refused everywhere, Graffiticode included. Refresh keeps the resource it was granted and never widens it.
  - **Existing records are Graffiticode's.** A client with no `issuer` and a token or code with no `resource` belong to Graffiticode's issuer and MCP resource (`LEGACY_ISSUER`, `LEGACY_RESOURCE`), exactly as they were served. They keep working there, never for REST and never elsewhere. A refresh, and a code made from a legacy pending authorization, record the binding explicitly. A code exchange that names a resource compares it with the code's binding, so a legacy code that names Graffiticode's MCP resource behaves exactly as one that omits it.
  - **Introspection.** It answers only this installation's REST service: by default the installation project's `openapi-run@` account, with the identity token's audience on its own issuer. The answer names `iss` and `aud`. The REST server accepts it only when `aud` is its declared resource and `iss`, when present, is its issuer. An `iss` that is absent is allowed so that REST can deploy before MCP.
  - **The issuer is still the MCP host,** which serves `/oauth/*`. An issuer of its own comes with the store handover.
  - **Gate:**
    - `mcp-server/tests/oauth-boundary.test.ts` runs two installations over one shared store and covers each item below:
      - tokens across installations and between MCP and REST;
      - undeclared resources;
      - other installations' clients, pending authorizations, codes and refresh tokens;
      - refresh and introspection keeping the binding;
      - records from before installations;
      - the default introspection caller.
    - `openapi-server/tests/oauth-binding.test.ts` covers the REST side.
    - A mutation check confirms that each guard is covered.
  - **Deployment order:** MCP before or with REST. REST tolerates a missing `iss`, and nothing else changes on the wire. Proof revisions keep production's hosts.
  - **Backend part 2** (installation context in the API and Policy, act-as and credentials per installation, untagged records, the rollout guard) follows the backend repo's sequence and must be deployed before P6 starts.

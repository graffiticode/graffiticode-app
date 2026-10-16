# GCP bootstrap for gc-deploy (project graffiticode-app)

gc-deploy never creates services, service accounts or IAM bindings. These are
the one-time steps, mirroring `graffiticode/docs/capability-policy-iam-review.md`
(Step 2). Status as of 2026-10-16: done unless marked TODO.

```bash
P=graffiticode-app; R=us-central1
BUILD_SA=deploy-build@$P.iam.gserviceaccount.com

# Artifact Registry repo for gc-deploy images
gcloud artifacts repositories create services --repository-format docker --location $R --project $P

# Build SA: push images, write build logs, read the uploaded source. It holds no
# run.* role, no actAs on runtime SAs and no application secret.
gcloud iam service-accounts create deploy-build --project $P --display-name "Cloud Build: image builds"
gcloud artifacts repositories add-iam-policy-binding services --location $R --project $P \
  --member serviceAccount:$BUILD_SA --role roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $P --member serviceAccount:$BUILD_SA \
  --role roles/logging.logWriter --condition=None
gcloud storage buckets add-iam-policy-binding gs://${P}_cloudbuild \
  --member serviceAccount:$BUILD_SA --role roles/storage.objectViewer

# Runtime SA for mcp-service. mcp calls no Google API under its own identity
# (Identity Toolkit uses an API key), so it only needs its mounted secret.
gcloud iam service-accounts create mcp-run --project $P --display-name "Cloud Run runtime: mcp-service"
gcloud secrets add-iam-policy-binding FREE_PLAN_NAMESPACE_SALT --project $P \
  --member serviceAccount:mcp-run@$P.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor --condition=None

# Move mcp-service onto mcp-run@ (same image), verified on a no-traffic tag first.
gcloud run services update mcp-service --project $P --region $R \
  --service-account mcp-run@$P.iam.gserviceaccount.com --no-traffic --tag sa-swap
#   check /health, /widget/lang/L0180.mjs, MCP initialize + list_languages on the tag URL
gcloud run services update-traffic mcp-service --project $P --region $R --to-revisions <rev>=100
gcloud run services update-traffic mcp-service --project $P --region $R --remove-tags sa-swap

# Cloud Build's regional logs bucket. gc-deploy builds use
# REGIONAL_USER_OWNED_BUCKET logging; the first build failed until the bucket
# existed and the build SA could write to it (same grant as the backend's).
gcloud storage buckets create gs://290218862769-us-central1-cloudbuild-logs \
  --project $P --location $R --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://290218862769-us-central1-cloudbuild-logs \
  --member serviceAccount:$BUILD_SA --role roles/storage.admin

# Runtime SA for app (app.graffiticode.org): Firestore in the default
# database (users/{uid}, users/{uid}/items) and its two mounted secrets.
gcloud iam service-accounts create app-run --project $P --display-name "Cloud Run runtime: app"
gcloud projects add-iam-policy-binding $P --member serviceAccount:app-run@$P.iam.gserviceaccount.com \
  --role roles/datastore.user \
  --condition='expression=resource.name=="projects/graffiticode-app/databases/(default)",title=default-db-only'
for s in INTERNAL_API_KEY PRIVY_APP_SECRET; do
  gcloud secrets add-iam-policy-binding $s --project $P \
    --member serviceAccount:app-run@$P.iam.gserviceaccount.com \
    --role roles/secretmanager.secretAccessor --condition=None; done
# Then the same no-traffic tag swap as mcp-service, for service app.
```

`console` already runs as `console-run@graffiticode-app`.

The deployer (an Owner today) needs nothing extra. A non-Owner deployer needs
the deployer grants from the backend runbook, scoped to `deploy-build@`,
`console-run@` and `mcp-run@`.

## Out-of-band service settings (not managed by gc-deploy)

| Service | min/max instances | memory | timeout |
|---|---|---|---|
| console | 1 / 10 | 1Gi | 900s |
| mcp-service | 1 / – | 512Mi | 300s |
| app | – / – | 1Gi | 300s |
| openapi-service | 1 / 20 (min set 2026-10-17, so the first request after idle doesn't pay a cold start) | 512Mi | 900s (set 2026-10-16): `GET /v1/items/{id}/events` keeps a stream open up to 10 minutes. An out-of-band update makes a new revision with no traffic, since gc-deploy pins traffic by revision; move it with `update-traffic --to-revisions <rev>=100` |

## Generation protocol v2 (Phase 3.5)

Done: v2 has been the production protocol since 2026-10-15 22:46Z (the
Firestore floor; see "Enabling v2" below). The floor is one-way: never deploy a
console older than R1 (`deploy.json` baselines refuse it).

- `ACT_AS_GRANT_SECRET` (this project) holds the same value as
  `act-as-grant-secret` in project `graffiticode`. Read by the producers that
  sign grants: `console-run@`, `mcp-run@` (R2) and `openapi-run@` (Phase 4).
  Only `console-run@` may exchange one at auth's `/internal/act-as` (IAM review
  Step 12 in the backend repo). Mounted by `deploy.json`.
- The sweeper: a Cloud Scheduler job calling the console's own origin every
  minute with the internal job secret (see
  `packages/console/src/pages/api/internal/sweep-generations.ts`):

  ```
  gcloud scheduler jobs create http sweep-generations \
    --project=graffiticode-app --location=us-central1 --schedule="* * * * *" \
    --uri="$(gcloud run services describe console --project=graffiticode-app --region=us-central1 --format='value(status.url)')/api/internal/sweep-generations" \
    --http-method=POST \
    --headers="X-Internal-Job-Secret=<INTERNAL_JOB_SECRET>" \
    --attempt-deadline=60s --max-retry-attempts=0
  ```

  Missing runs are harmless (the next minute's sweep covers them), so no
  retries. Check it after creating: `gcloud scheduler jobs run sweep-generations`
  and the console log's `generation_sweep` lines.
- Firestore: the sweeper's queries are single-field ranges
  (`generation-jobs.dispatch.nextDispatchAt`, `effects.nextAttemptAt`) and the
  worker's is an equality on `effects.sourceId`; all use automatic indexes.

### Enabling v2 (R1.1)

1. Every tag on a pre-R1 console revision (and pre-R0.5 mcp revision) is
   retired: `npm run deploy -- retire-tags console`, the same for `mcp`, then
   `gc-deploy release-check`.
2. `npm run enable-generation-v2 -w packages/console -- --console-floor <first R1 revision> --mcp-floor <first R0.5 revision>`
   runs the drain check (no tags, no traffic, no instances on older revisions
   for 20 minutes); with `--yes` it writes the one-way Firestore floor.
3. Set `GENERATION_PROTOCOL=v2` in the console's `deploy.json` env, record the R1
   release as its `baselines` entry, and deploy. The console's verify module
   (`verify/console.mjs`) refuses any candidate whose effective protocol is
   below the floor.
4. Watch `generation_sweep` log lines and `npm run billing-uncertain`.

### MCP in core mode (R2)

Done 2026-10-16 (`mcp-service-rmvba3aqz-c77591` and later).

mcp runs `@graffiticode-app/core` in-process (`GRAFFITICODE_BACKEND=core`):
it reserves v2 jobs and wakes the console's worker; it never calls an LLM
(`get_spec` stays on the console over GraphQL, beside the generator and the
model key) and never calls Policy (core skips the connection lookup for it).
Grants for `mcp-run@`, all in this project, before the core-mode deploy:

```
SA=serviceAccount:mcp-run@graffiticode-app.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding graffiticode-app --member=$SA --role=roles/datastore.user --condition=None
gcloud tasks queues add-iam-policy-binding generation-jobs --location=us-central1 --project=graffiticode-app \
  --member=$SA --role=roles/cloudtasks.enqueuer
for s in INTERNAL_JOB_SECRET FREE_PLAN_API_KEY ACT_AS_GRANT_SECRET; do
  gcloud secrets add-iam-policy-binding $s --project=graffiticode-app --member=$SA \
    --role=roles/secretmanager.secretAccessor --condition=None; done
```

(`FREE_PLAN_NAMESPACE_SALT` it already reads.) No Stripe key: core's only use
on this path repairs an empty subscription cache, which the console still does.
`npm run deploy -- mcp` then refuses the candidate unless `/health?deep=1`
reports core ready (Firestore, `cloudtasks.tasks.create` on the queue, secrets,
free-plan credentials) and protocol ≥ the floor (`verify/mcp.mjs`).

Rollback: set `GRAFFITICODE_BACKEND` back to `graphql` in `deploy.json` and
deploy (same image), or `npm run rollback -- mcp` to the previous release.

### REST API (Phase 4)

Done 2026-10-16: Cloud Run `openapi-service`, served at
https://openapi.graffiticode.org/v1. Like mcp in core mode, it runs core
in-process, holds no model key (`get_spec` goes to the console over GraphQL)
and calls no Policy route.

```
P=graffiticode-app
SA=openapi-run@$P.iam.gserviceaccount.com

# Runtime SA, with what core needs here: Firestore (default database only), the
# generation queue, and the four secrets core mounts. A new SA takes a few
# seconds to be usable in IAM bindings; retry a "does not exist" refusal.
gcloud iam service-accounts create openapi-run --project $P --display-name "Cloud Run runtime: openapi-service"
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/datastore.user \
  --condition='expression=resource.name=="projects/graffiticode-app/databases/(default)",title=default-db-only'
gcloud tasks queues add-iam-policy-binding generation-jobs --location=us-central1 --project=$P \
  --member=serviceAccount:$SA --role=roles/cloudtasks.enqueuer
for s in INTERNAL_JOB_SECRET FREE_PLAN_API_KEY FREE_PLAN_NAMESPACE_SALT ACT_AS_GRANT_SECRET; do
  gcloud secrets add-iam-policy-binding $s --project=$P --member=serviceAccount:$SA \
    --role=roles/secretmanager.secretAccessor --condition=None; done

# Idempotency keys (idempotency-keys/{hash}) carry expiresAt; the TTL policy
# deletes them once past it (an expired key already reads as absent, so this
# only reclaims space).
gcloud firestore fields ttls update expiresAt --collection-group=idempotency-keys \
  --enable-ttl --project=$P

# gc-deploy needs the service to exist, on its runtime SA: a placeholder first,
# then `npm run deploy -- openapi` (verify/openapi.mjs checks core readiness,
# the protocol floor and the served public URL before promotion).
gcloud run deploy openapi-service --project $P --region us-central1 \
  --image us-docker.pkg.dev/cloudrun/container/hello --service-account $SA \
  --allow-unauthenticated --port 8080

# The domain: a Cloud Run mapping, then in Cloudflare a CNAME
# openapi -> ghs.googlehosted.com, DNS only until Google has issued the
# certificate (15-60 min; then a few more minutes before every edge serves it),
# optionally proxied after.
gcloud beta run domain-mappings create --service openapi-service \
  --domain openapi.graffiticode.org --project $P --region us-central1
```

OAuth: the REST API is a second resource of mcp's authorization server
(`OPENAPI_RESOURCE`, default https://openapi.graffiticode.org/v1). It checks
access tokens at mcp's `POST /oauth/introspect`, which accepts only callers
whose Cloud Run identity is in `OAUTH_INTROSPECTION_CALLERS` (default
`openapi-run@` only), so this service never holds the internal API key. Deploy
mcp before openapi when either side of that changes.

## Open items

- TODO: existing secret mounts use `:latest`, which gc-deploy rejects. Pin them
  to numbered versions in `deploy.json` before managing secrets through it.
- TODO: several console secrets are plain env vars rather than Secret Manager
  mounts (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `INTERNAL_API_KEY`; mcp-service `INTERNAL_API_KEY`).

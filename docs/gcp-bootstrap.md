# GCP bootstrap for gc-deploy (project graffiticode-app)

gc-deploy never creates services, service accounts or IAM bindings. These are
the one-time steps, mirroring `graffiticode/docs/capability-policy-iam-review.md`
(Step 2). Status as of 2026-10-13: done unless marked TODO.

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

## Generation protocol v2 (Phase 3.5)

Set up before v2 is enabled (R1.1); harmless before, since the sweeper finds
nothing to do while no v2 jobs exist.

- `ACT_AS_GRANT_SECRET` (this project) holds the same value as
  `act-as-grant-secret` in project `graffiticode`; only `console-run@` reads it
  here (IAM review Step 12 in the backend repo). Mounted by `deploy.json`.
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

## Open items

- TODO: existing secret mounts use `:latest`, which gc-deploy rejects. Pin them
  to numbered versions in `deploy.json` before managing secrets through it.
- TODO: several console secrets are plain env vars rather than Secret Manager
  mounts (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `INTERNAL_API_KEY`; mcp-service `INTERNAL_API_KEY`).

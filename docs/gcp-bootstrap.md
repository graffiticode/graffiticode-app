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

## Open items

- [UNVERIFIED] gc-deploy's `REGIONAL_USER_OWNED_BUCKET` build logging may need
  write on that bucket for `deploy-build@`. Confirm on the first build rather
  than granting broader roles up front.
- TODO: existing secret mounts use `:latest`, which gc-deploy rejects. Pin them
  to numbered versions in `deploy.json` before managing secrets through it.
- TODO: several console secrets are plain env vars rather than Secret Manager
  mounts (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `INTERNAL_API_KEY`; mcp-service `INTERNAL_API_KEY`).

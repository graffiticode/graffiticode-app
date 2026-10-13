#!/usr/bin/env bash
#
# Push FREE_PLAN_API_KEY and FREE_PLAN_NAMESPACE_SALT from .env.local into
# Google Secret Manager and mount them as env vars on the Cloud Run service.
#
# Re-running creates a new secret version (rotation) and rolls a new revision.
#
set -euo pipefail

PROJECT="graffiticode-app"
REGION="us-central1"
SERVICE="console"
ENV_FILE="$(dirname "$0")/../.env.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Cannot find ${ENV_FILE}" >&2
  exit 1
fi

# Pull a single VAR=value line from .env.local. Strips surrounding quotes,
# rejects multi-line values, and refuses to leak the value if missing.
read_env_var() {
  local NAME="$1"
  local LINE
  LINE=$(grep -E "^${NAME}=" "${ENV_FILE}" | head -n 1 || true)
  if [[ -z "${LINE}" ]]; then
    echo "Missing ${NAME} in ${ENV_FILE}" >&2
    exit 1
  fi
  local VALUE="${LINE#${NAME}=}"
  # Strip optional surrounding single or double quotes.
  if [[ "${VALUE}" == \"*\" ]] || [[ "${VALUE}" == \'*\' ]]; then
    VALUE="${VALUE:1:${#VALUE}-2}"
  fi
  if [[ -z "${VALUE}" ]]; then
    echo "${NAME} in ${ENV_FILE} is empty" >&2
    exit 1
  fi
  printf '%s' "${VALUE}"
}

FREE_PLAN_API_KEY="$(read_env_var FREE_PLAN_API_KEY)"
FREE_PLAN_NAMESPACE_SALT="$(read_env_var FREE_PLAN_NAMESPACE_SALT)"

upsert_secret() {
  local NAME="$1"
  local VALUE="$2"
  if gcloud secrets describe "${NAME}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "Adding new version to existing secret ${NAME}"
    printf '%s' "${VALUE}" | gcloud secrets versions add "${NAME}" \
      --project="${PROJECT}" --data-file=-
  else
    echo "Creating new secret ${NAME}"
    printf '%s' "${VALUE}" | gcloud secrets create "${NAME}" \
      --project="${PROJECT}" \
      --replication-policy=automatic \
      --data-file=-
  fi
}

upsert_secret FREE_PLAN_API_KEY        "${FREE_PLAN_API_KEY}"
upsert_secret FREE_PLAN_NAMESPACE_SALT "${FREE_PLAN_NAMESPACE_SALT}"

# Grant the Cloud Run service account permission to read these secrets.
SA=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT}" --region="${REGION}" \
  --format='value(spec.template.spec.serviceAccountName)' || true)

if [[ -z "${SA}" ]]; then
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
  SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  echo "Service has no explicit SA; using default compute SA: ${SA}"
fi

for NAME in FREE_PLAN_API_KEY FREE_PLAN_NAMESPACE_SALT; do
  gcloud secrets add-iam-policy-binding "${NAME}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None >/dev/null
done

gcloud run services update "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --update-secrets=FREE_PLAN_API_KEY=FREE_PLAN_API_KEY:latest,FREE_PLAN_NAMESPACE_SALT=FREE_PLAN_NAMESPACE_SALT:latest

echo
echo "Done. ${SERVICE} is rolling a new revision with the secrets mounted."
echo "Verify with:"
echo "  gcloud run services describe ${SERVICE} --project ${PROJECT} --region ${REGION} \\"
echo "    --format='value(spec.template.spec.containers[0].env)'"

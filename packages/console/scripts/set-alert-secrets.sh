#!/usr/bin/env bash
#
# Push the Twilio SMS credentials from .env.local into Google Secret Manager and
# mount them as env vars on the Cloud Run service, for the hourly funnel digest
# (src/pages/api/internal/funnel-digest.ts).
#
# Re-running creates a new secret version (rotation) and rolls a new revision.
#
# ALERT_SMS_TO is not a secret, but it lives here so all four move together —
# a digest with credentials and no recipient sends nothing.
#
set -euo pipefail

PROJECT="graffiticode-app"
REGION="us-central1"
SERVICE="console"
ENV_FILE="$(dirname "$0")/../.env.local"

VARS=(TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM ALERT_SMS_TO)

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Cannot find ${ENV_FILE}" >&2
  exit 1
fi

# Pull a single VAR=value line from .env.local. Strips surrounding quotes and
# refuses to leak the value if missing.
read_env_var() {
  local NAME="$1"
  local LINE
  LINE=$(grep -E "^${NAME}=" "${ENV_FILE}" | head -n 1 || true)
  if [[ -z "${LINE}" ]]; then
    echo "Missing ${NAME} in ${ENV_FILE}" >&2
    exit 1
  fi
  local VALUE="${LINE#${NAME}=}"
  if [[ "${VALUE}" == \"*\" ]] || [[ "${VALUE}" == \'*\' ]]; then
    VALUE="${VALUE:1:${#VALUE}-2}"
  fi
  if [[ -z "${VALUE}" ]]; then
    echo "${NAME} in ${ENV_FILE} is empty" >&2
    exit 1
  fi
  printf '%s' "${VALUE}"
}

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

for NAME in "${VARS[@]}"; do
  upsert_secret "${NAME}" "$(read_env_var "${NAME}")"
done

# Grant the Cloud Run service account permission to read these secrets.
SA=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT}" --region="${REGION}" \
  --format='value(spec.template.spec.serviceAccountName)' || true)

if [[ -z "${SA}" ]]; then
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
  SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  echo "Service has no explicit SA; using default compute SA: ${SA}"
fi

for NAME in "${VARS[@]}"; do
  gcloud secrets add-iam-policy-binding "${NAME}" \
    --project="${PROJECT}" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None >/dev/null
done

UPDATE_SECRETS=""
for NAME in "${VARS[@]}"; do
  UPDATE_SECRETS+="${UPDATE_SECRETS:+,}${NAME}=${NAME}:latest"
done

gcloud run services update "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --update-secrets="${UPDATE_SECRETS}"

# The digest reads events straight from the Cloud Logging API, so the runtime SA
# needs logging.viewer. Idempotent.
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" \
  --role="roles/logging.viewer" \
  --condition=None >/dev/null

echo
echo "Done. ${SERVICE} is rolling a new revision with the Twilio secrets mounted."
echo
echo "Create the schedule (once):"
echo "  gcloud scheduler jobs create http funnel-digest \\"
echo "    --project ${PROJECT} --location ${REGION} \\"
echo "    --schedule='2 8-20 * * *' --time-zone='America/Los_Angeles' \\"
echo "    --uri='https://console.graffiticode.org/api/internal/funnel-digest' \\"
echo "    --http-method=POST \\"
echo "    --headers=\"X-Internal-Job-Secret=\${INTERNAL_JOB_SECRET}\""

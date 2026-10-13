#!/usr/bin/env bash
# Alerting for free-plan claim failures.
#
# Why: claims run in the console (claimFreePlanSession), NOT the MCP server, so a
# broken claim path never reaches the mcp_tool funnel stream. On 2026-06-10 a
# missing Firestore index made EVERY claim 500 — silently tanking north-star #1
# (anonymous -> account) with no signal. The resolver already emits structured
# `claim` events to Cloud Logging (logClaimEvent, src/pages/api/resolvers.ts);
# this wires an alert on the error ones so a regression pages someone instead of
# going unnoticed.
#
# Usage:
#   bash scripts/setup-claim-alert.sh <notification-channel-id>
#
# List notification channels to get an id:
#   gcloud beta monitoring channels list --project=graffiticode-app \
#     --format='value(name,type,displayName)'
#
# Idempotent: skips the metric and the policy if they already exist. Re-running
# is safe and makes no changes once both are present.

set -euo pipefail

PROJECT="graffiticode-app"
METRIC="claim_errors"
POLICY_NAME="Free-plan claim failures"
CHANNEL="${1:-}"

if [[ -z "$CHANNEL" ]]; then
  echo "ERROR: pass a notification channel id as \$1." >&2
  echo "  gcloud beta monitoring channels list --project=$PROJECT --format='value(name,type,displayName)'" >&2
  exit 1
fi

# 1. Log-based counter metric over claim error events.
if gcloud logging metrics describe "$METRIC" --project="$PROJECT" >/dev/null 2>&1; then
  echo "metric '$METRIC' already exists — leaving as-is."
else
  echo "creating log-based metric '$METRIC'..."
  gcloud logging metrics create "$METRIC" \
    --project="$PROJECT" \
    --description="Free-plan claim failures (ev=claim outcome=error)" \
    --log-filter='jsonPayload.ev="claim" AND jsonPayload.outcome="error"'
fi

# 2. Alert policy: any claim error summed over a rolling 5-minute window. With a
#    log-based counter there's simply no data when claims succeed, so GT 0 only
#    fires on a real failure — no false alarms during quiet periods.
EXISTING="$(gcloud alpha monitoring policies list --project="$PROJECT" \
  --filter="displayName=\"$POLICY_NAME\"" --format='value(name)' 2>/dev/null | head -1)"
if [[ -n "$EXISTING" ]]; then
  echo "policy '$POLICY_NAME' already exists ($EXISTING) — leaving as-is."
  echo "  (to change it, edit in the console or delete and re-run: gcloud alpha monitoring policies delete $EXISTING)"
else
  echo "creating alert policy '$POLICY_NAME'..."
  POLICY_FILE="$(mktemp)"
  trap 'rm -f "$POLICY_FILE"' EXIT
  cat > "$POLICY_FILE" <<JSON
{
  "displayName": "$POLICY_NAME",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "claim errors > 0 (5m)",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/$METRIC\" AND resource.type=\"cloud_run_revision\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "trigger": { "count": 1 },
        "aggregations": [
          { "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM" }
        ]
      }
    }
  ],
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "A free-plan claim (claimFreePlanSession) failed. Claims run console-side and do NOT appear in the MCP tool stream, so this alert is the only signal. Investigate console logs (jsonPayload.ev=\"claim\" AND jsonPayload.outcome=\"error\") and any recent Firestore index / resolver change. Directly affects north-star #1 (anonymous -> account)."
  }
}
JSON
  gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$POLICY_FILE"
  echo "created policy '$POLICY_NAME'."
fi

echo
echo "done. verify:"
echo "  gcloud logging metrics describe $METRIC --project=$PROJECT"
echo "  gcloud alpha monitoring policies list --project=$PROJECT --filter='displayName=\"$POLICY_NAME\"' --format='value(name,enabled)'"

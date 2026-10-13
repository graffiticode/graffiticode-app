#!/usr/bin/env bash
#
# Clear the caches that sit between a deployed language server and an agent.
#
#   ./scripts/gcp-clear-cache.sh [--lang <id>]... [--wait <seconds>] [--no-mcp] [--skip-verify]
#   npm run gcp:clear-cache -- --lang 0177
#
# There are THREE caches in front of a language's spec assets, not one:
#
#   1. Cloudflare edge on api.graffiticode.org/L<id>/*  — Cache-Control: max-age=3600.
#      This is the big one, and it is REGIONAL: a purge observed from your laptop
#      says nothing about the PoP that serves Cloud Run in us-central1.
#   2. console  — in-memory, 5 min (LANGUAGE_SERVER_CACHE_TTL_MS in
#      src/lib/language-server-client.ts). Fetches through (1).
#   3. mcp-service — in-memory, 10 min (LANGUAGE_CACHE_TTL_MS in its api.ts).
#      Fetches through (2).
#
# Bouncing the Cloud Run revisions only clears (2) and (3). If (1) is stale, the
# fresh instances immediately refetch the SAME stale bytes and you have cleared
# nothing — this script used to print "In-memory caches cleared" anyway, which is
# how a language deploy could sit invisible for an hour while every signal said OK.
#
# So: purge the edge first, bounce second, and VERIFY last. Pass --lang to get a
# real end-to-end check; without it this script cannot confirm anything and says so.
#
# Cloudflare purge needs CLOUDFLARE_API_TOKEN (Zone.Cache Purge) and
# CLOUDFLARE_ZONE_ID for graffiticode.org. If they are unset the purge is SKIPPED
# and the script says so loudly rather than pretending.
#
set -euo pipefail

PROJECT="graffiticode-app"
CONSOLE_SERVICE="console"
MCP_SERVICE="mcp-service"
REGION="us-central1"
WAIT_SECONDS=5
BOUNCE_MCP=1
VERIFY=1
VERIFY_ONLY=0
LANGS=()

# The per-language assets the console pulls through the API proxy.
ASSETS=(language-info.json usage-guide.md scope.json schema.json spec-directive.md instructions.md)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) LANGS+=("${2:?--lang needs a language id, e.g. 0177}"); shift 2 ;;
    --wait) WAIT_SECONDS="${2:?--wait needs a value}"; shift 2 ;;
    --no-mcp) BOUNCE_MCP=0; shift ;;
    --skip-verify) VERIFY=0; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- step 1: edge

purge_edge() {
  if [[ ${#LANGS[@]} -eq 0 ]]; then
    echo "==> Cloudflare purge: SKIPPED (no --lang given; nothing specific to purge)"
    return
  fi
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    echo ""
    echo "!!  Cloudflare purge SKIPPED — CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set."
    echo "!!  api.graffiticode.org/L<id>/* is cached at the edge for up to 1 hour, so a"
    echo "!!  freshly-deployed language may STILL be invisible after this script finishes."
    echo "!!  The verification below will tell you whether that is the case."
    return
  fi

  local urls=()
  for lang in "${LANGS[@]}"; do
    for asset in "${ASSETS[@]}"; do
      urls+=("https://api.graffiticode.org/L${lang}/${asset}")
    done
  done

  local body
  body="$(printf '%s\n' "${urls[@]}" | python3 -c 'import sys,json; print(json.dumps({"files":[l.strip() for l in sys.stdin if l.strip()]}))')"

  echo ""
  echo "==> Purging Cloudflare edge for ${#urls[@]} asset URL(s)"
  local resp
  resp="$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${body}")"

  if ! python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' <<<"${resp}"; then
    echo "    Cloudflare purge FAILED:" >&2
    echo "    ${resp}" >&2
    exit 1
  fi
  echo "    Purged."
}

# ------------------------------------------------------------- step 2: bounce

# Roll a FRESH revision of the same image so in-process caches start empty. A
# traffic toggle is not enough: minScale=1 keeps the tip revision warm, so the
# request can land back on the same instance with its caches intact.
bounce_service() {
  local service="$1"
  local current image previous stamp

  read -r current image < <(gcloud run services describe "${service}" \
    --project "${PROJECT}" --region "${REGION}" \
    --format="value(status.latestReadyRevisionName, spec.template.spec.containers[0].image)")

  if [[ -z "${current}" || -z "${image}" ]]; then
    echo "Could not resolve revision/image for ${service}." >&2
    exit 1
  fi

  echo ""
  echo "==> Bouncing ${service} (current: ${current})"

  previous="$(gcloud run revisions list --service "${service}" \
    --project "${PROJECT}" --region "${REGION}" \
    --sort-by="~metadata.creationTimestamp" \
    --filter="status.conditions.type=Ready AND status.conditions.status=True" \
    --format="value(metadata.name)" \
    | grep -v "^${current}\$" | head -n1 || true)"

  if [[ -n "${previous}" ]]; then
    gcloud run services update-traffic "${service}" \
      --project "${PROJECT}" --region "${REGION}" \
      --to-revisions="${previous}=100" --quiet >/dev/null
    sleep "${WAIT_SECONDS}"
  fi

  stamp="$(date +%s)"
  gcloud run deploy "${service}" \
    --project "${PROJECT}" --region "${REGION}" \
    --image "${image}" \
    --update-env-vars "CACHE_FLUSHED_AT=${stamp}" \
    --quiet >/dev/null

  gcloud run services update-traffic "${service}" \
    --project "${PROJECT}" --region "${REGION}" \
    --to-latest --quiet >/dev/null

  local now
  now="$(gcloud run services describe "${service}" \
    --project "${PROJECT}" --region "${REGION}" \
    --format="value(status.traffic[0].revisionName)")"
  echo "    Now serving: ${now}"
}

# ------------------------------------------------------------- step 3: verify

# The origin is the truth. If the API proxy disagrees with it, the edge is still
# stale; if the console disagrees, its in-memory cache has not rolled yet. Compare
# rather than assume — under a fail-open CDN, "the deploy succeeded" tells you
# nothing about what an agent will actually receive.
guide_from() { python3 -c 'import sys,json; print((json.load(sys.stdin) or {}).get("authoring_guide") or "")' 2>/dev/null || true; }

verify_lang() {
  local lang="$1" origin proxy consoled rc=0

  origin="$(curl -sS -m 20 "https://l${lang}.graffiticode.org/language-info.json" | guide_from)"
  if [[ -z "${origin}" ]]; then
    echo "    L${lang}: could not read authoring_guide from the language server — cannot verify." >&2
    return 1
  fi

  proxy="$(curl -sS -m 20 "https://api.graffiticode.org/L${lang}/language-info.json" | guide_from)"
  if [[ "${proxy}" != "${origin}" ]]; then
    echo "    L${lang}: EDGE STALE — api.graffiticode.org still serves an old language-info.json."
    echo "             Bouncing Cloud Run will NOT fix this; the fresh instances refetch the same"
    echo "             stale bytes. Purge Cloudflare (set CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID"
    echo "             and re-run) or wait out the 1-hour max-age."
    rc=1
  fi

  consoled="$(curl -sS -m 25 -X POST "https://console.graffiticode.org/api" \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"query { language(id: \\\"${lang}\\\") { authoringGuide } }\"}" \
    | python3 -c 'import sys,json; print(((json.load(sys.stdin) or {}).get("data") or {}).get("language",{}).get("authoringGuide") or "")' 2>/dev/null || true)"

  if [[ "${consoled}" != "${origin}" ]]; then
    echo "    L${lang}: CONSOLE STALE — console.graffiticode.org/api does not yet match the origin."
    rc=1
  fi

  [[ ${rc} -eq 0 ]] && echo "    L${lang}: fresh end-to-end (origin == api == console)."
  return ${rc}
}

# ------------------------------------------------------------------------ run

echo "Project ${PROJECT} / region ${REGION}"
[[ ${#LANGS[@]} -gt 0 ]] && echo "Languages: ${LANGS[*]}"

if [[ ${VERIFY_ONLY} -eq 0 ]]; then
  purge_edge
  bounce_service "${CONSOLE_SERVICE}"
  [[ ${BOUNCE_MCP} -eq 1 ]] && bounce_service "${MCP_SERVICE}"
else
  echo "(--verify-only: not purging, not bouncing)"
fi

if [[ ${VERIFY} -eq 0 ]]; then
  echo ""
  echo "Revisions bounced. Verification skipped (--skip-verify) — this run proves nothing"
  echo "about what an agent will receive."
  exit 0
fi

if [[ ${#LANGS[@]} -eq 0 ]]; then
  echo ""
  [[ ${VERIFY_ONLY} -eq 0 ]] && echo "Revisions bounced."
  echo "NOT VERIFIED: no --lang given, so this script cannot confirm that any language's assets"
  echo "are actually fresh. Re-run with --lang <id> for an end-to-end check."
  exit 0
fi

echo ""
echo "==> Verifying propagation (origin -> api edge -> console)"
failed=0
for lang in "${LANGS[@]}"; do
  verify_lang "${lang}" || failed=1
done

if [[ ${failed} -ne 0 ]]; then
  echo ""
  echo "CACHES NOT CLEAR. See above — do not assume the deploy is live."
  exit 1
fi

echo ""
if [[ ${VERIFY_ONLY} -eq 1 ]]; then
  echo "Verified fresh. (Nothing was purged or bounced — this was a read-only check.)"
else
  echo "Done. Caches cleared and propagation verified."
fi

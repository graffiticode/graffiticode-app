// The Firestore TTL policies an installation's database needs, and the
// commands that provision them (installations plan, P3: the parameterized
// bootstrap will call this; until then `npm run profile -- ttl <profile>`
// prints them).
//
// A TTL policy only reclaims space: every document here also carries the
// expiry its readers enforce, so a deletion that comes late (TTL runs within
// about a day) changes nothing, and none comes early (each TTL field is at or
// after the time its record stops being usable).
//
// Provisioning is idempotent and names its target: each policy is read first
// (`gcloud firestore indexes fields describe`) and enabled only if it isn't
// already active or being created, always with an explicit --project and
// --database. This module only produces the script; nothing here runs it.
import { COLLECTIONS } from "./oauth/local-store.js";

export type TtlPolicy = { collectionGroup: string; field: string; note: string };

export const TTL_POLICIES: readonly TtlPolicy[] = [
  { collectionGroup: "idempotency-keys", field: "expiresAt", note: "core/idempotency.ts; an expired key already reads as absent" },
  { collectionGroup: "service-job-keys", field: "expiresAt", note: "core/service-jobs.ts; null while the job is live, so never collected then" },
  { collectionGroup: "oauth-grants", field: "expireAt", note: "core/oauth-grants.ts; redemption deletes them, TTL sweeps the unredeemed" },
  { collectionGroup: COLLECTIONS.pending, field: "expireAt", note: "core/oauth/local-store.ts; expires_at plus the cleanup grace" },
  { collectionGroup: COLLECTIONS.codes, field: "expireAt", note: "core/oauth/local-store.ts; expires_at plus the cleanup grace" },
  { collectionGroup: COLLECTIONS.claims, field: "expireAt", note: "core/oauth/local-store.ts; the claimed credential's expiry plus the cleanup grace" },
];

// GCP project ids, and Firestore database ids ("(default)" or a named one).
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATABASE = /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;

export class TtlTargetError extends Error {}

export function ttlProvisioningScript(target: { project: string; database: string }, policies: readonly TtlPolicy[] = TTL_POLICIES): string {
  if (!PROJECT.test(target.project)) throw new TtlTargetError(`${JSON.stringify(target.project)} isn't a GCP project id`);
  if (!DATABASE.test(target.database)) throw new TtlTargetError(`${JSON.stringify(target.database)} isn't a Firestore database id`);
  const where = `--project='${target.project}' --database='${target.database}'`;
  const lines = [
    "#!/usr/bin/env bash",
    `# Firestore TTL policies for project ${target.project}, database ${target.database}.`,
    "# Idempotent: each policy is enabled only if it isn't already ACTIVE or CREATING.",
    "set -euo pipefail",
    "",
    "ensure_ttl() {",
    "  local group=$1 field=$2 state",
    `  state=$(gcloud firestore indexes fields describe "$field" --collection-group="$group" ${where} --format='value(ttlConfig.state)')`,
    "  case \"$state\" in",
    "    ACTIVE|CREATING) echo \"ttl $group.$field: $state\" ;;",
    `    *) echo "ttl $group.$field: \${state:-none} -> enabling"; gcloud firestore fields ttls update "$field" --collection-group="$group" ${where} --enable-ttl --async ;;`,
    "  esac",
    "}",
    "",
  ];
  for (const p of policies) {
    lines.push(`# ${p.note}`);
    lines.push(`ensure_ttl '${p.collectionGroup}' '${p.field}'`);
  }
  return `${lines.join("\n")}\n`;
}

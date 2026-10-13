#!/usr/bin/env node
/**
 * One-time: mark historical script-created item rows as non-billable.
 *
 * Local tsx scripts (corpus generation, evals) import createItem from resolvers,
 * so they wrote `type: 'item_created'` rows with `units: 1` into PROD Firestore
 * while their meter events went nowhere — .env.local carries a TEST Stripe key
 * and reportItemUsage() swallowed the failure. Those rows consume a real account's
 * allowance and would appear as the customer's own usage on the usage history
 * page. This sets them to units: 0.
 *
 * ── THIS SCRIPT IS STRUCTURALLY ONE-TIME. DO NOT MAKE IT A RECURRING JOB. ──
 *
 * It has two selectors, and they are trusted differently:
 *
 *   env === 'local'   Server truth. currentEnv() stamps it; a caller cannot set
 *                     it. Trusted at ANY date, no ceiling.
 *   client in (...)   CALLER-SUPPLIED — it flows straight from item.client /
 *                     data.client in the createItem/updateItem payloads.
 *                     Honouring that at runtime would be a billing bypass:
 *                     anyone could send client: 'training' and mint free items.
 *                     So it is trusted only BELOW the date ceiling, for rows old
 *                     enough to predate the `env` marker entirely.
 *
 * That asymmetry is the whole safety argument. Do not widen the client selector
 * past the ceiling; if script-created rows appear above it WITHOUT env: 'local',
 * the runtime guard is failing and that is the thing to fix.
 *
 * Usage:
 *   env -u FIRESTORE_EMULATOR_HOST GRAFFITICODE_APP_CREDENTIALS=$HOME/graffiticode-app-key.json \
 *     npx tsx scripts/backfill-nonbillable-usage.ts            # dry run (default)
 *     npx tsx scripts/backfill-nonbillable-usage.ts --apply    # write
 *     ... --uid <uid>      limit to one account
 *     ... --verbose        list every affected doc
 */
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { }

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (!process.env.GRAFFITICODE_APP_CREDENTIALS) {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS not set');
  process.exit(1);
}

/**
 * Past this, a `client` tag alone is not evidence of anything.
 *
 * Pinned to the day this backfill was written (2026-08-25) rather than to when
 * the `env` marker shipped (commit e5f00f0, 2026-08-21) — runs from before that
 * commit landed carry no env at all, so `client` is the only signal they have.
 * A pinned constant, not "now", is what keeps the script one-time: re-running it
 * next month reaches nothing new. Local runs after this date are caught by
 * env: 'local' instead, which needs no ceiling because the server stamps it.
 */
const GUARD_SHIPPED_AT = new Date('2026-08-26T00:00:00.000Z');

/** Clients that only ever run from a local script. */
const SCRIPT_CLIENTS = ['training', 'training-script', 'eval'];

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const ONLY_UID = (() => {
  const i = process.argv.indexOf('--uid');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GRAFFITICODE_APP_CREDENTIALS, 'utf8'))),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

const toDate = (v: any): Date | null => {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate();
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') return new Date(v);
  return null;
};

async function main() {
  console.log(`mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'}`);
  console.log(`ceiling: nothing at or after ${GUARD_SHIPPED_AT.toISOString()} is eligible\n`);

  // Census first — the eyeball check that the selector is right. `env` only
  // exists on rows written after that marker shipped, which is exactly why the
  // selector has to be `client` and not `env`.
  const all = await db.collection('usage')
    .where('type', '==', 'item_created')
    .select('client', 'env', 'units', 'userId', 'createdAt', 'nonBillableReason')
    .get();

  const cross: Record<string, number> = {};
  for (const d of all.docs) {
    const r = d.data();
    const key = `${r.client ?? '-'} | env=${r.env ?? '(absent)'} | units=${r.units ?? '?'}`;
    cross[key] = (cross[key] || 0) + 1;
  }
  console.log('census of every item_created doc (client | env | units):');
  for (const [k, v] of Object.entries(cross).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }

  // Eligible = script client AND units 1 AND older than the ceiling.
  const eligible: { ref: FirebaseFirestore.DocumentReference; uid: string; when: Date; client: string }[] = [];
  const perClient: Record<string, { matched: number; eligible: number }> = {};
  let blockedByCeiling = 0;

  for (const d of all.docs) {
    const r = d.data();
    const client = String(r.client ?? '');
    const isLocalEnv = r.env === 'local';
    if (!isLocalEnv && !SCRIPT_CLIENTS.includes(client)) continue;
    perClient[client] = perClient[client] || { matched: 0, eligible: 0 };
    perClient[client].matched++;
    if (ONLY_UID && r.userId !== ONLY_UID) continue;
    if ((r.units || 0) !== 1) continue;           // already zeroed — idempotent
    const when = toDate(r.createdAt);
    if (!when) continue;
    // Server-stamped env needs no ceiling; a caller-supplied client tag does.
    if (!isLocalEnv && when >= GUARD_SHIPPED_AT) { blockedByCeiling++; continue; }
    perClient[client].eligible++;
    eligible.push({ ref: d.ref, uid: r.userId, when, client });
  }

  console.log('\nper script client (matched by client / eligible to change):');
  for (const c of SCRIPT_CLIENTS) {
    const v = perClient[c] || { matched: 0, eligible: 0 };
    console.log(`  ${c.padEnd(16)} matched=${String(v.matched).padStart(4)}  eligible=${String(v.eligible).padStart(4)}`);
  }
  if (blockedByCeiling) {
    console.log(`\n  !! ${blockedByCeiling} doc(s) carry a script client, are newer than the ceiling,`);
    console.log('     and do NOT carry env: \'local\'. Refusing to touch them — a client tag');
    console.log('     alone is caller-supplied and proves nothing. If this is non-zero, check');
    console.log('     whether the runtime env guard is running; do not widen this script.');
  }

  // Per-user, per-affected-month deltas: what a customer's history changes from.
  const byUserMonth: Record<string, number> = {};
  for (const e of eligible) {
    byUserMonth[`${e.uid}|${e.when.toISOString().slice(0, 7)}`] =
      (byUserMonth[`${e.uid}|${e.when.toISOString().slice(0, 7)}`] || 0) + 1;
  }
  console.log('\nper-user monthly reduction in billable items:');
  for (const [k, v] of Object.entries(byUserMonth).sort()) {
    const [uid, month] = k.split('|');
    console.log(`  ${uid.slice(0, 12)}…  ${month}  -${v}`);
  }

  if (VERBOSE) {
    console.log('\ndocs:');
    for (const e of eligible) console.log(`  ${e.ref.id}  ${e.when.toISOString()}  ${e.client}  ${e.uid.slice(0, 12)}…`);
  }

  console.log(`\n${eligible.length} doc(s) eligible.`);
  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to write.');
    return;
  }
  if (!eligible.length) return;

  // Non-destructive: keep the original so the rewrite stays auditable.
  const writer = db.bulkWriter();
  const stamp = new Date().toISOString();
  for (const e of eligible) {
    writer.update(e.ref, {
      units: 0,
      unitsOriginal: 1,
      nonBillableReason: 'local-script',
      backfilledAt: stamp,
    });
  }
  await writer.close();
  console.log(`Updated ${eligible.length} doc(s).`);
  console.log('usage/{uid}.currentMonthTotal is intentionally untouched — the self-heal in');
  console.log('usage-service.ts recomputes it from these records on the next read or create.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

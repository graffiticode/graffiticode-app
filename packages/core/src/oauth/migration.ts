// The OAuth-store handover's operator jobs (installations plan, P5), run
// against a fenced source by mcp-server's `npm run oauth-migration`:
//
//   importInventory  copy the installation's clients (never overwriting), and
//                    import each live legacy token: a migration record created
//                    only if the token has none (so it never overwrites a
//                    rotation, and a racing refresh and import make one record
//                    between them), then confirmed at the source. A record the
//                    source refuses ends tombstoned; one whose outcome isn't
//                    known stays prepared for the sweeper. Re-running it
//                    duplicates nothing.
//   sweep            drive every prepared migration record to confirmed or
//                    tombstoned under its own claim, and revoke here what the
//                    source shows revoked after it migrated.
//   report           what a re-run of the inventory finds. The fallback can be
//                    retired only when no token is left that isn't marked
//                    migrated or revoked at the source, nothing here is still
//                    undecided, every revocation the source holds has been
//                    applied here (the record revoked, nothing descended from
//                    it live), and the source is sealed, so no later
//                    revocation can land there unseen. Time and quiet metrics
//                    are no evidence: legacy refresh tokens never expire.
//
// The handoff, in order: import and sweep until only the seal is missing;
// the operator seals the source; sweep once more (it applies every
// revocation the source holds, and none can arrive after); report says
// fallbackRetirable; switch to local.
import { randomBytes } from "node:crypto";
import type { LegacySource } from "./legacy-contract.js";
import type { LocalOAuthStore } from "./local-store.js";
import { ACCESS_TOKEN_PREFIX, CredentialRefused, StoreUnavailable } from "./records.js";
import type { MigratingOAuthStore } from "./store.js";

export type ImportReport = {
  clientsCopied: number;
  clientsPresent: number;
  imported: number;
  alreadyRecorded: number;
  skippedRevoked: number;
  skippedMarked: number;
  tombstoned: number;
  leftPrepared: number;
};

async function* inventory(source: LegacySource, installation: string) {
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<LegacySource["inventory"]>> = await source.inventory(installation, cursor);
    yield* page.records;
    cursor = page.next;
  } while (cursor);
}

async function outcome(store: MigratingOAuthStore, record: Parameters<MigratingOAuthStore["complete"]>[0]) {
  try {
    await store.complete(record);
    return "confirmed" as const;
  } catch (err) {
    if (err instanceof CredentialRefused) return "tombstoned" as const;
    if (err instanceof StoreUnavailable) return "prepared" as const;
    throw err;
  }
}

export async function importInventory(store: MigratingOAuthStore, local: LocalOAuthStore, source: LegacySource, installation: string, hooks: { afterPrepare?: () => void } = {}): Promise<ImportReport> {
  if (!(await store.activation.active())) throw new Error("The legacy store isn't fenced for this installation; nothing is imported before the fence.");
  const r: ImportReport = { clientsCopied: 0, clientsPresent: 0, imported: 0, alreadyRecorded: 0, skippedRevoked: 0, skippedMarked: 0, tombstoned: 0, leftPrepared: 0 };
  for await (const rec of inventory(source, installation)) {
    if (rec.kind === "client") {
      (await local.copyClient(rec.client)) ? r.clientsCopied++ : r.clientsPresent++;
      continue;
    }
    if (rec.token.revoked) { r.skippedRevoked++; continue; }
    if (rec.token.migration) { r.skippedMarked++; continue; }
    // An access token that no longer authenticates at the source is never
    // made live here: the import carries a fresh one instead, chosen once in
    // the migration record under its claim (a re-run reuses that record). The
    // refresh token, still usable, is imported as it is.
    const entry = rec.token.accessUsable
      ? rec.token.entry
      : { ...rec.token.entry, access_token: ACCESS_TOKEN_PREFIX + randomBytes(48).toString("base64url") };
    const { record, created } = await local.prepareMigration(rec.key, "import", entry);
    // Recorded already: done, or (after a crash) still prepared, completed here
    // under its own claim.
    if (!created && record.state !== "prepared") { r.alreadyRecorded++; continue; }
    if (created) hooks.afterPrepare?.();
    const o = await outcome(store, record);
    if (o === "confirmed") r.imported++;
    else if (o === "tombstoned") r.tombstoned++;
    else r.leftPrepared++;
  }
  return r;
}

// Also reconciles revocations made at the source after a token migrated:
// every confirmed record whose legacy token is revoked there is revoked here.
export async function sweep(store: MigratingOAuthStore, local: LocalOAuthStore) {
  const r = { confirmed: 0, tombstoned: 0, leftPrepared: 0, revoked: 0 };
  for (const record of await local.preparedMigrations()) {
    const o = await outcome(store, record);
    if (o === "confirmed") r.confirmed++;
    else if (o === "tombstoned") r.tombstoned++;
    else r.leftPrepared++;
  }
  for (const record of await local.confirmedMigrations()) {
    try {
      if (await store.reconcile(record)) r.revoked++;
    } catch (err) {
      if (!(err instanceof StoreUnavailable)) throw err;
    }
  }
  return r;
}

export async function report(local: LocalOAuthStore, source: LegacySource, installation: string) {
  let unmigrated = 0, migrated = 0, revoked = 0, clientsMissing = 0, unreconciled = 0;
  for await (const rec of inventory(source, installation)) {
    if (rec.kind === "client") {
      if (!(await local.getClient(rec.client.client_id))) clientsMissing++;
    } else if (rec.token.revoked) {
      revoked++;
      // Applied here: no record (never migrated), or a revoked or tombstoned
      // one with nothing descended from it still live.
      const m = await local.getMigration(rec.key);
      if (m && ((m.state !== "revoked" && m.state !== "tombstoned") || (await local.liveDescendants(rec.key)) > 0)) unreconciled++;
    } else if (rec.token.migration) migrated++;
    else unmigrated++;
  }
  const prepared = (await local.preparedMigrations(1)).length;
  const { sealed } = await source.status(installation);
  return {
    unmigrated, migrated, revoked, unreconciled, clientsMissing, prepared, sealed,
    fallbackRetirable: unmigrated === 0 && clientsMissing === 0 && prepared === 0 && unreconciled === 0 && sealed,
  };
}

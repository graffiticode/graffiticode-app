// Which traffic the funnel reports deliberately ignore.
//
// Extracted from funnel-digest.ts so BOTH consumers can share one list: the
// read-time report filter, and the write-time `internal` stamp on the workspace
// registry (src/lib/workspace-registry.ts). Read-time exclusion alone cannot
// cover anonymous traffic — see isInternalRequest below.

/**
 * Our own accounts, as the `session` value their events carry.
 *
 * Stored as the sha256(uid) hash the events already use, NOT as uids. Two
 * reasons: the comparison is then a direct lookup with no hashing at read time,
 * and the privacy contract's "never log a wallet address" stays true of the
 * source as well — most Firebase uids here ARE wallet addresses, which are
 * publicly linkable. Recover a hash's owner out-of-band by scanning the users
 * collection; don't paste the uid back in here.
 *
 * These are dev/QA accounts whose activity is indistinguishable in shape from a
 * customer's and would otherwise read as demand — the eval harness alone can
 * post dozens of items in a run.
 */
const EXCLUDED_SESSIONS = new Set([
  // Jeff — console development and manual testing.
  "c7b82fb7e78e342ae0fbe73158f0574a90992852fd90acf4e51d668838b6e5d7",
  // Eval harness (EVAL_UID) — scripts/model-eval.ts, create-eval-items.ts.
  "3fe1525d7590f241b8df5fdd5e4d01ab355bd4663c182890278bae3cf7049ed9",
]);

/**
 * Additional sessions to exclude, as a comma-separated list of sha256(uid)
 * hashes. Additive to EXCLUDED_SESSIONS so a new test account can be muted
 * without a deploy.
 */
const EXTRA_EXCLUDED = (process.env.FUNNEL_EXCLUDE_SESSIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Free-plan workspaces to treat as internal, as a comma-separated list of
 * sessionNamespace values. The account list above cannot cover these: every
 * anonymous caller shares the trial account's uid, so our own anonymous testing
 * is otherwise indistinguishable from a customer's.
 */
const INTERNAL_NAMESPACES = (process.env.FUNNEL_INTERNAL_NAMESPACES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The shared secret an internal caller presents as `X-GC-Internal`.
 *
 * A dedicated var, NOT INTERNAL_JOB_SECRET — leaking that one grants job
 * enqueue, and this value travels on ordinary developer requests. Unset means
 * the header is ignored entirely rather than trusted.
 */
const INTERNAL_TOKEN = process.env.FUNNEL_INTERNAL_TOKEN ?? "";

/** Whether this session key belongs to an account the reports ignore. */
export function isExcludedSession(key: string | undefined | null): boolean {
  if (typeof key !== "string" || !key) return false;
  return EXCLUDED_SESSIONS.has(key) || EXTRA_EXCLUDED.includes(key);
}

/**
 * Whether this request is our own traffic, decided at the moment a workspace is
 * first seen. There is no post-hoc way to answer this, which is why it is
 * stamped at creation rather than filtered at read time.
 *
 * The header must MATCH A SECRET, never merely be present: a bare boolean would
 * let anyone mark their own traffic internal and drop out of the OMTM.
 */
export function isInternalRequest(input: {
  internalHeader?: string | string[] | undefined;
  uidHash?: string;
  sessionNamespace?: string;
}): boolean {
  const header = Array.isArray(input.internalHeader)
    ? input.internalHeader[0]
    : input.internalHeader;
  if (INTERNAL_TOKEN && header && header === INTERNAL_TOKEN) return true;
  if (isExcludedSession(input.uidHash)) return true;
  if (input.sessionNamespace && INTERNAL_NAMESPACES.includes(input.sessionNamespace)) {
    return true;
  }
  return false;
}

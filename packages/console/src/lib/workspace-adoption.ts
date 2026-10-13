/**
 * Which workspace a free-plan request is operating in, and when that can be
 * rebound onto an item's own workspace.
 *
 * Pure and Firestore-free on purpose. resolvers.ts holds `const db =
 * getFirestore()` at module scope, so anything importable by a check script has
 * to live outside it — see scripts/check-free-plan-session.ts, which asserts
 * these rules without a database.
 */

export interface AdoptableAuth {
  freePlan?: boolean;
  sessionNamespace?: string;
}

/**
 * Whether a free-plan item has aged out of its 48h TTL.
 *
 * One definition, shared by the visibility checks and by sibling adoption — an
 * expired item must not be readable OR joinable, and two copies of this rule
 * would eventually disagree about which.
 */
export function isFreePlanItemExpired(itemData: any, now = Date.now()): boolean {
  return typeof itemData?.expiresAt === "number" && itemData.expiresAt <= now;
}

/**
 * Rebind the caller's workspace to the one an existing item already belongs to.
 *
 * An MCP "session" is not a durable thing — it dies on restart and on scale-out,
 * and ChatGPT mints a fresh one per tool call. Its namespace is therefore a bad
 * owner for an item that outlives it. What the client DOES re-present across all
 * that churn is the item id, which this codebase already treats as a capability
 * (see isItemVisibleToFreePlan's byId branch). So the item's namespace, not the
 * transport's, is the real workspace identity.
 *
 * Mutates `auth` deliberately: resolveAuth builds a fresh object per request, so
 * the rebind is request-scoped, and everything downstream in this request
 * (expiresAt refresh, version stamping, the claim token in the response) has to
 * see the adopted value or it will write the ephemeral one back.
 */
export function adoptWorkspace(auth: AdoptableAuth, itemData: any): void {
  if (!auth.freePlan) return;
  const owner = itemData?.sessionNamespace;
  if (typeof owner !== "string" || !owner) return;
  if (owner === auth.sessionNamespace) return;
  auth.sessionNamespace = owner;
}

/**
 * Adopt the workspace of an item the caller NAMES but is not mutating.
 *
 * A create has no item of its own to adopt from, which is why every create from a
 * transport-per-call client opened its OWN workspace — measured at 29 creates
 * across 29 namespaces for the hosted OpenAI client. The items then scatter, and
 * since a claim token addresses exactly one namespace, no single sign-in link can
 * save a conversation's work.
 *
 * The sibling id is the same capability updateItem already accepts: knowing the
 * id is what grants reach, and adopting is exactly what updateItem then does with
 * it. This widens WHICH mutation can join a workspace, not what it takes to join
 * one. Reads stay excluded — see freePlanClaimTokenFor, which deliberately mints
 * a claim token for an item without enrolling the reader in its workspace.
 */
export function adoptSiblingWorkspace(
  auth: AdoptableAuth,
  itemData: any,
  now = Date.now(),
): void {
  if (!auth.freePlan) return;
  // Mirrors isItemVisibleToFreePlan's byId branch: the id is the capability, so
  // no namespace match is required, but expiry still applies.
  if (isFreePlanItemExpired(itemData, now)) return;
  adoptWorkspace(auth, itemData);
}

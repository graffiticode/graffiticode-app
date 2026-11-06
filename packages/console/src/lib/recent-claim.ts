// Did this browser just claim trial items? /claim records it; /oauth/consent reads it.
//
// The consent page lets a new person create an account, except right after a claim:
// someone reconnecting their agent then means the account they just saved into, and
// an unknown email there is far more likely a typo than a second account. Local
// storage, not session storage, because the consent page opens in a different tab or
// pop-up (Claude's connector, `codex mcp login`) from the one that claimed.
//
// Only a timestamp is stored: no account, email, or item ids.

export const RECENT_CLAIM_KEY = 'graffiticode:claimed-at';
export const RECENT_CLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const browserStore = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // storage blocked
  }
};

export function markClaimed(now = Date.now(), store: Store | null = browserStore()): void {
  try {
    store?.setItem(RECENT_CLAIM_KEY, String(now));
  } catch {
    // Without storage the consent page allows sign-up; it still asks before creating.
  }
}

export function claimedRecently(now = Date.now(), store: Store | null = browserStore()): boolean {
  try {
    const at = Number(store?.getItem(RECENT_CLAIM_KEY));
    return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < RECENT_CLAIM_WINDOW_MS;
  } catch {
    return false;
  }
}

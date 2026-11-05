import type { NextApiRequest, NextApiResponse } from 'next';
import { readSsoCookie, bootstrapFirebaseToken } from '@graffiticode/auth-react/server';
import { createOAuthGrant, customTokenUid } from '@graffiticode-app/core/oauth-grants';
import { client } from '../../../lib/auth';

// POST /api/oauth/grant { state } — the consent page's "Allow".
//
// Mints a fresh Firebase session for the signed-in account and parks it behind a
// one-time code (core/oauth-grants.ts) that the MCP server redeems when the agent
// exchanges its authorization code. The browser only ever sees the code.
//
// Two proofs, both required:
//   - Authorization: the account's Firebase ID token — who clicked Allow.
//   - the HttpOnly gc_sso cookie: the auth service refresh token every sign-in
//     path stores. It is what mints the new session, and it must name the same
//     account, so a stale cookie from another account can't be granted away.
// A missing or mismatched cookie answers 401 sign_in_required; the page then
// asks the person to sign in again, which sets it.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const idToken = req.headers.authorization;
  if (!idToken) return res.status(401).json({ error: 'unauthorized' });
  let uid: string;
  try {
    uid = (await client.verifyToken(idToken)).uid;
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const state = req.body?.state;
  if (typeof state !== 'string' || !state || state.length > 512) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // Which check failed is logged (never the uid, cookie or token) so a pattern of
  // "sign in again" answers can be told apart: no cookie at all, a cookie the
  // auth service no longer honours, or one for a different account.
  const refreshToken = readSsoCookie(req.headers.cookie);
  const firebaseCustomToken = refreshToken ? await bootstrapFirebaseToken(refreshToken) : null;
  const refusal = !refreshToken
    ? 'no_session_cookie'
    : !firebaseCustomToken
      ? 'session_cookie_rejected'
      : customTokenUid(firebaseCustomToken) !== uid
        ? 'session_account_mismatch'
        : null;
  if (refusal) {
    console.warn(`[oauth] grant refused reason=${refusal}`);
    return res.status(401).json({ error: 'sign_in_required', reason: refusal });
  }

  try {
    const code = await createOAuthGrant({ state, uid, firebaseCustomToken });
    return res.status(200).json({ code });
  } catch (err) {
    console.error('[oauth] grant failed:', (err as Error)?.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

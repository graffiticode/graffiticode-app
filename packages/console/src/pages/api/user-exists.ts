import { getFirestore } from '../../utils/db';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || 'https://auth.graffiticode.org';
const AUTH_SERVICE_INTERNAL_API_KEY =
  process.env.AUTH_SERVICE_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || '';

const HEX = /^[0-9a-fA-F]+$/;

// Wallet sign-in creates the Firebase Auth user in the `graffiticode` project
// (see src/lib/firebase.ts), but the console runs admin SDK against
// `graffiticode-app`, so admin.auth().getUser(uid) can't see wallet uids.
// Ask the auth service — it runs in the right project. If the internal API
// key isn't configured (e.g., local dev), fall back to a Firestore presence
// check in graffiticode-app so the UX still works.
async function lookupAuthService(address: string): Promise<boolean | null> {
  if (!AUTH_SERVICE_INTERNAL_API_KEY) return null;
  const url = `${AUTH_SERVICE_URL.replace(/\/$/, '')}/authenticate/ethereum/internal/exists/${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-API-Key': AUTH_SERVICE_INTERNAL_API_KEY },
  });
  if (!res.ok) {
    console.warn('[user-exists] auth-service lookup failed', res.status);
    return null;
  }
  const body = await res.json();
  if (body?.status !== 'success') return null;
  return !!body.data?.exists;
}

async function lookupFirestore(uid: string): Promise<boolean> {
  const db = getFirestore();
  const [userDoc, itemsSnap, taskIdsSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection(`users/${uid}/items`).limit(1).get(),
    db.collection(`users/${uid}/taskIds`).limit(1).get(),
  ]);
  return userDoc.exists || !itemsSnap.empty || !taskIdsSnap.empty;
}

const handler = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const { address } = req.query;
  if (typeof address !== 'string' || !address) {
    return res.status(400).json({ error: 'address required' });
  }
  const raw = address.replace(/^0x/i, '');
  if (!HEX.test(raw)) {
    return res.status(400).json({ error: 'invalid address' });
  }
  const uid = raw.toLowerCase();
  try {
    const authResult = await lookupAuthService(raw);
    if (authResult !== null) {
      return res.status(200).json({ exists: authResult });
    }
    const exists = await lookupFirestore(uid);
    return res.status(200).json({ exists });
  } catch (err: any) {
    console.error('[user-exists] lookup failed:', err);
    return res.status(500).json({ error: 'lookup failed' });
  }
};

export default handler;

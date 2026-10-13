#!/usr/bin/env node
import admin from 'firebase-admin';

delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Set GRAFFITICODE_APP_CREDENTIALS');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'graffiticode-app',
});
const db = admin.firestore();

async function dumpUser(userId: string) {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) {
    console.log(`user ${userId} not found`);
    return;
  }
  const d = snap.data() || {};
  console.log('=== users/%s ===', userId);
  console.log('signInEmail:', d.signInEmail || d.email || '(none)');
  console.log('stripeCustomerId:', d.stripeCustomerId || '(none)');
  console.log('subscription:', JSON.stringify(d.subscription, null, 2));

  const evs = await db.collection('subscription_events')
    .where('userId', '==', userId).get();
  const sorted = evs.docs
    .map(x => x.data())
    .sort((a: any, b: any) => (tsMs(a.timestamp) - tsMs(b.timestamp)));
  console.log('--- subscription_events (%d) ---', sorted.length);
  for (const e of sorted) {
    console.log(iso(e.timestamp), e.type, 'immediately=' + e.immediately, e.reason || '', e.subscriptionId || '');
  }
}

function tsMs(t: any): number {
  if (!t) return 0;
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  return new Date(t).getTime();
}
function iso(t: any): string {
  const ms = tsMs(t);
  return ms ? new Date(ms).toISOString() : '(no ts)';
}

async function findRecentDowngrades(limit: number) {
  // Recent cancellation/downgrade events across all users.
  const evs = await db.collection('subscription_events')
    .where('type', '==', 'cancellation').get();
  const sorted = evs.docs
    .map(x => x.data())
    .sort((a: any, b: any) => tsMs(b.timestamp) - tsMs(a.timestamp))
    .slice(0, limit);
  console.log('=== recent cancellation events ===');
  for (const e of sorted) {
    console.log(iso(e.timestamp), 'user=' + e.userId, 'immediately=' + e.immediately, e.reason || '');
  }
}

const arg = process.argv[2];
(async () => {
  if (arg) await dumpUser(arg);
  else await findRecentDowngrades(15);
  process.exit(0);
})();

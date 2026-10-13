#!/usr/bin/env node

import admin from 'firebase-admin';

// Force connection to production Firestore (bypass emulator)
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Use GRAFFITICODE_APP_CREDENTIALS for the graffiticode-app project
if (process.env.GRAFFITICODE_APP_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
} else {
  console.error('Error: GRAFFITICODE_APP_CREDENTIALS environment variable not set');
  console.error('Set it to the path of your graffiticode-app service account key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "graffiticode-app"
});
const db = admin.firestore();

async function getAppNames() {
  // Items are stored in subcollections: users/{userId}/items
  const itemsRef = db.collectionGroup('items');
  const snapshot = await itemsRef.get();

  const appCounts: Record<string, number> = {};

  snapshot.forEach(doc => {
    const data = doc.data();
    const app = data.app ?? '(undefined)';
    appCounts[app] = (appCounts[app] || 0) + 1;
  });

  return appCounts;
}

async function main() {
  console.log('Fetching app names from items collection...\n');

  const appCounts = await getAppNames();

  console.log('App names and counts:');
  console.log('---------------------');

  const sortedApps = Object.entries(appCounts).sort((a, b) => b[1] - a[1]);

  for (const [app, count] of sortedApps) {
    console.log(`${app}: ${count}`);
  }

  console.log('---------------------');
  console.log(`Total unique app values: ${Object.keys(appCounts).length}`);
  console.log(`Total items: ${Object.values(appCounts).reduce((a, b) => a + b, 0)}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

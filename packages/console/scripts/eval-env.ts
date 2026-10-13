/**
 * Prod bootstrap for model-eval. Imported FIRST (before ../src/lib/code-generation-service), so
 * these env fixes land BEFORE the app's Firestore/auth modules capture them at load time —
 * ES imports evaluate in source order, and src/utils/db calls admin.initializeApp() at module load,
 * while src/lib/api-credentials captures AUTH_URL/FIREBASE_API_KEY at module load.
 *
 * model-eval drives the REAL generateCode pipeline, which uses the app's Firestore/auth/api — unlike
 * the other scripts/ that do their own admin.initializeApp() and only touch Firestore. So this mirrors
 * their prod-Firestore setup (delete emulator host, point ADC at the graffiticode-app service account)
 * AND additionally pins the auth + api URLs to prod (which the Firestore-only scripts don't need).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// Firestore → prod graffiticode-app (mirrors scripts/generate-embeddings-from-examples.ts). Emulator env
// vars come from the shell; a .env file can't unset them, so delete here before db init runs.
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (process.env.GRAFFITICODE_APP_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GRAFFITICODE_APP_CREDENTIALS;
}
// Without a key file (user ADC only) firebase-admin cannot infer the project.
process.env.GOOGLE_CLOUD_PROJECT ||= "graffiticode-app";
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("[eval-env] warning: GRAFFITICODE_APP_CREDENTIALS not set — prod Firestore reads (RAG, usage) will fail");
}

// Auth + API → prod, overriding any local-emulator values from .env.local. This harness targets prod.
process.env.NEXT_PUBLIC_GC_AUTH_URL = "https://auth.graffiticode.org";
process.env.NEXT_PUBLIC_GC_API_URL = "https://api.graffiticode.org";

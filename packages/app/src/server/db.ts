import admin from "firebase-admin";
import fs from "fs";

// Targets the graffiticode-app project where console items live under
// users/{uid}/items. Prefers an explicit service-account key for local dev
// (GOOGLE_APPLICATION_CREDENTIALS, or GRAFFITICODE_APP_CREDENTIALS from the
// shell profile); on Cloud Run neither is set and ADC uses the runtime SA.
function buildOptions(): admin.AppOptions | undefined {
  // Dev: the Firestore emulator stores console data under a single project
  // (GOOGLE_CLOUD_PROJECT=graffiticode); credentials aren't needed and the
  // project id must match or reads land in an empty namespace.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return { projectId: process.env.GOOGLE_CLOUD_PROJECT || "graffiticode" };
  }
  // Production: explicit service-account key for the graffiticode-app project.
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GRAFFITICODE_APP_CREDENTIALS;
  if (keyPath && fs.existsSync(keyPath)) {
    return { credential: admin.credential.cert(keyPath) };
  }
  return undefined;
}

// Singleton guard: firebase-admin keeps a global app registry, so re-evaluating
// this module (Next dev hot-reload) must not call initializeApp again — a second
// call with a fresh credential object throws "already exists with a different
// configuration".
if (!admin.apps.length) {
  admin.initializeApp(buildOptions());
}

export default admin;
export const getFirestore = () => admin.firestore();

import admin from "firebase-admin";

const ALLOWED_INITIALIZE_ERROR_CODES = ["app/duplicate-app"];

// The default app is initialized on first use, not at import, so importing a
// module that touches Firestore has no side effect (Phase 1e).
function ensureApp() {
  if (admin.apps.length) return;
  try {
    // Name the project rather than letting the SDK discover it. On Cloud Run
    // discovery finds graffiticode-app from the metadata server, but off GCP it
    // falls back to the developer's gcloud default — `graffiticode`, a different
    // Firestore — and every read silently comes back empty. That is how
    // scripts/funnel-report.ts reported 0 items while funnel-events held them.
    // The env still wins, so dev (.env.development) and the emulator tests keep
    // their own project.
    admin.initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "graffiticode-app",
    });
  } catch (err) {
    if (!ALLOWED_INITIALIZE_ERROR_CODES.includes(err.code)) {
      console.log(err.code);
      throw err;
    }
  }
}

export default admin;
export const getFirestore = () => {
  ensureApp();
  return admin.firestore();
};

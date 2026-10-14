import admin from "firebase-admin";

const ALLOWED_INITIALIZE_ERROR_CODES = ["app/duplicate-app"];

// The default app is initialized on first use, not at import, so importing a
// module that touches Firestore has no side effect (Phase 1e).
function ensureApp() {
  if (admin.apps.length) return;
  try {
    admin.initializeApp();
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

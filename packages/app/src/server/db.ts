// The installation's Firestore, from core's resolver (core/src/storage.ts):
// the profile's project and database, or GOOGLE_CLOUD_PROJECT without one,
// never a built-in project. Local development authenticates through
// application default credentials (GOOGLE_APPLICATION_CREDENTIALS, or the
// emulator with FIRESTORE_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT).
//
// ensureInstallation() is idempotent and pinned: it initializes the
// installation if this bundle's code runs before startup did, and fails
// closed if the profile can't be loaded.
import { ensureInstallation } from "@graffiticode-app/core/profile/runtime";
import { db } from "@graffiticode-app/core/db";

export const getFirestore = () => {
  ensureInstallation();
  return db();
};

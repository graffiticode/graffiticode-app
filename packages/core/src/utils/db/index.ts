import admin from "firebase-admin";

// The installation's Firestore (storage.ts): its project and database come
// from the installation profile or the environment, never a built-in default.
// Off GCP that matters: SDK discovery used to fall back to the developer's
// gcloud default project, and every read came back empty.
import { installationFirestore } from "../../storage.js";

export default admin;
export const getFirestore = () => installationFirestore();

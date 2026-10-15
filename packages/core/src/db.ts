import { getFirestore } from "./utils/db/index.js";

// The Firestore handle core uses. Resolved on each call, so importing core has
// no side effect; setFirestore() lets a host (or a test) supply its own.
let override: FirebaseFirestore.Firestore | null = null;

export function db(): FirebaseFirestore.Firestore {
  return override ?? getFirestore();
}

export function setFirestore(firestore: FirebaseFirestore.Firestore | null) {
  override = firestore;
}

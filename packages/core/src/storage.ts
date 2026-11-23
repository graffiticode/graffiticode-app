// The installation's Firestore handle (installations plan, P3, storage
// isolation). The only place server code creates one: db.ts and
// utils/db/index.ts delegate here, and a test fails if any other module
// initializes a Firebase Admin app or a Firestore handle.
//
// Each storage location gets its own named Admin app (one per project), and
// its database by id, so two installations can never share a handle.
import admin from "firebase-admin";
import { getFirestore as firestoreFor } from "firebase-admin/firestore";
import type { InstallationStorage } from "./profile/storage-config.js";
import { installationStorage } from "./profile/runtime.js";

const HANDLES = Symbol.for("graffiticode-app.firestore-handles");
const handles = ((globalThis as any)[HANDLES] ??= new Map<string, FirebaseFirestore.Firestore>()) as Map<string, FirebaseFirestore.Firestore>;

export function firestoreAt(s: InstallationStorage): FirebaseFirestore.Firestore {
  const key = `${s.projectId}/${s.databaseId}`;
  const cached = handles.get(key);
  if (cached) return cached;
  const appName = `installation:${s.projectId}`;
  const app = admin.apps.find(a => a?.name === appName) ?? admin.initializeApp({ projectId: s.projectId }, appName);
  const firestore = firestoreFor(app, s.databaseId);
  // Writers across the console and core build documents with optional fields
  // left `undefined` (e.g. `x || undefined`) and rely on them being dropped.
  // Before P3 1a this was set on the default app as a side effect of the RAG
  // analytics constructor; losing it broke the 2026-11-23 corpus sweep's write.
  // Set it here, on the only handle there is, before any use.
  firestore.settings({ ignoreUndefinedProperties: true });
  handles.set(key, firestore);
  return firestore;
}

// The Firestore of the installation this process runs as.
export function installationFirestore(): FirebaseFirestore.Firestore {
  return firestoreAt(installationStorage());
}

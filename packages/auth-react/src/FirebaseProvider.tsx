"use client";

import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import React, { ReactNode } from "react";
import {
  FirebaseAppProvider,
  AuthProvider,
  FirestoreProvider,
  useFirebaseApp,
} from "reactfire";
import { apiFirebaseConfig } from "./firebase-config";

function FirebaseComponents({ children }: { children: ReactNode }) {
  const app = useFirebaseApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  // In dev, talk to the local Firebase emulators (matches console). Wrapped so
  // hot-reload re-connection attempts don't throw.
  if (process.env.NODE_ENV === "development") {
    try {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
    } catch (error: any) {
      if (error.code !== "auth/emulator-config-failed") {
        throw error;
      }
    }
  }

  return (
    <AuthProvider sdk={auth}>
      <FirestoreProvider sdk={firestore}>{children}</FirestoreProvider>
    </AuthProvider>
  );
}

export function FirebaseProvider({ children }: { children: ReactNode }) {
  return (
    <FirebaseAppProvider firebaseConfig={apiFirebaseConfig}>
      <FirebaseComponents>{children}</FirebaseComponents>
    </FirebaseAppProvider>
  );
}

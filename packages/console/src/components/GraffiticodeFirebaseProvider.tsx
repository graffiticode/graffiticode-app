import { getAuth, connectAuthEmulator, } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import React, { ReactNode } from 'react'
import { FirebaseAppProvider, AuthProvider, FirestoreProvider, useFirebaseApp } from 'reactfire';
import { apiFirebaseConfig } from '../lib/firebase';

interface FirebaseComponentsProps {
  children: ReactNode;
}

function FirebaseComponents({ children }: FirebaseComponentsProps) {
  const app = useFirebaseApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  if (process.env.NODE_ENV === "development") {
    try {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
    } catch (error: any) {
      if (error.code !== 'auth/emulator-config-failed') {
        throw error;
      }
    }
  }

  return (
    <AuthProvider sdk={auth}>
      <FirestoreProvider sdk={firestore}>
        {children}
      </FirestoreProvider>
    </AuthProvider>
  );
}

interface GraffiticodeFirebaseProviderProps {
  children: ReactNode;
}

export default function GraffiticodeFirebaseProvider({ children }: GraffiticodeFirebaseProviderProps) {
  return (
    <FirebaseAppProvider firebaseConfig={apiFirebaseConfig}>
      <FirebaseComponents>
        {children}
      </FirebaseComponents>
    </FirebaseAppProvider>
  );
}

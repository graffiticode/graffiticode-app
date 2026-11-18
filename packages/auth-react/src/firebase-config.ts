// The web config of the Firebase project users sign in to (the shared
// authentication service), as the installation's public configuration states
// it (/api/config). Distinct from where any installation keeps its data.
export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  databaseURL?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
};

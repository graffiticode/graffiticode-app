import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";

// Note: This is the client-side Firebase config for authentication
// The server-side scripts use 'graffiticode-app' as the project ID
export const apiFirebaseConfig = {
  apiKey: "AIzaSyAoVuUNi8ElnS7cn6wc3D8XExML-URLw0I",
  authDomain: "graffiticode.firebaseapp.com",
  databaseURL: "https://graffiticode.firebaseio.com",
  projectId: "graffiticode",
  storageBucket: "graffiticode.appspot.com",
  messagingSenderId: "656973052505",
  appId: "1:656973052505:web:f3f3cc6397a844599c8f48",
  measurementId: "G-KRPK1CDB19"
};

const apiApp = initializeApp(apiFirebaseConfig);
const apiAuthInternal = getAuth(apiApp);

if (process.env.NODE_ENV === "development") {
  connectAuthEmulator(apiAuthInternal, "http://localhost:9099", { disableWarnings: true });
}

export const apiAuth = apiAuthInternal;

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { apiFirebaseConfig } from '../../lib/firebase';

const isDevelopment = process.env.NODE_ENV === 'development';

// Allowlisted callback URL patterns
const ALLOWED_CALLBACK_PATTERNS = [
  /^https:\/\/[^/]*\.graffiticode\.org(\/|$)/,
  /^https:\/\/graffiticode\.org(\/|$)/,
  /^https:\/\/[^/]*\.run\.app(\/|$)/,
  /^https:\/\/claude\.ai(\/|$)/,
  /^https:\/\/claude\.com(\/|$)/,
  /^http:\/\/localhost(:\d+)?(\/|$)/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
];

function isValidCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    return ALLOWED_CALLBACK_PATTERNS.some(pattern => pattern.test(url));
  } catch {
    return false;
  }
}

// Firebase config with authDomain pointing to Firebase Hosting
// (required for OAuth to work - needs /__/auth/handler)
const oauthFirebaseConfig = {
  ...apiFirebaseConfig,
  authDomain: "graffiticode.firebaseapp.com",
};

// Create a separate Firebase app instance for OAuth
let oauthAuthInstance: ReturnType<typeof getAuth> | null = null;

const getOAuthAuth = () => {
  if (oauthAuthInstance) return oauthAuthInstance;

  const appName = 'oauth-consent-helper';
  const existingApp = getApps().find(app => app.name === appName);
  const app = existingApp || initializeApp(oauthFirebaseConfig, appName);
  oauthAuthInstance = getAuth(app);

  if (isDevelopment) {
    try {
      connectAuthEmulator(oauthAuthInstance, 'http://localhost:9099', { disableWarnings: true });
    } catch {
      // Already connected
    }
  }

  return oauthAuthInstance;
};

const cleanupOAuthSession = async (oauthAuth: ReturnType<typeof getAuth>) => {
  if (!isDevelopment) {
    await signOut(oauthAuth);
  }
};

export default function OAuthConsent() {
  const router = useRouter();
  const { callback_url, state, app_name } = router.query;

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const callbackUrl = Array.isArray(callback_url) ? callback_url[0] : callback_url;
  const stateParam = Array.isArray(state) ? state[0] : state;
  const appName = Array.isArray(app_name) ? app_name[0] : app_name || 'an application';

  // Validate parameters once router is ready
  useEffect(() => {
    if (!router.isReady) return;

    if (!callbackUrl) {
      setValidationError('Missing required parameter: callback_url');
      return;
    }

    if (!stateParam) {
      setValidationError('Missing required parameter: state');
      return;
    }

    if (!isValidCallbackUrl(callbackUrl)) {
      setValidationError('Invalid callback URL');
      return;
    }

    setValidationError(null);
  }, [router.isReady, callbackUrl, stateParam]);

  const handleSignIn = async () => {
    if (!callbackUrl || !stateParam) return;

    try {
      setLoading(true);
      setError(null);

      const oauthAuth = getOAuthAuth();
      const provider = new GoogleAuthProvider();

      // Use popup with Firebase Hosting authDomain
      const result = await signInWithPopup(oauthAuth, provider);
      const idToken = await result.user.getIdToken();

      // Clean up helper auth session
      await cleanupOAuthSession(oauthAuth);

      // Show success state before redirect (page may stay open after protocol handler)
      setLoading(false);
      setSuccess(true);

      // Hand the Google ID token back by POSTing a form, NOT by putting it in the
      // URL. A query string is recorded in the CDN and Cloud Run access logs (a real
      // user's id_token was found sitting in plaintext in Cloud Logging), kept in
      // browser history, and can leak via Referer. A form body is in none of those.
      // The MCP server accepts POST at /oauth/callback and answers 303, so the
      // browser follows on to the client's redirect_uri with a GET.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = callbackUrl;
      form.style.display = 'none';
      for (const [name, value] of [
        ['google_id_token', idToken],
        ['state', stateParam],
      ]) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (err: any) {
      console.error('OAuth consent error:', err);
      if (err.code === 'auth/popup-closed-by-user') {
        setError('Sign-in was cancelled');
      } else if (err.code === 'auth/popup-blocked') {
        setError('Popup was blocked. Please allow popups for this site and try again.');
      } else {
        setError(err.message || 'Failed to sign in with Google');
      }
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (!callbackUrl || !stateParam) return;

    // Redirect back with error
    const redirectUrl = new URL(callbackUrl);
    redirectUrl.searchParams.set('error', 'access_denied');
    redirectUrl.searchParams.set('error_description', 'User cancelled the sign-in');
    redirectUrl.searchParams.set('state', stateParam);

    window.location.href = redirectUrl.toString();
  };

  return (
    <>
      <Head>
        <title>Sign in - Graffiticode</title>
      </Head>
      <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <h2 className="text-center text-3xl font-bold tracking-tight text-gray-900">
            Graffiticode
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Sign in to connect to {appName}
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
            {validationError ? (
              <div className="text-center">
                <div className="rounded-md bg-red-50 p-4">
                  <p className="text-sm text-red-700">{validationError}</p>
                </div>
              </div>
            ) : success ? (
              <div className="text-center">
                <div className="rounded-md bg-green-50 p-4">
                  <div className="flex justify-center mb-2">
                    <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </div>
                  <p className="text-sm text-green-700 font-medium">Sign-in successful!</p>
                  <p className="text-xs text-green-600 mt-1">You can close this window.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center mb-6">
                  <p className="text-sm text-gray-500">
                    <span className="font-medium text-gray-900">{appName}</span> wants to access your Graffiticode account
                  </p>
                </div>

                {error && (
                  <div className="rounded-md bg-red-50 p-4 mb-4">
                    <p className="text-sm text-red-700">{error}</p>
                  </div>
                )}

                <div className="space-y-4">
                  <button
                    onClick={handleSignIn}
                    disabled={loading}
                    className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-none shadow-sm text-sm font-medium text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Signing in...
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        Sign in with Google
                      </>
                    )}
                  </button>

                  <button
                    onClick={handleCancel}
                    disabled={loading}
                    className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                </div>

                <div className="mt-6">
                  <p className="text-xs text-center text-gray-500">
                    By signing in, you agree to share your Graffiticode account information with {appName}.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

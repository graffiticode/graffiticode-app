import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from 'reactfire';
import { signOut } from 'firebase/auth';
import useGraffiticodeAuth, { useEmailSignIn } from '@graffiticode/auth-react';
import AuthMethodDialog from '../../components/AuthMethodDialog';
import WalletSelectionDialog from '../../components/WalletSelectionDialog';
import { getPageTitle } from '../../lib/utils';

// The OAuth consent step for agents connecting to Graffiticode (Codex, Claude,
// ChatGPT…). The MCP server's /oauth/authorize sends the browser here with
// callback_url (its /oauth/callback), its internal state, and the client's name.
//
// Sign-in is the console's own — email or Ethereum wallet, the same dialog
// /claim uses — so any Graffiticode account can connect. (This page used to be
// Google-only, and Google is only an account-linking option here, so most
// accounts could not get through it.)
//
// Sign-in ONLY: an email or wallet that matches no account is told so, never
// given a new one. Someone connecting an agent nearly always means an account
// they already have (often the one they just saved items into), and a silently
// created empty account would connect the agent to the wrong place.
//
// "Allow" asks /api/oauth/grant for a one-time code and POSTs only that code to
// the MCP server, which redeems it server-to-server when the agent exchanges its
// authorization code. No credential passes through the browser or a URL.

interface Wallet {
  name: string;
  provider: any;
}

// Allowlisted callback URL patterns: the MCP server's own origins (and local dev).
const ALLOWED_CALLBACK_PATTERNS = [
  /^https:\/\/[^/]*\.graffiticode\.org(\/|$)/,
  /^https:\/\/graffiticode\.org(\/|$)/,
  /^https:\/\/[^/]*\.run\.app(\/|$)/,
  /^http:\/\/localhost(:\d+)?(\/|$)/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
];

function isValidCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return ALLOWED_CALLBACK_PATTERNS.some((pattern) => pattern.test(url));
  } catch {
    return false;
  }
}

// Stashed because signing in remounts the page and can empty router.query
// (the same reason /claim stashes its token).
const CONSENT_KEY = 'graffiticode:oauth-consent';
type ConsentParams = { callbackUrl: string; state: string; appName: string };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function readStash(): ConsentParams | null {
  try {
    const raw = sessionStorage.getItem(CONSENT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.callbackUrl && parsed?.state ? parsed : null;
  } catch {
    return null;
  }
}

// POST the fields to the MCP server: a form body stays out of URLs, access logs,
// history and Referer. The server answers 303 to the agent's redirect_uri.
function postToCallback(callbackUrl: string, fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = callbackUrl;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

export default function OAuthConsent() {
  const router = useRouter();
  const auth = useAuth();
  const { user, loading, beginEthereumSignIn } = useGraffiticodeAuth();
  // allowSignup off: an unmatched email comes back 'needs-confirm' instead of
  // creating an account (see the note at the top of the file).
  const {
    sendCode,
    verifyAndSignIn,
    cancelSignup,
    reset: resetEmailFlow,
    sending: emailSending,
    verifying: codeVerifying,
    emailError,
    codeError,
  } = useEmailSignIn({ allowSignup: false });

  const [params, setParams] = useState<ConsentParams | null>(null);
  const [paramsChecked, setParamsChecked] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showWalletDialog, setShowWalletDialog] = useState(false);
  const [granting, setGranting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the email or wallet someone signed in with has no account.
  const [noAccount, setNoAccount] = useState<'email' | 'wallet' | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const callbackUrl = first(router.query.callback_url);
    const state = first(router.query.state);
    let next: ConsentParams | null = null;
    if (callbackUrl || state) {
      if (!callbackUrl || !state) {
        setValidationError('This sign-in link is incomplete. Start connecting from your agent again.');
      } else if (!isValidCallbackUrl(callbackUrl)) {
        setValidationError('This sign-in link is not valid.');
      } else {
        next = { callbackUrl, state, appName: first(router.query.app_name) || 'An application' };
        try {
          sessionStorage.setItem(CONSENT_KEY, JSON.stringify(next));
        } catch {
          // Without storage a sign-in remount loses the request; nothing to do here.
        }
      }
    } else {
      next = readStash();
      if (!next) setValidationError('This sign-in link is missing its details. Start connecting from your agent again.');
    }
    setParams(next);
    setParamsChecked(true);
  }, [router.isReady, router.query.callback_url, router.query.state, router.query.app_name]);

  const clearStash = () => {
    try {
      sessionStorage.removeItem(CONSENT_KEY);
    } catch {
      // ignore
    }
  };

  const handleAllow = async () => {
    if (!user || !params || granting) return;
    setGranting(true);
    setError(null);
    try {
      const idToken = await user.getToken();
      const res = await fetch('/api/oauth/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: idToken },
        body: JSON.stringify({ state: params.state }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && body?.error === 'sign_in_required') {
        // The browser's sign-in session has lapsed or belongs to another account.
        // Signing in again refreshes it.
        await signOut(auth).catch(() => {});
        setError('Please sign in again to connect this account.');
        return;
      }
      if (!res.ok || typeof body?.code !== 'string') {
        throw new Error('Could not connect your account. Please try again.');
      }
      clearStash();
      setDone(true);
      postToCallback(params.callbackUrl, { grant: body.code, state: params.state });
    } catch (err: any) {
      setError(err?.message || 'Could not connect your account. Please try again.');
    } finally {
      setGranting(false);
    }
  };

  const handleCancel = () => {
    if (!params) return;
    clearStash();
    postToCallback(params.callbackUrl, {
      error: 'access_denied',
      error_description: 'The user declined to connect',
      state: params.state,
    });
  };

  const handleSwitchAccount = async () => {
    setError(null);
    await signOut(auth).catch((err) => console.error(err));
  };

  const handleSubmitCode = async (code: string) => {
    const result = await verifyAndSignIn(code);
    if (result === 'needs-confirm') {
      await cancelSignup().catch(() => {});
      setNoAccount('email');
    }
    return result;
  };

  const handleWalletSelect = async (wallet: Wallet) => {
    try {
      // begin, never confirm: a wallet with no account comes back pending and is
      // left that way.
      const pending = await beginEthereumSignIn(wallet);
      setShowWalletDialog(false);
      if (pending?.needsSignupConfirm) setNoAccount('wallet');
    } catch (err) {
      console.error(err);
    }
  };

  const tryAnotherWay = () => {
    resetEmailFlow();
    setNoAccount(null);
  };

  if (!router.isReady || loading || !paramsChecked) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-100px)]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  const shell = (body: React.ReactNode) => (
    <>
      <Head><title>{getPageTitle('Connect')}</title></Head>
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-100px)] px-4 py-8">
        <div className="w-full max-w-sm flex flex-col items-center text-center">{body}</div>
      </div>
    </>
  );

  if (validationError || !params) {
    return shell(
      <>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Can&rsquo;t connect</h1>
        <p className="text-sm text-gray-600">{validationError}</p>
      </>,
    );
  }

  if (done) {
    return shell(
      <>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Connected</h1>
        <p className="text-sm text-gray-600">You can close this window and return to {params.appName}.</p>
      </>,
    );
  }

  if (user) {
    const account = user.email || user.uid;
    return shell(
      <>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Connect {params.appName}</h1>
        <p className="text-sm text-gray-600 mb-1">
          {params.appName} wants to create and edit items in this Graffiticode account:
        </p>
        <p className="text-sm font-medium text-gray-900 mb-5 break-all">{account}</p>
        {error && <p className="text-sm text-red-700 mb-4">{error}</p>}
        <button
          type="button"
          disabled={granting}
          className="w-full rounded-none border border-gray-900 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50 mb-3"
          onClick={handleAllow}
        >
          {granting ? 'Connecting…' : 'Allow'}
        </button>
        <button
          type="button"
          disabled={granting}
          className="w-full rounded-none border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 mb-3"
          onClick={handleSwitchAccount}
        >
          Use a different account
        </button>
        <button
          type="button"
          disabled={granting}
          className="text-sm text-gray-500 underline disabled:opacity-50"
          onClick={handleCancel}
        >
          Cancel
        </button>
      </>,
    );
  }

  if (noAccount) {
    return shell(
      <>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">No account found</h1>
        <p className="text-sm text-gray-600 mb-2">
          No Graffiticode account uses that {noAccount === 'email' ? 'email' : 'wallet'}. Sign in with the
          email or wallet you signed up with, or used when you saved your items.
        </p>
        <p className="text-sm text-gray-600 mb-5">
          New to Graffiticode? Create an account at console.graffiticode.org, then connect again.
        </p>
        <button
          type="button"
          className="w-full rounded-none border border-gray-900 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 mb-3"
          onClick={tryAnotherWay}
        >
          Try another email or wallet
        </button>
        <button type="button" className="text-sm text-gray-500 underline" onClick={handleCancel}>
          Cancel
        </button>
      </>,
    );
  }

  return (
    <>
      <Head><title>{getPageTitle('Connect')}</title></Head>
      {error && (
        <p className="pt-8 text-center text-sm text-red-700">{error}</p>
      )}
      {/* One Headless UI Dialog open at a time — see claim.tsx. */}
      <AuthMethodDialog
        isOpen={!showWalletDialog}
        // Dismissing sign-in declines the connection, but never while a code is
        // in flight: Privy raises its own overlay while creating a wallet.
        onClose={() => {
          if (codeVerifying || emailSending) return;
          handleCancel();
        }}
        onSelectEthereum={() => setShowWalletDialog(true)}
        onSubmitEmail={sendCode}
        onSubmitCode={handleSubmitCode}
        emailSending={emailSending}
        emailError={emailError}
        codeVerifying={codeVerifying}
        codeError={codeError}
        variant="connect"
      />
      <WalletSelectionDialog
        isOpen={showWalletDialog}
        onClose={() => setShowWalletDialog(false)}
        onSelectWallet={handleWalletSelect}
      />
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from 'reactfire';
import { signOut } from 'firebase/auth';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { useEmailSignIn } from '@graffiticode/auth-react';
import AuthMethodDialog from '../components/AuthMethodDialog';
import WalletSelectionDialog from '../components/WalletSelectionDialog';
import ConnectAgentInstructions, {
  hostTakesApiKey,
  parseClientHost,
  type ClientHost,
} from '../components/ConnectAgentInstructions';
import { client } from '../lib/auth';
import { getPageTitle } from '../lib/utils';

interface Wallet {
  name: string;
  provider: any;
}

// Persisted so the token survives the sign-in remount: the auth provider
// unmounts the whole tree while Firebase status is "loading" during
// signInWithCustomToken, after which router.query.token can momentarily be
// empty. The stashed copy lets the claim proceed regardless.
const CLAIM_TOKEN_KEY = 'graffiticode:claim-token';
// The agent the claim link came from (`agent=` on the URL, set by the MCP server).
// Stashed for the same reason the token is: the sign-in remount empties router.query,
// and losing it would drop the user onto generic instructions for an agent we knew.
const CLAIM_AGENT_KEY = 'graffiticode:claim-agent';

export default function Claim() {
  const router = useRouter();
  const auth = useAuth();
  const { user, loading, signInWithEthereum } = useGraffiticodeAuth();
  // /claim is the explicit "convert trial to account" surface, so unmatched
  // emails should create new accounts without prompting.
  const {
    sendCode,
    verifyAndSignIn,
    sending: emailSending,
    verifying: codeVerifying,
    emailError,
    codeError,
  } = useEmailSignIn({ allowSignup: true });

  const [token, setToken] = useState<string | null>(null);
  // False until the resolving effect has checked both the URL and the stash —
  // gates rendering so the "Invalid claim link" branch can't flash before the
  // stashed token is read on a sign-in remount.
  const [tokenChecked, setTokenChecked] = useState(false);
  const [showWalletDialog, setShowWalletDialog] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimEmpty, setClaimEmpty] = useState(false);
  const [host, setHost] = useState<ClientHost>('unknown');
  // Set once the copy succeeds — this is the success screen's gate, and it holds the
  // item we hand the "Open item" button.
  const [claimed, setClaimed] = useState<{ count: number; target: string } | null>(null);
  const [apiKey, setApiKey] = useState<{ id: string; token: string } | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Guards against double-submits within a mount (the success path also clears
  // the stashed token, so a remount can't re-run the non-idempotent copy).
  const claimingRef = useRef(false);
  // The sign-in flow remounts this page, so without a guard one visit would
  // report several views and overstate the top of the funnel.
  const viewLoggedRef = useRef(false);
  // Same guard, one stage later: the dialog re-renders freely (wallet picker
  // opening and closing, auth state settling), and "was it shown" is a per-visit
  // fact, not a per-render one.
  const authShownLoggedRef = useRef(false);
  // Held in a ref so the later stages attribute to the same surface as the view.
  // Only the URL-param visit carries `src`; a reload off the stashed token has
  // genuinely lost it, and 'unknown' is the honest answer there.
  const srcRef = useRef('unknown');

  // Resolve the claim token once the router is ready and persist it. Prefer the
  // URL param; fall back to the stashed copy after a sign-in remount.
  useEffect(() => {
    if (!router.isReady) return;
    const fromQuery = typeof router.query.token === 'string' ? router.query.token : null;
    // `agent`, not `client`: _app.tsx already consumes `?client=` app-wide as the
    // item source surface (console|mcp|front).
    const agentFromQuery = typeof router.query.agent === 'string' ? router.query.agent : null;
    if (agentFromQuery) {
      sessionStorage.setItem(CLAIM_AGENT_KEY, agentFromQuery);
      setHost(parseClientHost(agentFromQuery));
    } else {
      setHost(parseClientHost(sessionStorage.getItem(CLAIM_AGENT_KEY)));
    }
    if (fromQuery) {
      sessionStorage.setItem(CLAIM_TOKEN_KEY, fromQuery);
      setToken(fromQuery);
      // Report the open on the URL-param visit only: that's the real arrival.
      // The stashed-token branch is the post-sign-in remount of the same visit.
      srcRef.current = typeof router.query.src === 'string' ? router.query.src : 'unknown';
      if (!viewLoggedRef.current) {
        viewLoggedRef.current = true;
        // Fire-and-forget: telemetry must never delay or break a claim.
        fetch('/api/claim-view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: fromQuery, src: srcRef.current, stage: 'view' }),
        }).catch(() => {});
      }
    } else {
      setToken(sessionStorage.getItem(CLAIM_TOKEN_KEY));
    }
    setTokenChecked(true);
  }, [router.isReady, router.query.token, router.query.agent]);

  // Post a later funnel stage for this same visit. Reads the stashed token when
  // state hasn't caught up, since these fire from render-driven effects that can
  // run before the resolving effect's setToken has landed.
  const postClaimStage = useCallback((stage: 'auth_shown' | 'email_submitted') => {
    const claimToken = token || sessionStorage.getItem(CLAIM_TOKEN_KEY);
    if (!claimToken) return;
    // Fire-and-forget: telemetry must never delay or break a claim.
    fetch('/api/claim-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: claimToken, src: srcRef.current, stage }),
    }).catch(() => {});
  }, [token]);

  // The sign-in dialog is now in front of them. These are exactly the conditions
  // the dialog branch renders under (see the final return) — recorded from an
  // effect rather than that branch so it fires once per visit, not once per
  // render. Without this stage, a visit that got here and one that never
  // rendered anything are the same single claim_view.
  useEffect(() => {
    if (!router.isReady || loading || !tokenChecked) return;
    if (!token || user) return;
    if (authShownLoggedRef.current) return;
    authShownLoggedRef.current = true;
    postClaimStage('auth_shown');
  }, [router.isReady, loading, tokenChecked, token, user, postClaimStage]);

  // Records the ATTEMPT, never the address — see logClaimStage in resolvers.ts.
  // Deliberately fires before the send rather than after it succeeds: a send that
  // fails is still someone who agreed to hand over an email, and that is the
  // conversion question. It fires per attempt, so a second submission in one
  // visit reads as the first not arriving.
  const handleSubmitEmail = useCallback(async (email: string) => {
    postClaimStage('email_submitted');
    return sendCode(email);
  }, [postClaimStage, sendCode]);

  // The copy is an explicit user action (Save button) on a stable, signed-in
  // page — not a passive effect racing the sign-in remount.
  const runClaim = async () => {
    if (!user || !token || claimingRef.current) return;
    claimingRef.current = true;
    setClaiming(true);
    setClaimError(null);
    setClaimEmpty(false);
    try {
      const idToken = await user.getToken();
      const resp = await fetch('/api', {
        method: 'POST',
        headers: {
          Authorization: idToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation ClaimFreePlanSession($token: String!) {
            claimFreePlanSession(token: $token) {
              transferred
              sessionNamespace
              items { id lang }
            }
          }`,
          variables: { token },
        }),
      });
      const json = await resp.json();
      if (json.errors?.length) {
        throw new Error(json.errors[0].message);
      }
      const result = json.data?.claimFreePlanSession;
      const items: { id: string; lang: string }[] = Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0) {
        sessionStorage.removeItem(CLAIM_TOKEN_KEY);
        setClaimEmpty(true);
        return;
      }
      // Clear before showing the success screen so a remount or re-visit can't
      // re-run the copy.
      sessionStorage.removeItem(CLAIM_TOKEN_KEY);
      // The items are safe now, but the agent that made them is still anonymous —
      // and this is the one moment we have the user's attention to fix that. So we
      // stop here instead of dropping them straight into the editor; "Open item"
      // still gets them there in one click.
      //
      // The ?lang= param (honored by _app.tsx) makes the claimed item's language
      // active from first paint, so the items sidebar lists the claimed items
      // immediately instead of the previously selected language's list.
      const target = items[0].lang
        ? `/items/${items[0].id}?lang=${items[0].lang}`
        : `/items/${items[0].id}`;
      setClaimed({ count: items.length, target });
    } catch (err: any) {
      // Leave the token in place so "Try again" can retry.
      setClaimError(err?.message || 'Failed to claim items');
    } finally {
      claimingRef.current = false;
      setClaiming(false);
    }
  };

  // Mint a key for the config-file hosts, mirroring APIKeysCard's create path
  // (client.apiKeys.create runs against the auth service, so nothing server-side in
  // this repo sees it — hence the beacon). `source: 'claim'` separates keys minted
  // here from keys minted in Settings, which is how we'll know whether this screen
  // does anything.
  const handleCreateKey = async () => {
    if (!user || creatingKey) return;
    setCreatingKey(true);
    setKeyError(null);
    try {
      const userToken = await user.getToken();
      const created = await client.apiKeys.create(userToken);
      setApiKey(created);
      void fetch('/api/beacon/api-key-created', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid, source: 'claim' }),
      }).catch(() => {});
    } catch (err: any) {
      setKeyError(err?.message || 'Failed to create an API key');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleSelectEthereum = () => {
    setShowWalletDialog(true);
  };

  const handleWalletSelect = async (wallet: Wallet) => {
    try {
      await signInWithEthereum(wallet);
      setShowWalletDialog(false);
    } catch (err) {
      console.error(err);
    }
  };

  // Sign out WITHOUT the global redirect: useGraffiticodeAuth().signOut sends
  // the user to '/', which would drop the claim context. Signing out in place
  // keeps us on /claim and re-shows the sign-in dialog; the stashed token
  // survives the switch so the user can claim into the new account.
  const handleSwitchAccount = async () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('graffiticode:selected:itemId');
      localStorage.removeItem('graffiticode:selected:taskId');
      localStorage.removeItem('graffiticode:language');
    }
    setClaimError(null);
    setClaimEmpty(false);
    try {
      await signOut(auth);
    } catch (err) {
      console.error(err);
    }
  };

  if (!router.isReady || loading || !tokenChecked) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-100px)]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!token) {
    return (
      <>
        <Head><title>{getPageTitle('Claim')}</title></Head>
        <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)] px-4">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Invalid claim link</h1>
          <p className="text-sm text-gray-600 text-center max-w-sm">
            This claim link is missing or malformed. Ask your assistant to send a new one.
          </p>
        </div>
      </>
    );
  }

  // Claimed: items are safe. Offer the connect step before the editor.
  if (user && claimed) {
    return (
      <>
        <Head><title>{getPageTitle('Claim')}</title></Head>
        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-100px)] px-4 py-8">
          <div className="w-full max-w-md flex flex-col">
            <h1 className="text-xl font-semibold text-gray-900 mb-1 text-center">
              Saved {claimed.count} {claimed.count === 1 ? 'item' : 'items'}
            </h1>
            <p className="text-sm text-gray-600 mb-6 text-center">
              They&rsquo;re in your account now.
            </p>

            <div className="border-t border-gray-200 pt-5 mb-6">
              <ConnectAgentInstructions
                host={host}
                onHostChange={(next) => {
                  setHost(next);
                  // A host switch can move between key-taking and not; drop a key the
                  // user hasn't used rather than leaving a stale secret on screen.
                  if (!hostTakesApiKey(next)) setApiKey(null);
                }}
                apiKey={apiKey}
                onCreateKey={handleCreateKey}
                creatingKey={creatingKey}
                keyError={keyError}
              />
            </div>

            <button
              type="button"
              className="w-full rounded-none border border-gray-900 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800"
              // Hard navigation, not router.push: /claim has just been through the
              // auth provider's sign-in remount, and an SPA route change silently
              // no-ops in that state — the URL never changes.
              onClick={() => window.location.assign(claimed.target)}
            >
              Open item
            </button>
          </div>
        </div>
      </>
    );
  }

  if (user) {
    const account = user.email || user.uid;
    return (
      <>
        <Head><title>{getPageTitle('Claim')}</title></Head>
        <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)] px-4">
          {claiming && (
            <>
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mb-4"></div>
              <p className="text-sm text-gray-600">Saving your items...</p>
            </>
          )}

          {!claiming && claimError && (
            <>
              <h1 className="text-xl font-semibold text-gray-900 mb-2">Couldn&rsquo;t save your items</h1>
              <p className="text-sm text-red-700 text-center max-w-sm mb-4">{claimError}</p>
              <button
                type="button"
                className="rounded-none border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={runClaim}
              >
                Try again
              </button>
            </>
          )}

          {!claiming && !claimError && claimEmpty && (
            <>
              <h1 className="text-xl font-semibold text-gray-900 mb-2">Nothing to claim</h1>
              <p className="text-sm text-gray-600 text-center max-w-sm mb-4">
                This trial session has expired or never contained any items.
              </p>
              <button
                type="button"
                className="rounded-none border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => router.replace('/items')}
              >
                Go to items
              </button>
            </>
          )}

          {!claiming && !claimError && !claimEmpty && (
            <div className="w-full max-w-sm flex flex-col items-center text-center">
              <h1 className="text-xl font-semibold text-gray-900 mb-2">Save your items</h1>
              <p className="text-sm text-gray-600 mb-1">Save these items to this account?</p>
              <p className="text-sm font-medium text-gray-900 mb-5 break-all">{account}</p>
              <button
                type="button"
                className="w-full rounded-none border border-gray-900 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 mb-3"
                onClick={runClaim}
              >
                Save to this account
              </button>
              <button
                type="button"
                className="w-full rounded-none border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                onClick={handleSwitchAccount}
              >
                Use a different account
              </button>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>{getPageTitle('Claim')}</title></Head>
      {/* Only one Headless UI Dialog may be open at a time: two open at the same
          z-index make the underlying one fire onClose (which here navigates to
          '/'). Closing the auth dialog when the wallet picker opens avoids that
          and lets the wallet picker show. Mirrors SignIn.tsx's handleSelectEthereum. */}
      <AuthMethodDialog
        isOpen={!showWalletDialog}
        // Only a deliberate dismissal may leave the page. Headless UI fires
        // onClose for any overlay/escape/outside-click, and Privy raises its own
        // overlay while creating the embedded wallet — so on the create-account
        // path this navigated to '/' mid-sign-in, the claim mutation never ran,
        // and the user landed in a brand-new empty account with their items left
        // behind. Signing in is exactly when abandoning the claim is worst.
        onClose={() => {
          if (codeVerifying || emailSending || claiming) return;
          router.push('/');
        }}
        onSelectEthereum={handleSelectEthereum}
        onSubmitEmail={handleSubmitEmail}
        onSubmitCode={verifyAndSignIn}
        emailSending={emailSending}
        emailError={emailError}
        codeVerifying={codeVerifying}
        codeError={codeError}
        variant="claim"
      />
      <WalletSelectionDialog
        isOpen={showWalletDialog}
        onClose={() => setShowWalletDialog(false)}
        onSelectWallet={handleWalletSelect}
      />
    </>
  );
}

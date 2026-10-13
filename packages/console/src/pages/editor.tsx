import { useRouter } from 'next/router';
import Head from 'next/head';
import { useEffect, useState, useRef } from 'react';
import { useAuth } from 'reactfire';
import { signInWithCustomToken } from 'firebase/auth';
import useGraffiticodeAuth from "@graffiticode/auth-react";
import { createItem } from '../utils/swr/fetchers';
import { getPageTitle } from '../lib/utils';
import SignIn from '../components/SignIn';
import Gallery from '../components/gallery';

export default function Editor({ language, setLanguage, mark }) {
  const router = useRouter();
  const { lang: rawLang, itemId: rawItemId, mode, origin, token: rawToken } = router.query;
  const lang = Array.isArray(rawLang) ? rawLang[0] : rawLang;
  const itemId = Array.isArray(rawItemId) ? rawItemId[0] : rawItemId;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const auth = useAuth();
  const { user, loading: authLoading } = useGraffiticodeAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [createdItemId, setCreatedItemId] = useState(null);
  const [error, setError] = useState(null);
  const [isTokenSigningIn, setIsTokenSigningIn] = useState(false);
  const creationStarted = useRef(false);
  const tokenSignInAttempted = useRef(false);
  const openerWindowRef = useRef(null);
  const pendingItemCreatedRef = useRef(null);

  // Handle token-based sign-in from URL parameter
  useEffect(() => {
    if (!token || user || tokenSignInAttempted.current) return;

    tokenSignInAttempted.current = true;
    setIsTokenSigningIn(true);

    const signInWithToken = async () => {
      try {
        await signInWithCustomToken(auth, token);
        // Don't set isTokenSigningIn to false here - let the user state change handle it
      } catch (err) {
        console.error('[Editor] Token sign-in failed:', err);
        setError('Failed to authenticate with provided token');
        setIsTokenSigningIn(false);
      }
    };

    signInWithToken();
  }, [token, user, auth]);

  // Clear token signing in state when user becomes available
  useEffect(() => {
    if (user && isTokenSigningIn) {
      setIsTokenSigningIn(false);
    }
  }, [user, isTokenSigningIn]);

  // Listen for establish-communication from the opener window (e.g. Learnosity custom layout)
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'establish-communication' && event.source) {
        console.log('[Editor] Received establish-communication from', event.origin);
        openerWindowRef.current = event.source;
        // Send acknowledgment
        try {
          (event.source as Window).postMessage({ type: 'graffiticode-ready' }, event.origin);
        } catch (e) {
          console.warn('[Editor] Failed to send graffiticode-ready:', e);
        }
        // Send any pending item-created message
        if (pendingItemCreatedRef.current) {
          try {
            (event.source as Window).postMessage(pendingItemCreatedRef.current, event.origin);
            console.log('[Editor] Sent pending item-created to', event.origin);
          } catch (e) {
            console.error('[Editor] Failed to send pending item-created:', e);
          }
          pendingItemCreatedRef.current = null;
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (!lang || mode !== 'editor' || !origin) {
      return;
    }

    // Always refresh the sessionStorage when editor loads to ensure correct origin
    if (typeof window !== 'undefined') {
      const editorData = {
        origin: String(origin),
        itemId: itemId || null
      };
      sessionStorage.setItem('graffiticode:editor', JSON.stringify(editorData));
    }

    // If editing an existing item, set up editor mode for the Gallery
    if (itemId) {
      // Store editor mode data in sessionStorage so Gallery knows to send messages
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('graffiticode:editor', JSON.stringify({
          origin: String(origin),
          itemId: itemId
        }));
        // Also set the selected item and language in localStorage
        localStorage.setItem('graffiticode:selected:itemId', String(itemId));
        localStorage.setItem('graffiticode:language', JSON.stringify({
          id: parseInt(lang),
          name: `L${String(lang).padStart(4, '0')}`
        }));
      }
      // Don't create a new item, just show the Gallery with the existing item
      return;
    }

    // If no ID and user is authenticated, create a new item (only once)
    if (user && !creationStarted.current) {
      creationStarted.current = true;
      handleCreateNewItem();
    }
  }, [lang, itemId, mode, origin, user]);

  const handleCreateNewItem = async () => {
    setIsCreating(true);
    setError(null);

    try {
      // Create a new item
      const createParams = {
        user,
        lang: String(lang).padStart(4, '0'),
        name: "unnamed",
        taskId: "",
        mark: 1,
        help: "[]",
        isPublic: false,
        client: 'console'
      };

      const newItem = await createItem(createParams);

      if (newItem && newItem.id) {
        setCreatedItemId(newItem.id);
        setIsCreating(false);

        // Send message back to opener window
        const targetWindow = openerWindowRef.current || window.opener;
        const message = {
          type: 'item-created',
          itemId: newItem.id,
          lang: lang
        };
        console.log('[Editor] item-created: targetWindow=', !!targetWindow, 'origin=', origin);
        if (targetWindow && origin) {
          try {
            targetWindow.postMessage(message, String(origin));
            console.log('[Editor] item-created postMessage sent to', String(origin));
          } catch (e) {
            console.error('[Editor] item-created postMessage failed:', e);
          }
        } else if (origin) {
          // Queue for when establish-communication arrives
          pendingItemCreatedRef.current = message;
          console.log('[Editor] Queued item-created for establish-communication');
        } else {
          console.warn('[Editor] Cannot send item-created: no targetWindow or origin');
        }

        // Store the selected item ID in localStorage so it will be selected in the items view
        if (typeof window !== 'undefined') {
          localStorage.setItem('graffiticode:selected:itemId', newItem.id);

          // Also set the language
          const langData = {
            id: parseInt(lang),
            name: `L${String(lang).padStart(4, '0')}`
          };
          localStorage.setItem('graffiticode:language', JSON.stringify(langData));

          // Store editor mode data in sessionStorage
          const editorData = {
            origin: String(origin),
            itemId: newItem.id
          };
          sessionStorage.setItem('graffiticode:editor', JSON.stringify(editorData));
        }
      } else {
        throw new Error('Failed to create item - no ID returned');
      }
    } catch (error) {
      console.error("Failed to create item:", error);
      setError(error.message || 'Failed to create item');
      setIsCreating(false);
      creationStarted.current = false; // Allow retry on error
    }
  };

  // Show loading state while router/auth is loading, token sign-in is in progress, or while we have a token and no user yet
  if (!router.isReady || authLoading || isTokenSigningIn || (token && !user)) {
    return (
      <>
        <Head>
          <title>{getPageTitle('Signing In')}</title>
        </Head>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto"></div>
            <p className="mt-4 text-gray-600">Signing in...</p>
          </div>
        </div>
      </>
    );
  }

  // Show sign in if user is not authenticated
  if (!user) {
    return (
      <>
        <Head>
          <title>{getPageTitle('Editor')}</title>
        </Head>
        <div className="min-h-screen flex items-center justify-center">
          <div className="max-w-md w-full">
            <h2 className="text-center text-2xl font-bold mb-4">Sign in to continue</h2>
            <p className="text-center text-gray-600 mb-8">
              Graffiticode account required to create or edit questions.
              <br />
              New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
            </p>
            <div className="flex justify-center">
              <button
                onClick={() => window.open('https://graffiticode.com', '_blank')}
                className="px-6 py-3 bg-gray-600 text-white rounded-none hover:bg-gray-700 transition-colors font-medium"
              >
                Open Graffiticode to Sign In
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Show Gallery UI when we have a created item or are in editor mode
  if (createdItemId || (mode === 'editor' && itemId)) {
    return (
      <>
        <Head>
          <title>{getPageTitle('Editor')}</title>
        </Head>
        <Gallery
          lang={lang}
          mark={mark}
          hideItemsNav={true}
          itemId={itemId || createdItemId}
        />
      </>
    );
  }

  // Show loading state while creating item or redirecting
  if (isCreating) {
    return (
      <>
        <Head>
          <title>{getPageTitle('Creating Item')}</title>
        </Head>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto"></div>
            <p className="mt-4 text-gray-600">Creating new item...</p>
          </div>
        </div>
      </>
    );
  }

  // Show error state
  if (error) {
    return (
      <>
        <Head>
          <title>{getPageTitle('Error')}</title>
        </Head>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
            <p className="text-gray-600 mb-4">{error}</p>
            <button
              onClick={handleCreateNewItem}
              className="px-4 py-2 bg-gray-600 text-white rounded-none hover:bg-gray-700"
            >
              Try Again
            </button>
          </div>
        </div>
      </>
    );
  }

  // Default loading state
  return (
    <>
      <Head>
        <title>{getPageTitle('Loading')}</title>
        <link rel="icon" type="image/png" href="favicon.png" />
      </Head>
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    </>
  );
}

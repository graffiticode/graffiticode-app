import { useState, useEffect } from 'react';
import useGraffiticodeAuth from '@graffiticode/auth-react';

// The per-user selection keys — cleared together whenever the account changes
// or signs out, so a new session never inherits a foreign item/task id (which
// the new account can't read).
function clearSelection() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('graffiticode:selected:itemId');
  localStorage.removeItem('graffiticode:selected:itemId:lang');
  localStorage.removeItem('graffiticode:selected:taskId');
  localStorage.removeItem('graffiticode:selected:taskId:lang');
}

export default function AuthWrapper({ children }) {
  const { user, loading } = useGraffiticodeAuth();
  const [isReady, setIsReady] = useState(false);
  const [checkingUser, setCheckingUser] = useState(false);

  useEffect(() => {
    if (user && !loading && !checkingUser) {
      // Drop the per-user selection when the account CHANGES, not just on
      // sign-out: switching wallets / creating a fresh account can go straight
      // from one uid to another without ever hitting the `!user` branch, which
      // would otherwise leave the previous account's selected item/task in
      // localStorage. index.tsx then redirects the new (often empty) account to
      // /tasks/<foreign-id>, and the load fails ("Failed to get task: Not
      // Found") because that task belongs to a different uid.
      if (typeof window !== 'undefined') {
        const prevUid = localStorage.getItem('graffiticode:auth:lastUid');
        if (prevUid && prevUid !== user.uid) {
          clearSelection();
        }
        localStorage.setItem('graffiticode:auth:lastUid', user.uid);
      }
      ensureUserExists();
    } else if (!user && !loading) {
      // Signed out (SSO bootstrap already resolved by now): drop the per-user
      // selection so a different user signing in on this browser doesn't inherit
      // the previous user's selected item/task.
      if (typeof window !== 'undefined') {
        clearSelection();
        localStorage.removeItem('graffiticode:auth:lastUid');
      }
      setIsReady(true);
    }
  }, [user?.uid, loading]);

  const ensureUserExists = async () => {
    setCheckingUser(true);
    try {
      const token = await user.getToken();
      const response = await fetch('/api/user/' + user.uid, {
        headers: {
          'Authorization': token,
        },
      });

      if (response.ok) {
        // User exists
        setIsReady(true);
      } else if (response.status === 404) {
        // User doesn't exist yet, create them
        const createResponse = await fetch('/api/user/' + user.uid, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': token,
          },
          body: JSON.stringify({
            uid: user.uid,
            created: new Date().toISOString(),
            // Attribution only — not persisted. A signup on /claim is the same
            // happening the `claim` event already reports, so the digest counts
            // it separately from an unprompted signup.
            via: window.location.pathname.startsWith('/claim') ? 'claim' : 'direct',
          }),
        });

        if (createResponse.ok) {
          setIsReady(true);
        } else {
          console.error('Failed to create user');
        }
      }
    } catch (error) {
      console.error('Error checking/creating user:', error);
    } finally {
      setCheckingUser(false);
    }
  };

  if (loading || checkingUser) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-100px)]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-100px)]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return children;
}

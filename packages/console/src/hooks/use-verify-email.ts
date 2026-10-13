import { useCallback, useRef, useState } from 'react';
import {
  useLoginWithEmail,
  usePrivy,
  type User as PrivyUser,
} from '@privy-io/react-auth';

// Verify-only Privy OTP flow used for adding an email to an existing
// Graffiticode account at /settings. Independent of useEmailSignIn so the two
// hooks don't share state when a signed-in user adds another email.

const LOGIN_TIMEOUT_MS = 30_000;

type LoginWaiter = {
  resolve: (user: PrivyUser) => void;
  reject: (err: Error) => void;
};

export function useVerifyEmail() {
  const { logout, getAccessToken } = usePrivy();

  const loginWaiterRef = useRef<LoginWaiter | null>(null);
  const { sendCode: privySendCode, loginWithCode: privyLoginWithCode } = useLoginWithEmail({
    onComplete: (privyUser) => {
      loginWaiterRef.current?.resolve(privyUser);
      loginWaiterRef.current = null;
    },
    onError: (err) => {
      const msg = typeof err === 'string' ? err : 'Privy verification failed';
      loginWaiterRef.current?.reject(new Error(msg));
      loginWaiterRef.current = null;
    },
  });

  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const sendCode = useCallback(async (email: string) => {
    setSending(true);
    setEmailError(null);
    try {
      // Always start from a clean Privy state so we don't try to link the
      // new email to a leftover Privy user from a previous flow.
      try {
        await logout();
      } catch {
        // ignore
      }
      await privySendCode({ email });
      setPendingEmail(email);
    } catch (err: any) {
      const msg = err?.message || 'Failed to send code';
      setEmailError(msg);
      throw err;
    } finally {
      setSending(false);
    }
  }, [privySendCode, logout]);

  const armWaiter = useCallback((): Promise<PrivyUser> => {
    return new Promise((resolve, reject) => {
      loginWaiterRef.current = { resolve, reject };
      setTimeout(() => {
        if (loginWaiterRef.current) {
          loginWaiterRef.current = null;
          reject(new Error('Timed out waiting for Privy to verify code.'));
        }
      }, LOGIN_TIMEOUT_MS);
    });
  }, []);

  // Returns the Privy access token after the OTP verifies. Caller passes
  // this to the server, which re-verifies the token and extracts the email.
  // We use the access token rather than the identity token because the
  // identity token doesn't reliably populate after loginWithCode for newly
  // added emails (see commit c0fcb2d for the parallel fix in use-email-signin).
  const verifyCode = useCallback(async (code: string): Promise<string> => {
    setVerifying(true);
    setCodeError(null);
    try {
      const complete = armWaiter();
      await privyLoginWithCode({ code });
      await complete;
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Privy access token unavailable.');
      }
      return token;
    } catch (err: any) {
      const msg = err?.message || 'Failed to verify code';
      setCodeError(msg);
      throw err;
    } finally {
      setVerifying(false);
    }
  }, [armWaiter, privyLoginWithCode, getAccessToken]);

  const cleanup = useCallback(async () => {
    try {
      await logout();
    } catch {
      // ignore
    }
  }, [logout]);

  const reset = useCallback(() => {
    setPendingEmail(null);
    setEmailError(null);
    setCodeError(null);
    setSending(false);
    setVerifying(false);
  }, []);

  return {
    sendCode,
    verifyCode,
    cleanup,
    reset,
    pendingEmail,
    sending,
    verifying,
    emailError,
    codeError,
  };
}

export default useVerifyEmail;

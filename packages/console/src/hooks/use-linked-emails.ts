import { useCallback } from 'react';
import useGraffiticodeAuth from '@graffiticode/auth-react';

const authUrl = process.env.NEXT_PUBLIC_GC_AUTH_URL || 'https://auth.graffiticode.org';

export interface LinkedEmail {
  id: string;
  email: string;
  createdAt?: any;
  verifiedAt?: any;
}

export interface AddEmailResult {
  success: boolean;
  email?: string;
  error?: string;
  conflict?: 'self' | 'other';
}

export type EmailCheck =
  | { available: true }
  | { available: false; ownedBy: 'self' | 'other' };

export function useLinkedEmails() {
  const { user } = useGraffiticodeAuth();

  const listEmails = useCallback(async (): Promise<LinkedEmail[]> => {
    if (!user) throw new Error('Must be logged in');
    const token = await user.getToken();
    const res = await fetch(`${authUrl}/linked-emails`, {
      headers: { Authorization: token },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'Failed to list linked emails');
    }
    const body = await res.json();
    return body.data?.emails || [];
  }, [user]);

  // Pre-OTP availability check. Returns { available: true } if the email is
  // unused, or { available: false, ownedBy } so the caller can show the right
  // message without burning a Privy OTP first.
  const checkEmail = useCallback(async (email: string): Promise<EmailCheck> => {
    if (!user) throw new Error('Must be logged in');
    const token = await user.getToken();
    const res = await fetch('/api/linked-emails/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'Failed to check email');
    }
    const body = await res.json();
    return body.data as EmailCheck;
  }, [user]);

  // Add an email after the caller has verified ownership via a Privy OTP. The
  // browser hands the resulting Privy access token to the console, which
  // verifies it server-side, extracts the email, and writes a linked_emails
  // row for the current uid.
  const addEmail = useCallback(async (privyAccessToken: string): Promise<AddEmailResult> => {
    if (!user) throw new Error('Must be logged in');
    const token = await user.getToken();
    const res = await fetch('/api/linked-emails/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify({ privyAccessToken }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Race: pre-check passed but another writer linked the email before we
      // got here. We don't know which account; treat as generic conflict.
      return {
        success: false,
        error: body?.error?.message || 'Email already linked to another account',
        conflict: 'other',
      };
    }
    if (!res.ok) {
      return { success: false, error: body?.error?.message || 'Failed to add email' };
    }
    return { success: true, email: body.data?.email };
  }, [user]);

  const removeEmail = useCallback(async (id: string): Promise<void> => {
    if (!user) throw new Error('Must be logged in');
    const token = await user.getToken();
    const res = await fetch(`${authUrl}/linked-emails/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: token },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'Failed to remove email');
    }
  }, [user]);

  return { listEmails, checkEmail, addEmail, removeEmail };
}

export default useLinkedEmails;

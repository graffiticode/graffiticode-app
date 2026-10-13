"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useGraffiticodeAuth } from "@graffiticode/auth-react";
import { SignIn } from "@/components/SignIn";

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </main>
  );
}

function Spinner() {
  return <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />;
}

// Only allow same-origin relative paths as redirect targets — reject absolute
// and protocol-relative URLs so ?redirect= can't be used as an open redirect.
function sanitizeRedirect(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("://")) return null;
  return value;
}

function SignInInner() {
  const { user, loading } = useGraffiticodeAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const redirect = sanitizeRedirect(sp.get("redirect"));

  // Drives both "already signed in → go to target" and "just signed in → go to
  // target" (user flips after the SignIn dialog succeeds).
  useEffect(() => {
    if (!loading && user && redirect) {
      router.replace(redirect);
    }
  }, [loading, user, redirect, router]);

  if (loading || (user && redirect)) {
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  }

  if (user) {
    return (
      <FullScreen>
        <h1 className="text-xl font-semibold">Signed in</h1>
        <p className="text-gray-600">Signed in as {user.email ?? user.uid}</p>
        <div className="flex gap-3">
          <Link href="/" className="rounded bg-gray-900 px-4 py-2 text-white">
            Continue
          </Link>
          <Link
            href="/sign-out"
            className="rounded border border-gray-300 px-4 py-2 text-gray-700"
          >
            Sign out
          </Link>
        </div>
      </FullScreen>
    );
  }

  return (
    <FullScreen>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <SignIn label="Sign in" className="rounded bg-gray-900 px-4 py-2 text-white" />
    </FullScreen>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <FullScreen>
          <Spinner />
        </FullScreen>
      }
    >
      <SignInInner />
    </Suspense>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSignOut } from "@graffiticode/auth-react";

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </main>
  );
}

export default function SignOutPage() {
  const signOutFully = useSignOut();
  const [done, setDone] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    // Guard against React strict-mode double-invoke.
    if (ranRef.current) return;
    ranRef.current = true;
    signOutFully().finally(() => setDone(true));
  }, [signOutFully]);

  if (!done) {
    return (
      <FullScreen>
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />
        <p className="text-gray-600">Signing out…</p>
      </FullScreen>
    );
  }

  return (
    <FullScreen>
      <h1 className="text-xl font-semibold">You have been signed out</h1>
      <Link href="/sign-in" className="rounded bg-gray-900 px-4 py-2 text-white">
        Sign in
      </Link>
    </FullScreen>
  );
}

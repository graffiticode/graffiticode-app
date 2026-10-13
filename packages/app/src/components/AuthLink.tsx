"use client";

import Link from "next/link";
import { useGraffiticodeAuth } from "@graffiticode/auth-react";

export function AuthLink({ className }: { className?: string }) {
  const { user, loading } = useGraffiticodeAuth();
  if (loading) return null;
  return user ? (
    <Link href="/sign-out" className={className}>
      Sign out
    </Link>
  ) : (
    <Link href="/sign-in" className={className}>
      Sign in
    </Link>
  );
}

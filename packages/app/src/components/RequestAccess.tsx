"use client";

import { useGraffiticodeAuth } from "@graffiticode/auth-react";
import { SignIn } from "./SignIn";

type Owner = { uid?: string; email?: string } | null;

export function RequestAccess({ owner, signedIn }: { owner: Owner; signedIn: boolean }) {
  const { signOut } = useGraffiticodeAuth();
  const subject = encodeURIComponent("Access request for a Graffiticode form");
  const body = encodeURIComponent(
    `Hi,\n\nCould you grant me access to this form?\n\n${typeof window !== "undefined" ? window.location.href : ""}`,
  );

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">This form is private</h1>
      <p className="max-w-md text-gray-600">
        You don&apos;t have access to this form. The owner can make it public or share it with your
        account.
      </p>
      {owner?.email ? (
        <a
          href={`mailto:${owner.email}?subject=${subject}&body=${body}`}
          className="text-blue-600 underline"
        >
          Request access from the owner
        </a>
      ) : (
        <p className="max-w-md text-sm text-gray-500">
          Ask the owner to make this form public, or to add your account id to its access list.
        </p>
      )}
      {signedIn ? (
        // The viewer is signed in but this account lacks access — most often
        // they're signed in with the wrong account. Signing out drops the token
        // and re-resolves, landing on the sign-in prompt so they can come back
        // as an account that has access.
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">
            Signed in with the wrong account? Switch to one that has access.
          </p>
          <button
            type="button"
            onClick={() => signOut()}
            className="rounded bg-gray-900 px-4 py-2 text-white"
          >
            Switch account
          </button>
        </div>
      ) : (
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">Already shared with you? Sign in to view it.</p>
          <SignIn label="Sign in" className="rounded bg-gray-900 px-4 py-2 text-white" />
        </div>
      )}
    </main>
  );
}

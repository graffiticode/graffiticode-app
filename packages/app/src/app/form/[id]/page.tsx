"use client";

import { useRef } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { useGraffiticodeAuth } from "@graffiticode/auth-react";
import { FormHarness } from "@/components/FormHarness";
import { RequestAccess } from "@/components/RequestAccess";
import { SignIn } from "@/components/SignIn";

type Owner = { uid?: string; email?: string } | null;

type Resolved = {
  allowed: boolean;
  taskId?: string;
  itemId?: string | null;
  reason?: "locked" | "not-found";
  owner?: Owner;
  accessToken: string | null;
};

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </main>
  );
}

export default function FormByIdPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id as string);
  const { user, loading } = useGraffiticodeAuth();

  // Marks the FIRST resolve of this page view. The route counts an artifact_view
  // only when it's set, so the 8s poll below — plus focus/reconnect
  // revalidations and the refetch when auth resolves and changes the SWR key —
  // don't each register as a view. A ref rather than state: flipping it must not
  // re-render, and it resets on remount, which genuinely IS a new view.
  const firstResolve = useRef(true);

  // Poll the resolve so an item whose task changed elsewhere (e.g. the MCP
  // server republished it) re-resolves and reloads the form. Only item-backed
  // forms poll — a raw task id is immutable, so refreshInterval is 0 for it.
  const { data: resolved, error } = useSWR<Resolved>(
    loading || !id ? null : ["form-resolve", id, !!user],
    async (): Promise<Resolved> => {
      const token = user ? await user.getToken() : null;
      const isView = firstResolve.current;
      firstResolve.current = false;
      const res = await fetch(
        `/api/form/resolve?id=${encodeURIComponent(id)}${isView ? "&view=1" : ""}`,
        { headers: token ? { Authorization: token } : {} },
      );
      const body = await res.json();
      return { ...body, accessToken: token };
    },
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      refreshInterval: (d) => (d?.allowed && d?.itemId ? 8000 : 0),
    },
  );

  if (loading || (!resolved && !error)) {
    return (
      <FullScreen>
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />
      </FullScreen>
    );
  }

  if (error) {
    return (
      <FullScreen>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-gray-600">Could not load this form. Please try again.</p>
      </FullScreen>
    );
  }

  if (resolved && resolved.allowed) {
    return (
      <FormHarness
        taskId={resolved.taskId as string}
        itemId={resolved.itemId ?? null}
        accessToken={resolved.accessToken}
      />
    );
  }

  if (resolved && !resolved.allowed) {
    // A private item or task can't be resolved without credentials — if the
    // viewer isn't signed in, prompt sign-in (which re-resolves on success)
    // rather than declaring it missing or locked.
    if (!user) {
      return (
        <FullScreen>
          <h1 className="text-xl font-semibold">Sign in to view this form</h1>
          <p className="max-w-md text-gray-600">
            This form isn&apos;t public. Sign in to open it.
          </p>
          <SignIn label="Sign in" className="rounded bg-gray-900 px-4 py-2 text-white" />
        </FullScreen>
      );
    }
    if (resolved.reason === "not-found") {
      return (
        <FullScreen>
          <h1 className="text-xl font-semibold">Not found</h1>
          <p className="text-gray-600">No form exists for this id.</p>
        </FullScreen>
      );
    }
    return <RequestAccess owner={resolved.owner ?? null} signedIn={true} />;
  }

  return (
    <FullScreen>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-gray-600">Could not load this form. Please try again.</p>
    </FullScreen>
  );
}

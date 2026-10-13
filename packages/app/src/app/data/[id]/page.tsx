"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useGraffiticodeAuth } from "@graffiticode/auth-react";

type State =
  | { status: "loading" }
  | { status: "ok"; body: any }
  | { status: "error"; msg: string };

// Debug view: renders the compiled data model (input to /form/{id}) as JSON.
// Calls /api/data/{id} with the signed-in token so private items resolve too.
export default function DataByIdPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id as string);
  const { user, loading } = useGraffiticodeAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (loading || !id) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const token = user ? await user.getToken() : null;
      const res = await fetch(`/api/data/${encodeURIComponent(id)}`, {
        headers: token ? { Authorization: token } : {},
      });
      const body = await res.json();
      if (cancelled) return;
      setState(res.ok ? { status: "ok", body } : { status: "error", msg: JSON.stringify(body, null, 2) });
    })().catch((err) => {
      if (!cancelled) setState({ status: "error", msg: String(err) });
    });
    return () => {
      cancelled = true;
    };
  }, [id, user, loading]);

  if (loading || state.status === "loading") {
    return <pre className="p-4 text-sm text-gray-500">Loading…</pre>;
  }
  if (state.status === "error") {
    return <pre className="whitespace-pre-wrap break-all p-4 text-xs text-red-600">{state.msg}</pre>;
  }
  return (
    <pre className="whitespace-pre-wrap break-all p-4 text-xs">
      {JSON.stringify(state.body, null, 2)}
    </pre>
  );
}

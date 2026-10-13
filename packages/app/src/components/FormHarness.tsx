"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org";

function buildSrc(taskId: string, lang: string | null, accessToken: string | null, origin: string) {
  const params = new URLSearchParams();
  if (lang) params.set("lang", lang);
  params.set("id", taskId);
  if (accessToken) params.set("access_token", accessToken);
  if (origin) params.set("origin", origin);
  return `${apiBase}/form?${params.toString()}`;
}

export function FormHarness({
  taskId,
  itemId = null,
  lang = null,
  accessToken,
}: {
  taskId: string;
  // Set when the viewer navigated by an item id (vs a raw task id). Item-backed
  // forms must keep the item id in the location bar so a reload re-resolves to
  // the item's current task; we therefore don't mint data tasks or rewrite the
  // URL for them. Raw task ids keep capturing runtime state into the URL.
  itemId?: string | null;
  lang?: string | null;
  accessToken: string | null;
}) {
  const [src, setSrc] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // The currently-chained task id. For raw task ids, runtime state changes mint
  // a new data task and advance this ref + the URL bar, without reloading the
  // iframe (which would discard the live form state).
  const currentTaskIdRef = useRef(taskId);
  const creatingRef = useRef(false);
  const lastStateHashRef = useRef<string | null>(null);
  // The task id the current iframe src reflects (starts empty so the first
  // taskId always loads).
  const appliedTaskIdRef = useRef<string>("");

  useEffect(() => {
    currentTaskIdRef.current = taskId;
  }, [taskId]);

  const applyTaskId = useCallback(
    (tid: string) => {
      if (typeof window === "undefined") return;
      setSrc(buildSrc(tid, lang, accessToken, window.location.origin));
      setIsLoading(true);
      appliedTaskIdRef.current = tid;
    },
    [lang, accessToken],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Only (re)load on a genuine task change. A token refresh that leaves the
    // taskId unchanged must not reload the iframe (raw forms keep their chained
    // runtime state in currentTaskIdRef / the URL, not the taskId prop). When
    // the resolved task does change (e.g. the item was edited elsewhere), reload
    // automatically.
    if (taskId === appliedTaskIdRef.current) return;
    lastStateHashRef.current = null;
    applyTaskId(taskId);
  }, [taskId, lang, accessToken, applyTaskId]);

  const createDataTask = useCallback(
    async (data: any) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      try {
        const res = await fetch("/api/data-task", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: accessToken } : {}),
          },
          body: JSON.stringify({ id: currentTaskIdRef.current, data }),
        });
        if (!res.ok) return;
        const body = await res.json();
        if (body.id && body.id !== currentTaskIdRef.current) {
          currentTaskIdRef.current = body.id;
          window.history.replaceState(null, "", `/form/${body.id}`);
        }
      } catch (err) {
        console.error("[FormHarness] createDataTask failed", err);
      } finally {
        creatingRef.current = false;
      }
    },
    [accessToken],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Ignore same-origin messages — form messages come from the api iframe.
      if (event.origin === window.location.origin) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "data-updated") {
        setIsLoading(false);
        // Raw task ids capture runtime state into a new data task / the URL.
        // Item-backed forms keep their item id in the path untouched.
        if (!itemId && msg.data) {
          const hash = JSON.stringify(msg.data);
          if (hash !== lastStateHashRef.current) {
            lastStateHashRef.current = hash;
            createDataTask(msg.data);
          }
        }
        return;
      }
      if (msg.type === "onload") {
        setIsLoading(false);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [createDataTask, itemId]);

  return (
    <div className="relative h-full w-full overflow-hidden p-2">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />
        </div>
      )}
      {src && (
        <iframe
          src={src}
          title="form"
          className="h-full w-full"
          style={{ border: "none" }}
          // Lets the embedded view's "Copy" button reach the async Clipboard API from this
          // cross-origin iframe (so teachers can copy the question / answer key as rich text).
          allow="clipboard-write"
          // The form view may signal readiness via a postMessage type we don't
          // recognize, so clear the overlay once the document itself loads.
          onLoad={() => setIsLoading(false)}
        />
      )}
    </div>
  );
}

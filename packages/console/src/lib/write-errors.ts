// Plain-language reasons for a failed or skipped write through a connection
// (an item's lastWrite). The recorded message is whatever the compile, policy
// or broker said; policy refusals carry their reason code in it, e.g.
// "permission denied (system-connection)". Shared by the browser and the
// server, so it imports nothing.

export type WriteProblem = {
  // "Not saved to …", to lead the reason with.
  headline: string;
  // Why, in plain language.
  text: string;
  // Whether Retry (the same write through the same connection) can help.
  retryable: boolean;
};

// Retry writes through the CURRENT connection: it helps when there is one and
// either the problem is retryable or the current connection has changed since.
export const canRetryWrite = (
  problem: WriteProblem | null,
  write: { connectionId?: string | null } | null | undefined,
  currentConnectionId: string | null | undefined,
) => Boolean(problem && currentConnectionId && (problem.retryable || currentConnectionId !== (write?.connectionId ?? null)));

type LastWriteLike = { status?: string | null; message?: string | null } | null | undefined;

const has = (message: string, ...codes: string[]) =>
  codes.some(code => new RegExp(`(^|[^A-Za-z-])${code}([^A-Za-z-]|$)`).test(message));

export function describeWriteProblem(write: LastWriteLike): WriteProblem | null {
  if (!write || (write.status !== "failed" && write.status !== "skipped")) return null;
  const message = write.message || "";
  if (write.status === "skipped" || message === "no-connection") {
    return { headline: "Not saved to the item bank", text: "no Learnosity connection. Add one in Settings.", retryable: false };
  }
  const failed = (text: string, retryable: boolean): WriteProblem =>
    ({ headline: "Not saved to the Learnosity item bank", text, retryable });
  if (has(message, "system-connection")) {
    return failed("This is Graffiticode's preview account; it can't write to an item bank. Add your own Learnosity connection in Settings.", false);
  }
  if (has(message, "not-granted", "fn-not-in-session")) {
    // The owner's own settings for the connection refuse it the same way a
    // narrower share does.
    return failed("This connection's access doesn't include saving to the item bank for this language. If it's your connection, change your access under Settings → Connections; if it was shared with you, ask its owner.", false);
  }
  if (has(message, "connection-disabled")) {
    return failed("This connection is disabled.", false);
  }
  if (has(message, "connection-not-found", "not-owner")) {
    return failed("This connection is no longer available to you.", false);
  }
  // Chain admission and contract v2 (capability W4). Each refusal names its
  // reason code in the recorded message (resolvers.ts errorMessages).
  if (has(message, "invocation-incompatible")) {
    // The save's idempotency key belongs to a run from before the W4 cutover,
    // which can't be resumed: Retry reuses that key and fails the same way.
    return failed("This save started before a security update and can't be resumed. Recompile the item to save it again (the write may repeat).", false);
  }
  if (has(message, "pinned-revision-unavailable")) {
    return failed("The language version this save started on has been retired. Recompile the item to save it again (the write may repeat).", false);
  }
  if (has(message, "plan-mismatch", "idempotency-key-reused")) {
    return failed("This save's inputs changed after it started. Recompile the item to save it again.", false);
  }
  if (has(message, "stage-not-pinnable")) {
    return failed("This item's pipeline includes a language that can't write through a connection.", false);
  }
  if (has(message, "language-override-refused")) {
    return failed("You have a language-server override set for this language, and saves through a connection can't use one. Remove the override, then retry.", true);
  }
  if (has(message, "fn-not-enabled")) {
    return failed("This item uses a Learnosity feature (Author) that isn't available.", false);
  }
  if (has(message, "revision-not-approved")) {
    return failed("This language's server version isn't approved for saving through a connection. Try again later; if it persists, contact support.", true);
  }
  if (has(message, "preflight-unavailable", "token-expiring", "policy-unavailable")) {
    return failed("A service didn't respond in time. Try again in a moment.", true);
  }
  if (has(message, "uncertain")) {
    // Retrying reuses the save's idempotency key, which only returns the same
    // uncertain outcome; Recompile writes again under a new one.
    return failed("The save is uncertain — it may or may not have been written. Check the item bank; to save again anyway, recompile the item (the write may repeat).", false);
  }
  return failed(message || "unknown error", true);
}

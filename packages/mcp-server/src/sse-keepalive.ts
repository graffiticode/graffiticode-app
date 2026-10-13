/**
 * Keepalive for long-lived SSE responses.
 *
 * Cloudflare (and most proxies) kill an idle streaming response at 100s. A client's
 * standalone `GET /mcp` notification stream is idle by nature — nothing is sent on it
 * until the server has a notification to push — so it was being cut every ~100s and
 * surfacing to the client as:
 *
 *     StreamableHTTPError: Failed to open SSE stream ... code: 524
 *
 * which churns the connector. The fix is to write an SSE **comment** on an interval:
 * bytes on the wire, which is all an idle timer cares about, but ignored by every SSE
 * client, carrying no event id, and therefore invisible to the MCP layer and to stream
 * resumability. The transport enqueues each event as one complete string, so a comment
 * can only land between events, never inside one.
 *
 * Kept in its own module (no imports, no I/O beyond the response) so the guard logic is
 * unit-testable without standing up an HTTP server.
 */

/** The subset of ServerResponse this needs — keeps the seam testable. */
export interface KeepaliveTarget {
  writableEnded: boolean;
  destroyed: boolean;
  headersSent: boolean;
  getHeader(name: string): unknown;
  write(chunk: string): unknown;
  once(event: string, listener: () => void): unknown;
}

/** SSE comment line. Two newlines terminate it, as with any SSE frame. */
export const KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * Decide what to do with a response on a keepalive tick. Pure, so the interesting
 * cases (headers not sent yet, response is JSON not SSE, response already gone) are
 * testable directly.
 *
 * - `"wait"` — the transport hasn't opened the stream yet; check again next tick.
 * - `"write"` — it is an open event stream; write the comment.
 * - `"stop"` — it is finished, or was never an event stream; cancel the interval.
 */
export function keepaliveAction(res: KeepaliveTarget): "wait" | "write" | "stop" {
  if (res.writableEnded || res.destroyed) return "stop";
  // writeHead hasn't run — this may still become a stream.
  if (!res.headersSent) return "wait";
  const contentType = String(res.getHeader("content-type") ?? res.getHeader("Content-Type") ?? "");
  if (!contentType.includes("text/event-stream")) return "stop";
  return "write";
}

/**
 * Start writing keepalive comments to `res` every `intervalMs` for as long as it is an
 * open event stream. Safe to call before the response exists (it waits), on a response
 * that never becomes a stream (it stops), and on one that closes (it stops).
 *
 * `intervalMs <= 0` disables the keepalive entirely. Returns a stop function, mostly
 * for tests — the response's own close/finish events stop it in normal operation.
 */
export function startSseKeepalive(
  res: KeepaliveTarget,
  intervalMs: number,
  schedule: (fn: () => void, ms: number) => { unref?: () => void } = setInterval as never,
  cancel: (handle: unknown) => void = clearInterval as never
): () => void {
  if (!(intervalMs > 0)) return () => {};

  const handle = schedule(() => {
    switch (keepaliveAction(res)) {
      case "wait":
        return;
      case "stop":
        stop();
        return;
      case "write":
        try {
          res.write(KEEPALIVE_FRAME);
        } catch {
          // Client vanished between the check and the write.
          stop();
        }
    }
  }, intervalMs);

  // A keepalive must never hold the process open.
  handle.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
  };

  res.once("close", stop);
  res.once("finish", stop);
  return stop;
}

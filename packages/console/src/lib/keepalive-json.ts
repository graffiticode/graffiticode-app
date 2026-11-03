/**
 * Answer a slow request with JSON, keeping the connection alive while the work runs.
 *
 * console.graffiticode.org sits behind Cloudflare, which gives an origin 100 seconds to START
 * its response (a 524 otherwise) — while a long code generation runs 3-7 minutes (the request
 * deadline is 420 s, generate-for-request.ts; Cloud Run allows 900). So the headers go out at
 * once and a space follows every `intervalMs` until the result is written: JSON permits leading
 * whitespace, so the client reads the body as it always did, with `JSON.parse(text)`.
 *
 * The status is committed before the work finishes, so a failure arrives as `{ errors: [...] }`
 * in a 200 body — the same shape a generation's own errors take — never as an HTTP status.
 */
export interface KeepaliveResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  flushHeaders?(): void;
  /** Present when a compression layer wraps the response. */
  flush?(): void;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export async function respondWithKeepalive(
  res: KeepaliveResponse,
  work: () => Promise<unknown>,
  intervalMs = 15_000,
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // no-transform: a compression layer (Node's, or Cloudflare's) would otherwise buffer the
  // keep-alive bytes, and with them the response itself.
  res.setHeader("Cache-Control", "no-store, no-transform");
  // Proxies that buffer would hold the keep-alive bytes back and defeat the point.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const keepalive = () => {
    res.write(" ");
    res.flush?.();
  };
  keepalive();
  const timer = setInterval(keepalive, intervalMs);
  let body: unknown;
  try {
    body = await work();
  } catch (error: any) {
    body = { errors: [{ message: error?.message || "Code generation failed", code: error?.code }] };
  } finally {
    clearInterval(timer);
  }
  res.end(JSON.stringify(body ?? {}));
}

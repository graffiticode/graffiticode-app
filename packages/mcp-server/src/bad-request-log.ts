import type { IncomingMessage, ServerResponse } from "http";

/**
 * Log why `/mcp` answered 400.
 *
 * Our code never writes a 400 there; the MCP SDK's transport does, for a request it cannot
 * take (no session id on a non-initialize call, a bad protocol-version header, unparseable
 * JSON). Those arrived at a steady few an hour across every revision with nothing saying
 * which, because the request log records only the status. This records the SDK's own error
 * message alongside the shape of the request.
 *
 * Privacy (CLAUDE.md contract): never the request body, never the session id (only whether
 * one was sent), never the IP. The message is server-generated text, capped.
 */
export function watchBadRequests(
  req: IncomingMessage,
  res: ServerResponse,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  let status = 0;
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code;
    return writeHead(code, ...rest);
  }) as typeof res.writeHead;

  // The body may arrive through write() before a bare end() (the SDK streams its response),
  // so collect it from both, capped: an error body is small, and nothing else is kept.
  const is400 = () => (status || res.statusCode) === 400;
  let body = "";
  const keep = (chunk: unknown) => {
    if (!is400() || body.length >= 2000 || chunk == null || typeof chunk === "function") return;
    body += (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk)).slice(0, 2000 - body.length);
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return write(chunk, ...rest);
  }) as typeof res.write;

  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    keep(chunk);
    if (is400()) {
      const header = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      log(
        JSON.stringify({
          ev: "mcp_bad_request",
          method: req.method,
          hasSession: !!header("mcp-session-id"),
          protocolVersion: header("mcp-protocol-version") ?? null,
          accept: (header("accept") ?? "").slice(0, 60),
          client: (header("user-agent") ?? "").split(/[\s/]/)[0].slice(0, 40),
          message: errorMessage(body),
        }),
      );
    }
    return end(chunk, ...rest);
  }) as typeof res.end;
}

function errorMessage(text: string): string | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    const msg = body?.error?.message ?? body?.error ?? null;
    return msg === null ? null : String(msg).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

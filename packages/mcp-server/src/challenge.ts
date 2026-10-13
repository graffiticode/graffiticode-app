/**
 * OpenAI app-directory domain-verification challenge.
 *
 * OpenAI issues a token at submission time and fetches it from the root of the
 * registered MCP host. The response body must be the exact token and nothing
 * else — no JSON wrapper, prefix, or extra tokens. `Cache-Control: no-store`
 * keeps Cloudflare (or any proxy) from pinning a stale token across a re-issue.
 *
 * Kept as a pure seam so the contract is testable without booting the HTTP
 * server (which starts listening on import).
 */
export interface ChallengeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function buildChallengeResponse(
  token: string | undefined,
): ChallengeResponse {
  if (!token) {
    return {
      status: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Not found" }),
    };
  }
  return {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: token,
  };
}

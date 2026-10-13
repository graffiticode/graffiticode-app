/**
 * Free-plan refusals from the console, made legible.
 *
 * The console rejects anonymous (free-plan) calls with a `FreePlanError` carrying
 * a machine-readable code (`free_plan_rate_limit_exceeded`, `…_item_limit_reached`,
 * …), a human message, and sometimes `retry_after_seconds` / `signup_url`. It
 * arrives on one of two paths: as a non-2xx JSON body from the request gate (the
 * API burst guard), or as a GraphQL `errors[]` entry whose `extensions` hold the
 * same payload (quota and generation-burst checks inside resolvers).
 *
 * Before this, both paths reached the model as
 * `Error: GraphQL request failed: {"error":"free_plan_…",…}` — a blob that names
 * no host and gives no instruction. On 2026-10-06 a ChatGPT session showed its
 * own "You've hit your limit" banner while every Graffiticode call had succeeded,
 * and the model confidently blamed "the Graffiticode anonymous/free-session
 * limit". A real Graffiticode limit has to be unmistakable in the transcript —
 * named as ours, with its own wording — so it can't be confused with the host's,
 * in either direction. And it must say not to retry: an agent that re-fires a
 * rate-limited call just extends the limit.
 *
 * Pure seam: no I/O, so it is unit-testable without a console.
 */

export class FreePlanLimitError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
    readonly signupUrl?: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "FreePlanLimitError";
  }

  /** A quota/rate refusal, as opposed to an input rejection (description too long, …). */
  get isLimit(): boolean {
    return /_(limit_reached|limit_exceeded)$/.test(this.code);
  }
}

const DEFAULT_SIGNUP_URL = "https://graffiticode.org/signup?utm_source=free_plan&utm_medium=mcp";

/**
 * Recognise a console free-plan payload. Accepts the HTTP body shape
 * (`{ error: code, message, … }`) and the GraphQL extensions shape
 * (`{ code, message, … }`). Returns null for anything else, including free-plan
 * codes that carry no message (e.g. `free_plan_session_invalid`) — those have
 * nothing better to say than the existing generic path.
 */
export function parseFreePlanError(payload: unknown, fallbackMessage?: string): FreePlanLimitError | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const code = typeof p.code === "string" ? p.code : typeof p.error === "string" ? p.error : null;
  if (!code || !code.startsWith("free_plan_")) return null;
  const message = typeof p.message === "string" && p.message.trim() ? p.message.trim() : fallbackMessage?.trim();
  if (!message) return null;
  const retry = Number(p.retry_after_seconds);
  return new FreePlanLimitError(
    code,
    message,
    Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined,
    typeof p.signup_url === "string" && /^https:\/\//.test(p.signup_url) ? p.signup_url : undefined,
  );
}

/** Parse a raw (non-2xx) response body; null when it isn't a free-plan payload. */
export function parseFreePlanErrorBody(body: string): FreePlanLimitError | null {
  try {
    return parseFreePlanError(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * The tool-result text for a free-plan refusal. Leads with Graffiticode's name so
 * no reader can mistake it for the host's own limit, quotes the console's message
 * verbatim (it already names the specific limit), gives the way out as a link,
 * and tells the model what to do — the one lever proven to steer it here.
 */
export function buildFreePlanLimitText(err: FreePlanLimitError): string {
  if (!err.isLimit) {
    return (
      `Graffiticode rejected this request: ${err.detail}\n\n` +
      `Adjust the request as the message says and try again.`
    );
  }
  const signup = err.signupUrl ?? DEFAULT_SIGNUP_URL;
  const lines = [
    `**Graffiticode free-plan limit reached** (${err.code}). ${err.detail}`,
    ``,
    `This is a limit of Graffiticode's anonymous free plan — not of this chat app or the user's account with it. ` +
      `[Create a free Graffiticode account](${signup}) to remove it.`,
    ``,
    err.retryAfterSeconds !== undefined
      ? `Do not retry automatically. Tell the user what happened; if they ask to try again, wait at least ${err.retryAfterSeconds} seconds first.`
      : `Do not retry. Tell the user what happened and show them the account link.`,
  ];
  return lines.join("\n");
}

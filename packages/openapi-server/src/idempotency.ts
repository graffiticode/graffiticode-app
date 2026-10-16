// Idempotency-Key on the POSTs that start a generation (create, revise,
// retry): a retry with the same key gets the original response, never a
// second item or job. The protocol is core's (core/idempotency.ts); this binds
// it to HTTP. Keys are scoped to the caller — the account, or the free-plan
// workspace.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import {
  claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey,
  type IdempotencyClaim, type IdempotencyOp, type StoredResponse,
} from "@graffiticode-app/core/idempotency";
import type { Caller } from "./auth.js";
import { ApiProblem } from "./problems.js";

const KEY = /^[\x21-\x7e]{1,255}$/;

type Run = (claim: IdempotencyClaim | null) => Promise<StoredResponse>;
type Rebuild = (op: IdempotencyOp) => Promise<StoredResponse>;

const send = (c: Context, r: StoredResponse, replayed = false) => {
  for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
  if (replayed) c.header("Idempotent-Replayed", "true");
  return c.json(r.body as any, r.status as any);
};

export async function idempotent(c: Context, caller: Caller, raw: string, run: Run, rebuild: Rebuild) {
  const key = c.req.header("idempotency-key");
  if (key === undefined) return send(c, await run(null));
  if (!KEY.test(key)) {
    throw new ApiProblem(400, "invalid_idempotency_key", "Invalid Idempotency-Key", { detail: "Use 1–255 visible ASCII characters." });
  }
  const auth = await caller.principal();
  const scope = auth.freePlan ? `ws:${auth.sessionNamespace}` : `uid:${auth.uid}`;
  const fingerprint = createHash("sha256").update(`${c.req.method} ${c.req.path}\n${raw}`).digest("hex");
  const claimed = await claimIdempotencyKey({ scope, key, fingerprint });
  switch (claimed.kind) {
    case "replay":
      return send(c, claimed.response, true);
    case "mismatch":
      throw new ApiProblem(422, "idempotency_key_reused", "Idempotency-Key reused", { detail: "This key was used for a different request." });
    case "in_flight":
      throw new ApiProblem(409, "idempotency_key_in_use", "Request in progress", {
        detail: "A request with this Idempotency-Key is still being handled.", headers: { "Retry-After": "2" },
      });
    case "bound": {
      // The original request reserved its job but never answered.
      const response = await rebuild(claimed.op);
      await completeIdempotencyKey(claimed.claim, response);
      return send(c, response, true);
    }
    case "claimed": {
      let response: StoredResponse;
      try {
        response = await run(claimed);
      } catch (err) {
        await releaseIdempotencyKey(claimed).catch(() => {});
        throw err;
      }
      await completeIdempotencyKey(claimed, response);
      return send(c, response);
    }
  }
}

// Core's typed errors, as problems. Each keeps the code core gives it.
import { ApiProblem } from "./problems.js";

export function fromCoreError(err: any): ApiProblem {
  if (err instanceof ApiProblem) return err;
  // createItem wraps a refusal ("Failed to create item: …") with its cause.
  const e = err?.cause && !err?.extensions && !err?.reason ? err.cause : err;
  if (e?.name === "ConflictError" || (e?.code === "conflict" && e?.reason)) {
    return new ApiProblem(409, e.reason, "Conflict", {
      detail: e.message,
      ...(e.reason === "generation_in_progress" ? { headers: { "Retry-After": "5" } } : {}),
    });
  }
  if (e?.name === "NotFoundError") return new ApiProblem(404, "not_found", "Not found", { detail: e.message });
  if (e?.name === "ForbiddenError") return new ApiProblem(403, "forbidden", "Forbidden", { detail: e.message });
  if (e?.extensions?.code && e?.status) {
    // FreePlanError: its code, status and payload (upgrade_url, limits, …).
    const { message, error: _error, code: _code, status: _status, ...payload } = e.extensions;
    const status = e.code === "free_plan_item_expired" ? 410 : e.status;
    return new ApiProblem(status, e.code, "Limit reached", {
      detail: message ?? e.message,
      ...payload,
      ...(status === 429 && payload.retryAfter ? { headers: { "Retry-After": String(payload.retryAfter) } } : {}),
    });
  }
  if (/scope|not English|OUT_OF_SCOPE/i.test(String(e?.message))) {
    return new ApiProblem(422, "request_refused", "The request can't be made in this language", { detail: String(e.message) });
  }
  console.error("[openapi] core error", err);
  return new ApiProblem(500, "internal", "Internal error", { detail: "Something went wrong on our side." });
}

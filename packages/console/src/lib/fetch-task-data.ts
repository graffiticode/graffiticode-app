// /data for the corpus ping and sweep, retried on 429 and 404.
//
// A 429 from /data is the api throttling the harness, not a verdict on the program — sweep wk2963
// lost half of L0176 to it. Back off and retry (honoring Retry-After) so a throttle reads as a
// slow step rather than a compile failure.
//
// A 404 is retried on the same schedule. Sweep wk2964 lost two L0175 programs to `/data returned
// 404` on freshly generated tasks, while the stored programs for the same prompts compiled clean
// minutes later — consistent with asking for a task before the api can see it (unconfirmed). A
// task that is really missing still 404s after the last retry, ~22s later, and fails as before.
// Anything else is returned as-is on the first attempt.
//
// ?refresh=1 recompiles rather than answering from the compile cache. A taskId is
// content-addressed over {lang, code} and carries no compiler version, so a verdict cached before
// a language shipped a breaking change keeps returning a clean 200 — a program the checker now
// rejects reads as a PASS. These checks exist to assert "this compiles", so they must reach the
// compiler, not the record. (L0172, 2026-09-04: three regenerated programs came out
// byte-identical to April ones and inherited their April verdicts.)
import { getBaseUrlForApi } from "@graffiticode-app/core/lib/api";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const MAX_RETRY_AFTER_MS = 30_000;

export async function fetchTaskData(taskId: string, accessToken: string, timeoutMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${getBaseUrlForApi()}/data?id=${encodeURIComponent(taskId)}&refresh=1`, {
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const retryable = resp.status === 429 || resp.status === 404;
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) return resp;
    const retryAfterSec = Number(resp.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS)
      : RETRY_DELAYS_MS[attempt];
    await resp.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

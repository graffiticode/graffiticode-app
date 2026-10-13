// OAuth access token for calling Google Cloud REST APIs from Cloud Run.
//
// We call GCP REST endpoints directly (fetch + this token) rather than using
// the @google-cloud/* SDKs: those load JSON/proto config files at runtime that
// Next.js standalone output-tracing doesn't bundle, which 500s the route.
// See the header comment on src/lib/generation-queue.ts.
//
// The metadata server returns the Cloud Run runtime service account's token
// with the cloud-platform scope, so the same token works for Cloud Tasks and
// Cloud Logging alike. Locally there is no metadata server and this throws —
// callers are expected to have a local escape hatch.

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export async function getAccessToken(): Promise<string> {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      // Off-GCP the hostname doesn't resolve, but on some networks it hangs
      // instead of failing fast. Bound it so the fallback isn't held up.
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const json = (await res.json()) as { access_token: string };
      return json.access_token;
    }
    throw new Error(`metadata token fetch failed: ${res.status}`);
  } catch (err) {
    // Off-GCP (scripts/funnel-report.ts, local dev): borrow the developer's own
    // gcloud credentials. Imported lazily so child_process is never pulled into
    // the Cloud Run bundle, where this branch is unreachable.
    try {
      const { execFileSync } = await import("child_process");
      const token = execFileSync("gcloud", ["auth", "print-access-token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (token) return token;
    } catch {
      // fall through to the original error — it's the more useful one on GCP
    }
    throw err;
  }
}

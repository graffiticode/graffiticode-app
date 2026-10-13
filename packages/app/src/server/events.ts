// Structured funnel events emitted to stdout → Cloud Logging (Cloud Run streams
// stdout automatically). One JSON line per event, mirroring the MCP server's
// src/events.ts so the console funnel report (scripts/mcp-funnel-report.ts) can
// read them with `gcloud logging read 'jsonPayload.ev="artifact_view"'`.
//
// Privacy: metadata only — the item id and two booleans. Never a raw prompt or
// PII. The app has no FREE_PLAN_NAMESPACE_SALT and the console doesn't forward
// the session here, so we log the item id; the report maps item id →
// sessionNamespace via the free-plan items it already reads.

export function logArtifactView(fields: { item: string; authed: boolean; allowed: boolean }): void {
  // Best-effort: instrumentation must never break a request.
  try {
    console.log(
      JSON.stringify({
        ev: "artifact_view",
        t: new Date().toISOString(),
        item: fields.item,
        authed: fields.authed,
        allowed: fields.allowed,
      }),
    );
  } catch {
    // ignore
  }
}

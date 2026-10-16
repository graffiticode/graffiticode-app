// Candidate check for mcp-service (deploy.json services.mcp.verify).
//
// The candidate must run in the backend its configuration names, and in core
// mode (Phase 3.5 R2) it must be able to do core's work: /health?deep=1
// checks Firestore, the generation queue, its secrets and free-plan
// credentials, and reports the generation protocol, which must meet the floor.

export default async ({ candidateUrl, headers, config, fetch, log }) => {
  const want = config.env?.GRAFFITICODE_BACKEND ?? "graphql";
  const res = await fetch(`${candidateUrl}/health?deep=1`, { headers, redirect: "manual" });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`/health?deep=1: ${res.status} ${JSON.stringify(body?.checks ?? body)}`);
  if (body?.backend !== want) throw new Error(`candidate runs backend ${body?.backend}, configuration says ${want}`);
  if (want === "core" && !(body.effectiveProtocol >= body.minProtocol)) {
    throw new Error(`candidate's generation protocol ${body.effectiveProtocol} is below the floor ${body.minProtocol}`);
  }
  log(`  backend ${body.backend}${want === "core" ? `; core ready (${Object.keys(body.checks).join(", ")}); protocol ${body.effectiveProtocol}, floor ${body.minProtocol}` : ""}`);
};

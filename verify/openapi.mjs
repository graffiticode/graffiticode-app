// Candidate check for openapi-service (deploy.json services.openapi.verify).
//
// It runs core in-process for items, so /health?deep=1 must report core ready
// (Firestore, the generation queue, its secrets, free-plan credentials), at a
// generation protocol that meets the floor; and the API description it serves
// must name the public server URL its configuration gives.

export default async ({ candidateUrl, headers, config, fetch, log }) => {
  const res = await fetch(`${candidateUrl}/health?deep=1`, { headers, redirect: "manual" });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`/health?deep=1: ${res.status} ${JSON.stringify(body?.checks ?? body)}`);
  if (!(body.effectiveProtocol >= body.minProtocol)) {
    throw new Error(`candidate's generation protocol ${body.effectiveProtocol} is below the floor ${body.minProtocol}`);
  }
  const spec = await (await fetch(`${candidateUrl}/v1/openapi.json`, { headers })).json();
  const want = config.env?.OPENAPI_PUBLIC_URL;
  if (want && spec?.servers?.[0]?.url !== want) throw new Error(`served description names ${spec?.servers?.[0]?.url}, configuration says ${want}`);
  log(`  core ready (${Object.keys(body.checks).join(", ")}); protocol ${body.effectiveProtocol}, floor ${body.minProtocol}; serves ${spec.servers[0].url}`);
};

// Candidate check for the console (deploy.json services.console.verify), run by
// gc-deploy against the new revision before it gets traffic.
//
// Generation protocol v2 (app tier Phase 3.5): once the Firestore floor is set,
// only an image that knows it may serve. Such an image reports its effective
// protocol at /api/health?deep=1, and it must be at least the floor. An image
// older than R1 has no such route and fails here — the same guarantee
// deploy.json's baseline gives, checked from the running candidate.

export default async ({ candidateUrl, headers, fetch, log }) => {
  const res = await fetch(`${candidateUrl}/api/health?deep=1`, { headers, redirect: "manual" });
  if (res.status !== 200) throw new Error(`/api/health?deep=1: expected 200, got ${res.status}`);
  const body = await res.json();
  const { effectiveProtocol, minProtocol } = body ?? {};
  if (!Number.isInteger(effectiveProtocol) || !Number.isInteger(minProtocol)) {
    throw new Error(`/api/health?deep=1: no protocol report (${JSON.stringify(body)})`);
  }
  if (effectiveProtocol < minProtocol) {
    throw new Error(`candidate's generation protocol ${effectiveProtocol} is below the floor ${minProtocol}`);
  }
  log(`  generation protocol: effective ${effectiveProtocol}, floor ${minProtocol}`);
};

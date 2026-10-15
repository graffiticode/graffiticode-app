// The code-level drain gate before generation protocol v2 is enabled (app tier
// Phase 3.5, R1.1). Correctness after the switch rests on two things: R1 code
// refuses legacy work on v2 items durably (generation-protocol.ts), and no
// pre-R1 code — the only code that writes without checking the item's pointer
// — is running or can be reached. This checks the second, per service:
//
//   1. no tag on a pre-R1 revision: a tagged revision stays callable at 0%
//      traffic and could start again after the gate passed;
//   2. no traffic on a pre-R1 revision;
//   3. no instance of a pre-R1 revision for longer than the service's request
//      timeout (so nothing it started can still be running).
//
// It deliberately does not wait for the queue to empty: a v1 task that reaches
// an R1 worker after the switch is refused, item by item.
//
// Pure, so it can be tested; scripts/generation-drain-check.ts gathers the
// inputs from Cloud Run and Cloud Monitoring.

export type Revision = { name: string; createdAt: number };
export type TrafficTarget = { revisionName?: string; percent?: number; tag?: string };
// Instance-count samples for one revision: [timestamp ms, instances].
export type InstanceSeries = Record<string, Array<[number, number]>>;

export type DrainInput = {
  service: string;
  // The first revision of the release that must be in place (R1 for the
  // console, R0.5 for mcp). Revisions created before it are "pre".
  floorRevision: string;
  revisions: Revision[];
  traffic: TrafficTarget[];
  instances: InstanceSeries;
  now: number;
  // How long a pre revision must have had no instances: at least the service's
  // request timeout (900s for the console), with margin.
  quietMs: number;
};

export type DrainVerdict = { service: string; ok: boolean; problems: string[]; pre: string[] };

export function drainVerdict(input: DrainInput): DrainVerdict {
  const { service, floorRevision, revisions, traffic, instances, now, quietMs } = input;
  const problems: string[] = [];
  const floor = revisions.find(r => r.name === floorRevision);
  if (!floor) {
    return { service, ok: false, problems: [`${service}: floor revision ${floorRevision} not found`], pre: [] };
  }
  const pre = revisions.filter(r => r.createdAt < floor.createdAt).map(r => r.name);
  const isPre = (name?: string) => !!name && pre.includes(name);

  for (const t of traffic) {
    if (!isPre(t.revisionName)) continue;
    if (t.tag) problems.push(`${service}: tag "${t.tag}" still points at pre-floor revision ${t.revisionName} (gc-deploy retire-tags)`);
    if ((t.percent ?? 0) > 0) problems.push(`${service}: pre-floor revision ${t.revisionName} has ${t.percent}% of traffic`);
  }
  // Traffic that names no revision follows the latest one; it must not be pre.
  if (traffic.some(t => !t.revisionName && (t.percent ?? 0) > 0)) {
    const latest = [...revisions].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && isPre(latest.name)) problems.push(`${service}: latest revision ${latest.name} predates the floor`);
  }

  const since = now - quietMs;
  for (const name of pre) {
    const samples = instances[name] ?? [];
    const busy = samples.filter(([at, n]) => at >= since && n > 0);
    if (busy.length) {
      const last = Math.max(...busy.map(([at]) => at));
      problems.push(`${service}: pre-floor revision ${name} had instances at ${new Date(last).toISOString()} (needs ${Math.round(quietMs / 60_000)} min with none)`);
    }
  }
  // Instance metrics cover the window only if they reach back far enough.
  const covered = Object.values(instances).flat().some(([at]) => at <= since + 5 * 60_000);
  if (pre.length && !covered) problems.push(`${service}: instance metrics don't cover the last ${Math.round(quietMs / 60_000)} minutes; can't confirm the drain`);

  return { service, ok: problems.length === 0, problems, pre };
}

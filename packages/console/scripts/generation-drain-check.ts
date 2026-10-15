#!/usr/bin/env node
/**
 * Has pre-R1 code drained? The gate before generation protocol v2 is enabled
 * (app tier Phase 3.5, R1.1). See src/lib/generation-drain.ts for what it
 * checks and why; this gathers the inputs, read-only, with the operator's
 * gcloud credentials.
 *
 * First retire every tag on a pre-R1 revision (failed candidates and release
 * tags included): `npm run deploy -- retire-tags console`, then the same for
 * mcp, and confirm with `gc-deploy release-check`.
 *
 *   npm run generation-drain-check -- --console-floor <first R1 console revision> \
 *     [--mcp-floor <first R0.5 mcp revision>] [--quiet-min 20]
 *
 * Exits 0 only when every named service has drained.
 */
import { execFileSync } from "child_process";
import { drainVerdict, type DrainVerdict, type InstanceSeries, type Revision, type TrafficTarget } from "../src/lib/generation-drain";

const PROJECT = "graffiticode-app";
const REGION = "us-central1";

// A service keeps every revision it ever had; the full JSON outgrows the
// default 1MB buffer, so ask only for what's needed, with room to spare.
const gcloud = (args: string[]) =>
  execFileSync("gcloud", [...args, `--project=${PROJECT}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024,
  });

function revisions(service: string): Revision[] {
  const out = gcloud(["run", "revisions", "list", `--service=${service}`, `--region=${REGION}`,
    "--format=value(metadata.name,metadata.creationTimestamp)"]);
  return out.split("\n").filter(Boolean).map(line => {
    const [name, created] = line.split("\t");
    return { name, createdAt: Date.parse(created) };
  });
}

function traffic(service: string): TrafficTarget[] {
  const svc = JSON.parse(gcloud(["run", "services", "describe", service, `--region=${REGION}`, "--format=json"]));
  return (svc.status?.traffic ?? []).map((t: any) => ({ revisionName: t.revisionName, percent: t.percent, tag: t.tag }));
}

async function instances(service: string, startMs: number, endMs: number): Promise<InstanceSeries> {
  const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  const filter = `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="${service}"`;
  const series: InstanceSeries = {};
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      filter,
      "interval.startTime": new Date(startMs).toISOString(),
      "interval.endTime": new Date(endMs).toISOString(),
      view: "FULL",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`monitoring timeSeries: ${res.status} ${await res.text()}`);
    const body: any = await res.json();
    for (const ts of body.timeSeries ?? []) {
      const name = ts.resource?.labels?.revision_name;
      if (!name) continue;
      const points = (ts.points ?? []).map((p: any) => [
        Date.parse(p.interval.endTime),
        Number(p.value.int64Value ?? p.value.doubleValue ?? 0),
      ] as [number, number]);
      series[name] = [...(series[name] ?? []), ...points];
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return series;
}

export async function checkDrain({ consoleFloor, mcpFloor, quietMin = 20, now = Date.now() }: {
  consoleFloor: string;
  mcpFloor?: string;
  quietMin?: number;
  now?: number;
}): Promise<DrainVerdict[]> {
  const quietMs = quietMin * 60_000;
  const targets: Array<[string, string]> = [["console", consoleFloor]];
  if (mcpFloor) targets.push(["mcp-service", mcpFloor]);
  const verdicts: DrainVerdict[] = [];
  for (const [service, floorRevision] of targets) {
    verdicts.push(drainVerdict({
      service,
      floorRevision,
      revisions: revisions(service),
      traffic: traffic(service),
      instances: await instances(service, now - quietMs - 10 * 60_000, now),
      now,
      quietMs,
    }));
  }
  return verdicts;
}

export function parseArgs(argv: string[]) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const consoleFloor = flag("--console-floor");
  if (!consoleFloor) throw new Error("--console-floor <first R1 console revision> is required");
  return { consoleFloor, mcpFloor: flag("--mcp-floor"), quietMin: Number(flag("--quiet-min") ?? 20) };
}

export function report(verdicts: DrainVerdict[]) {
  for (const v of verdicts) {
    console.log(`${v.ok ? "✓" : "✗"} ${v.service}: ${v.pre.length} pre-floor revision(s)${v.ok ? ", drained" : ""}`);
    for (const p of v.problems) console.log(`    ${p}`);
  }
  return verdicts.every(v => v.ok);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkDrain(parseArgs(process.argv.slice(2)))
    .then(v => { process.exitCode = report(v) ? 0 : 1; })
    .catch(err => { console.error(err.message ?? err); process.exit(2); });
}

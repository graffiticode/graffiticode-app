// Can this process do core's work? For a transport that runs core in-process
// (MCP in core mode, Phase 3.5 R2), a shallow /health says only that it
// started; this checks what core needs at runtime, so a deploy whose service
// account or configuration is short is refused before it takes traffic
// (gc-deploy smoke + verify on /health?deep=1).
//
// Read-only: nothing is enqueued or written. The queue check asks Cloud Tasks
// whether this identity may create tasks (testIamPermissions).
import { coreConfig } from "./config.js";
import { effectiveProtocol } from "./generation-protocol.js";
import { getAccessToken } from "./lib/gcp-token.js";
import { getFreePlanCredentials } from "./lib/free-plan-context.js";

export type Readiness = { ok: boolean; effectiveProtocol: number | null; minProtocol: number | null; checks: Record<string, string> };

async function check(checks: Record<string, string>, name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    checks[name] = "ok";
  } catch (err) {
    checks[name] = String((err as Error)?.message ?? err).slice(0, 200);
  }
}

export async function coreReadiness({ queue = true, freePlan = true }: { queue?: boolean; freePlan?: boolean } = {}): Promise<Readiness> {
  const checks: Record<string, string> = {};
  const c = coreConfig();
  let protocol: Awaited<ReturnType<typeof effectiveProtocol>> | null = null;
  await check(checks, "firestore", async () => { protocol = await effectiveProtocol(); });
  await check(checks, "config", () => {
    const missing = [
      ["INTERNAL_JOB_SECRET", c.generationQueue.secret],
      ["ACT_AS_GRANT_SECRET", c.actAs.grantSecret],
      ["NEXT_PUBLIC_FIREBASE_API_KEY", c.firebaseWebApiKey],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    // The worker must be the console's own origin: Cloudflare cuts long
    // requests at the public host (generation-queue.ts).
    if (!c.generationQueue.local && /graffiticode\.org/.test(c.generationQueue.workerUrl)) {
      throw new Error(`GENERATION_JOB_URL points at the public host (${c.generationQueue.workerUrl})`);
    }
  });
  if (queue && !c.generationQueue.local) {
    await check(checks, "queue", async () => {
      const q = c.generationQueue;
      const res = await fetch(`https://cloudtasks.googleapis.com/v2/projects/${q.project}/locations/${q.location}/queues/${q.name}:testIamPermissions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: ["cloudtasks.tasks.create"] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`testIamPermissions ${res.status}`);
      const granted = ((await res.json()) as { permissions?: string[] }).permissions ?? [];
      if (!granted.includes("cloudtasks.tasks.create")) throw new Error("cannot create tasks on the generation queue");
    });
  }
  if (freePlan) {
    await check(checks, "freePlan", async () => { await getFreePlanCredentials(); });
  }
  const p = protocol as Awaited<ReturnType<typeof effectiveProtocol>> | null;
  return {
    ok: Object.values(checks).every(v => v === "ok"),
    effectiveProtocol: p?.effective ?? null,
    minProtocol: p?.minProtocol ?? null,
    checks,
  };
}

#!/usr/bin/env node
/**
 * Enables generation protocol v2 (app tier Phase 3.5, R1.1). One-way.
 *
 * Runs the drain check (scripts/generation-drain-check.ts) and refuses unless
 * every pre-R1 console revision — and pre-R0.5 mcp revision, when named — has
 * no tag, no traffic and no instances. Then writes the Firestore floor
 * system/generation-protocol = {minProtocol: 2, activatedAt, activatedBy}.
 * From then on every producer reserves v2 jobs, whatever GENERATION_PROTOCOL
 * says, within a minute (the floor is re-read every 60s).
 *
 *   npm run enable-generation-v2 -- --console-floor <rev> [--mcp-floor <rev>] --yes
 *
 * Afterwards:
 *   - set GENERATION_PROTOCOL=v2 in deploy.json's console env and deploy, so
 *     configuration says what the floor already enforces;
 *   - record the R1 release as the console's baseline in deploy.json, so no
 *     image older than R1 (which doesn't know the floor) can be deployed;
 *   - check /api/health?deep=1 reports effectiveProtocol 2.
 *
 * There is no command to lower the floor in production. For staging
 * rehearsals only: `--remove-floor-staging --project <staging project>`, which
 * refuses if any v2 job exists.
 */
import { execFileSync } from "child_process";
import { activateGenerationV2, removeFloorForStaging } from "@graffiticode-app/core/generation-protocol";
import { checkDrain, parseArgs, report } from "./generation-drain-check";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--remove-floor-staging")) {
    const i = argv.indexOf("--project");
    await removeFloorForStaging({ project: i >= 0 ? argv[i + 1] : "" });
    console.log("Floor removed (staging).");
    return;
  }
  const args = parseArgs(argv);
  const drained = report(await checkDrain(args));
  if (!drained) {
    console.error("Not drained; v2 stays off.");
    process.exitCode = 1;
    return;
  }
  if (!argv.includes("--yes")) {
    console.log("Drained. Re-run with --yes to write the v2 floor (one-way).");
    return;
  }
  const by = execFileSync("gcloud", ["config", "get", "account"], { encoding: "utf8" }).trim() || "unknown";
  const { changed, floor } = await activateGenerationV2({ by });
  console.log(changed
    ? `v2 floor written: ${JSON.stringify(floor)}`
    : `v2 floor already in place: ${JSON.stringify(floor)}`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(2); });

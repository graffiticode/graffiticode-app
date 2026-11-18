// gc-profile: validate an installation profile, or generate its discovery files.
//   npm run profile -- validate <profile-dir>
//   npm run profile -- discovery <profile-dir> --out <dir>
//   npm run profile -- ttl <profile-dir>
// `ttl` prints the script that provisions the database's TTL policies
// (storage-ttl.ts) for the profile's project and database. It runs nothing.
// `discovery` writes app/llms.txt, app/.well-known/mcp.json, and (with a
// listing) skills/plugin.meta.json and its icon, plus discovery-receipt.json:
// the profile digest, this release's version, each file's sha256, the families
// advertised and omitted, and the languages discovery serves. APP_VERSION,
// PROFILE_REPO and PROFILE_REF are recorded when set.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadProfile, profileReceipt, ProfileError } from "./load.js";
import { renderTemplate } from "./template.js";
import { generateDiscoveryFiles } from "./discovery-files.js";
import { listLanguages } from "../lib/languages.js";
import { isDiscoverable } from "../discovery.js";
import { ttlProvisioningScript } from "../storage-ttl.js";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// Generates one installation's discovery files. Everything is local to the
// call (profile, rendered copy, catalog policy, receipt): nothing is installed
// in the process, so generations for different installations can run at once.
export async function discovery(dir: string, out: string, env: NodeJS.ProcessEnv = process.env) {
  const loaded = loadProfile(dir);
  const p = loaded.profile;
  const installed = { profile: p, digest: loaded.digest };
  const copy = new Map(Object.entries(p.copy ?? {}).map(([key, file]) => [key, renderTemplate(key, loaded.readText(file), p)]));
  const result = generateDiscoveryFiles({
    profile: p,
    installed,
    copy: key => copy.get(key) ?? null,
    readFile: rel => loaded.readBytes(rel),
  });
  if (result.problems.length) {
    throw new Error(`Can't generate discovery files for ${p.installation.id}:\n${result.problems.map(x => `  ${x}`).join("\n")}`);
  }
  const languages = (await listLanguages({ installed }))
    .filter(l => !l.internal && isDiscoverable(l.id, installed))
    .map(l => `L${l.id}`);
  const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
  // Only what describes the release: a developer's shell must not change the output.
  const receipt = {
    ...profileReceipt(loaded, { appVersion: env.APP_VERSION || "dev", profileRepo: env.PROFILE_REPO, profileRef: env.PROFILE_REF }),
    files: Object.fromEntries(Object.entries(result.files).map(([path, data]) => [path, sha(data)])),
    advertisedFamilies: result.advertisedFamilies,
    omittedFamilies: result.omittedFamilies,
    languages,
  };

  // Written to a fresh sibling directory, then swapped in: the output is
  // exactly this generation's files, with nothing left from an earlier one.
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), `.${basename(target)}.staging-`));
  try {
    for (const [path, data] of Object.entries(result.files)) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), data);
    }
    writeFileSync(join(staging, "discovery-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    const previous = existsSync(target) ? join(dirname(target), `.${basename(target)}.previous-${randomUUID()}`) : null;
    if (previous) renameSync(target, previous);
    renameSync(staging, target);
    if (previous) rmSync(previous, { recursive: true, force: true });
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return receipt;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const [command, dir, ...rest] = process.argv.slice(2);
  try {
    if (command === "validate" && dir) {
      const loaded = loadProfile(dir);
      console.log(`valid: ${loaded.profile.installation.id} (profile v${loaded.profile.profileVersion})`);
      console.log(`digest: ${loaded.digest}`);
    } else if (command === "discovery" && dir && rest[0] === "--out" && rest[1]) {
      const receipt = await discovery(dir, rest[1]);
      console.log(`wrote discovery files for ${receipt.installationId} to ${rest[1]} (profile ${receipt.profileDigest.slice(0, 12)})`);
      for (const o of receipt.omittedFamilies) console.log(`  omitted: ${o.family} (${o.reason})`);
    } else if (command === "ttl" && dir) {
      const { installation } = loadProfile(dir).profile;
      process.stdout.write(ttlProvisioningScript({ project: installation.project, database: installation.database }));
    } else {
      console.error("usage: gc-profile validate <profile-dir>\n       gc-profile discovery <profile-dir> --out <dir>\n       gc-profile ttl <profile-dir>");
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof ProfileError) fail(err.message);
    fail((err as Error).message);
  }
}

/**
 * Repair items whose stored program was truncated to its preamble.
 *
 * `..` ends a Graffiticode program, and the parser used to discard whatever
 * followed. A generated program carrying a stray `..` after its first
 * expression was therefore stored as just that expression — for L0176, a bare
 * `set-var "lrn-id" "<id>"..` that authors nothing. Every stage reported
 * success, so these accumulated silently.
 *
 * @graffiticode/parser 1.6.0 makes the trailing text a parse error, which stops
 * new ones. It does not repair the items already stored: this does.
 *
 * The item's original prompt survives in its `help` dialog, so each item is
 * re-authored from that prompt with `currentCode: null` — deliberately NOT from
 * the truncated source, which would show the model the very `..` pattern being
 * eliminated (that is how the last round of truncations happened even with good
 * RAG examples retrieved).
 *
 * Dry run by default; --apply writes. Originals are backed up first.
 *
 * --all re-authors every item with a stored prompt, not just the truncated
 * ones. A write only happens when the regenerated program parses AND authors
 * something, so an item whose regeneration fails keeps the code it has.
 *
 * Usage:
 *   npx tsx scripts/repair-truncated-items.ts --lang 0176
 *   npx tsx scripts/repair-truncated-items.ts --lang 0176 --apply
 *   npx tsx scripts/repair-truncated-items.ts --lang 0176 --all --apply
 *   npx tsx scripts/repair-truncated-items.ts --lang 0176 --id abc123 --id def456
 *
 * Requires: GRAFFITICODE_APP_CREDENTIALS, EVAL_API_KEY (in .env.local).
 */
import "./eval-env"; // MUST be first: prod Firestore/auth/api bootstrap

import admin from "firebase-admin";
import { writeFileSync } from "fs";
import { unparse } from "@graffiticode/parser";
import { generateCode } from "../src/lib/code-generation-service";
import { getCredentialsForApiKey } from "../src/lib/api-credentials";
import {
  parseCode,
  postTask,
} from "../src/pages/api/resolvers";
import { getLanguageLexicon } from "../src/lib/api";

const DEFAULT_UID = "2c9d72e315fbafb128011bc32739666c7e6e7eb9";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const LANG = arg("lang", "0176")!;
const UID = arg("uid", DEFAULT_UID)!;
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const CONCURRENCY = parseInt(arg("concurrency", "4")!, 10);
const ONLY_IDS = argAll("id");

/**
 * A program is truncated if it authors nothing: no list ever opens, so it can
 * only be a preamble. Mirrors model-eval's isStub, ignoring string contents so
 * a `[` inside a stimulus doesn't count.
 */
function isStub(src: string | null | undefined): boolean {
  if (!src) return true;
  return !src.replace(/"(\\.|[^"\\])*"/g, '""').includes("[");
}

/** The authoring request that produced this item, from its stored help dialog. */
function promptOf(item: any): string | null {
  let help: any = item.help;
  if (typeof help === "string") {
    try { help = JSON.parse(help); } catch { return null; }
  }
  if (!Array.isArray(help)) return null;
  for (const entry of help) {
    if (entry && typeof entry === "object" && typeof entry.user === "string" && entry.user.trim()) {
      return entry.user.trim();
    }
  }
  return null;
}

async function main() {
  const apiKey = process.env.EVAL_API_KEY;
  if (!apiKey) {
    console.error("Set EVAL_API_KEY (a dedicated account's api key) in .env.local");
    process.exit(1);
  }
  const creds = await getCredentialsForApiKey(apiKey);
  const auth = { token: creds.idToken, uid: creds.uid };

  const db = admin.firestore();
  const lexicon = await getLanguageLexicon(LANG);
  if (!lexicon) {
    console.error(`Could not fetch the L${LANG} lexicon; refusing to run.`);
    process.exit(1);
  }

  const snap = await db.collection(`users/${UID}/items`).where("lang", "==", LANG).get();

  const targets: any[] = [];
  let truncated = 0;
  snap.forEach((d) => {
    const x = d.data();
    if (ONLY_IDS.length && !ONLY_IDS.includes(d.id)) return;
    if (!x.code || typeof x.code !== "object") return;
    let src = "";
    try { src = unparse(x.code, lexicon); } catch { return; }
    const stub = isStub(src);
    if (stub) truncated++;
    // --all re-authors everything; otherwise only the truncated items.
    if (ALL || stub) targets.push({ id: d.id, ref: d.ref, data: x, src: src.trim(), stub });
  });

  console.log(
    `L${LANG}: ${snap.size} items scanned, ${truncated} truncated, ` +
    `${targets.length} to regenerate${ALL ? " (--all)" : ""}`,
  );
  if (!targets.length) return;
  if (!APPLY) console.log("(dry run — pass --apply to write)\n");

  if (APPLY) {
    // Timestamped: a later run must never clobber an earlier run's rollback.
    const backup = `repair-backup-${LANG}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(
      backup,
      JSON.stringify(targets.map((t) => ({ id: t.id, code: t.data.code, taskId: t.data.taskId })), null, 2),
    );
    console.log(`Backed up ${targets.length} originals to ${backup}\n`);
  }

  let repaired = 0, skipped = 0, failed = 0;
  const failures: Array<{ id: string; name: string; why: string }> = [];
  let done = 0;

  async function processOne(t: any) {
    const name = t.data.name || "unnamed";
    const prompt = promptOf(t.data);
    const tag = `${++done}/${targets.length} ${t.id} (${name})`;
    if (!prompt) {
      console.log(`  ⤫ ${tag}: no prompt in help — leaving its code untouched`);
      skipped++;
      return;
    }

    try {
      // currentCode: null — re-author from the prompt rather than editing the
      // truncated source, which would prime the model with the stray `..`.
      const res: any = await generateCode({
        auth,
        prompt,
        lang: LANG,
        currentCode: null,
        itemId: t.id,
        rid: `repair-${LANG}-${t.id}`,
      });

      const code: string = typeof res?.code === "string" ? res.code : "";
      if (!code || isStub(code)) {
        const why = `regenerated program authors nothing (${code.length} chars)`;
        console.log(`  ✗ ${tag}: ${why} — keeping existing code`);
        failures.push({ id: t.id, name, why });
        failed++;
        return;
      }

      // Parse with the real itemId, exactly as the console does before saving.
      const parsed: any = await parseCode({
        lang: LANG,
        src: code,
        publicValues: { itemId: t.id },
      });
      if (parsed?.errors?.length) {
        const why = parsed.errors.map((e: any) => e.message).join("; ");
        console.log(`  ✗ ${tag}: ${why} — keeping existing code`);
        // The offending source, so a parse failure is diagnosable without
        // re-running the generation.
        const at = parsed.errors[0]?.from;
        console.log(`      generated (${code.length} chars, error at ${at}):`);
        console.log(code.split("\n").map((l: string) => `      | ${l}`).join("\n"));
        failures.push({ id: t.id, name, why });
        failed++;
        return;
      }

      if (!APPLY) {
        console.log(`  ✓ ${tag}: ${code.length} chars, parses clean${t.stub ? " [was truncated]" : ""}`);
        repaired++;
        return;
      }

      // parseCode returns the node pool as a JSON *string*; both the task
      // payload and the item's stored `code` field want the object.
      const nodePool = JSON.parse(parsed.code);
      const posted: any = await postTask({
        auth,
        task: { lang: LANG, code: nodePool, item: t.id },
        ephemeral: false,
        isPublic: !!t.data.isPublic,
      });
      const taskId = posted?.id;
      if (!taskId) {
        const why = `postTask returned no id (${JSON.stringify(posted).slice(0, 80)})`;
        console.log(`  ✗ ${tag}: ${why} — keeping existing code`);
        failures.push({ id: t.id, name, why });
        failed++;
        return;
      }
      await t.ref.update({ code: nodePool, taskId, updated: Date.now() });
      console.log(`  ✓ ${tag}: ${code.length} chars, written${t.stub ? " [was truncated]" : ""}`);
      repaired++;
    } catch (e: any) {
      const why = String(e?.message || e).slice(0, 160);
      console.log(`  ✗ ${tag}: ${why} — keeping existing code`);
      failures.push({ id: t.id, name, why });
      failed++;
    }
  }

  // Small worker pool: these are long LLM calls, and one item took 5m alone.
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length)) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        await processOne(t);
      }
    }),
  );

  console.log(
    `\n${APPLY ? "Regenerated" : "Would regenerate"}: ${repaired}  skipped: ${skipped}  failed: ${failed}`,
  );
  if (failures.length) {
    console.log("\nFailures (existing code left in place):");
    for (const f of failures) console.log(`  ${f.id} (${f.name}): ${f.why}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});

/**
 * eval-dialect-fingerprint.ts — which version of a dialect a measurement was taken against.
 *
 * WHY. An eval result is a statement about a (model, prompt, DIALECT) triple, and the harness was
 * recording only the first two. When L0175 tightened its c1-t10 word validation, a candidate that
 * the Aug-8 sweep verified clean — `fixRounds: 2` then a compile with no errors — started
 * producing four hard errors on the identical source. Nothing in the run payload could distinguish
 * "the harness was wrong" from "the dialect moved", and the difference took twenty minutes of
 * bisecting compile paths to establish.
 *
 * A fingerprint makes that a lookup instead of an investigation, and it lets a label row say which
 * compiler its code was valid under — the same service anchorVersion performs for the rubric.
 *
 * WHAT IT FINGERPRINTS. `instructions.md`, because it is the one asset every dialect serves and the
 * one the generator is written against. It is a PROXY, not the compiler's version: a compiler can
 * change validation without touching its docs (which is exactly what happened here), so a matching
 * fingerprint is weak evidence of sameness while a differing one is strong evidence of change.
 * Recorded with `revised` from language-info.json when the dialect publishes one, which is the
 * closest thing to a declared version available over this interface.
 */
import { createHash } from "crypto";
import { getLanguageAsset } from "../src/lib/api";

export interface DialectFingerprint {
  /** First 12 hex of sha256(instructions.md) — short enough to eyeball in a diff. */
  hash: string;
  bytes: number;
  /** The dialect's own declared revision date, when it publishes one. */
  revised?: string;
  /** Set when the assets could not be fetched; the run is still usable, just unattributable. */
  error?: string;
}

export async function dialectFingerprint(lang: string): Promise<DialectFingerprint> {
  try {
    const instructions = await getLanguageAsset(`L${lang}`, "instructions.md");
    if (!instructions) return { hash: "unknown", bytes: 0, error: "instructions.md unavailable" };
    const hash = createHash("sha256").update(instructions).digest("hex").slice(0, 12);

    // Best-effort: a missing or unparseable language-info.json costs the `revised` field, never
    // the fingerprint. A dialect that serves no such file is common and not an error.
    let revised: string | undefined;
    try {
      const info = await getLanguageAsset(`L${lang}`, "language-info.json");
      const parsed = info ? JSON.parse(info) : null;
      if (parsed?.revised) revised = String(parsed.revised);
    } catch { /* leave revised undefined */ }

    return { hash, bytes: instructions.length, ...(revised ? { revised } : {}) };
  } catch (err: any) {
    return { hash: "unknown", bytes: 0, error: err?.message || String(err) };
  }
}

/** True when two fingerprints describe the same dialect version (unknowns never match). */
export function sameDialect(a?: DialectFingerprint | null, b?: DialectFingerprint | null): boolean {
  if (!a?.hash || !b?.hash) return false;
  if (a.hash === "unknown" || b.hash === "unknown") return false;
  return a.hash === b.hash;
}

export function formatFingerprint(f?: DialectFingerprint | null): string {
  if (!f) return "none";
  if (f.error) return `unknown (${f.error})`;
  return `${f.hash} (${f.bytes}b${f.revised ? `, revised ${f.revised}` : ""})`;
}

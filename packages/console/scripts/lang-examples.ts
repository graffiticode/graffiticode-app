/**
 * Locate a language's `examples.md` — the numbered prompt list its RAG corpus is generated from.
 *
 * WHY THIS EXISTS. Three scripts (create-items-from-prompts, extract-prompts, run-codegen) each
 * read `../../l{lang}/packages/core/spec/examples.md` off the filesystem. That only ever works
 * from a checkout with the language repos sitting beside it: it cannot run in Cloud Run, it
 * cannot run in CI, and it silently reads whatever branch that sibling happens to be on. The
 * language now serves the same file as a static asset (its build-static copies it into
 * dist/static/), so the fetch is the portable path and the filesystem read is the fallback.
 *
 * ORDER IS LOCAL-FIRST, DELIBERATELY. The normal workflow is "edit examples.md, then regenerate
 * the corpus from it" — asset-first would silently ignore the edit you just made and generate
 * from whatever is deployed. Local wins when present; the asset covers every environment that has
 * no sibling checkout. Which one was used is always logged, because a corpus generated from the
 * wrong copy is not otherwise distinguishable after the fact.
 *
 * Deliberately NOT importing src/lib/api: extract-prompts.ts is a standalone fs script with no
 * src/ imports and no eval-env bootstrap, and pulling that module chain in for one GET would give
 * it module-load side effects it does not want. This is one plain fetch.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ExamplesSource {
  text: string;
  /** Where it came from — a path or a URL. Log this; never leave it implicit. */
  source: string;
}

/**
 * Both package layouts, because both are in use: languages from 0174 up (plus 0000, 0003, 0010,
 * 0013) keep the spec under `packages/core/spec/`, while 0002 and the 0158-0173 family keep it
 * under `packages/api/spec/`. Knowing only `core` made the local read miss for every api-layout
 * language and fall through to the served asset — which those same languages do not publish, so
 * `readExamplesMarkdown("0172")` had no path at all and threw.
 */
const LOCAL_SPEC_DIRS = ["core", "api"];

export function localExamplesPaths(langCode: string): string[] {
  return LOCAL_SPEC_DIRS.map((pkg) =>
    path.resolve(__dirname, `../../l${langCode}/packages/${pkg}/spec/examples.md`));
}

export function localExamplesPath(langCode: string): string {
  return localExamplesPaths(langCode).find((p) => fs.existsSync(p)) ?? localExamplesPaths(langCode)[0];
}

function apiBase(): string {
  // Same default as src/lib/api's getBaseUrlForApi; eval-env pins this to prod when present.
  return (process.env.NEXT_PUBLIC_GC_API_URL || "https://api.graffiticode.org").replace(/\/+$/, "");
}

async function fetchExamplesAsset(langCode: string): Promise<ExamplesSource | null> {
  // `_cb` busts the CDN edge cache (assets are served max-age=3600), matching getLanguageAsset —
  // otherwise a language deploy takes up to an hour to be visible here.
  const url = `${apiBase()}/L${langCode}/examples.md?_cb=${Date.now()}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return null;
    const text = await resp.text();
    // A language that does not serve the file can answer 200 with an HTML error page or an empty
    // body; requiring a numbered prompt line is what distinguishes "served it" from "answered".
    if (!/^\s*\d+\.\s+/m.test(text)) return null;
    return { text, source: url.replace(/\?_cb=\d+$/, "") };
  } catch {
    return null;
  }
}

/**
 * Read `examples.md` for a language. Set EXAMPLES_SOURCE=asset to force the served copy (how to
 * verify a language actually publishes it) or =local to force the checkout.
 */
export async function readExamplesMarkdown(langCode: string): Promise<ExamplesSource> {
  const pref = process.env.EXAMPLES_SOURCE;
  const readLocal = (): ExamplesSource | null => {
    const localPath = localExamplesPaths(langCode).find((p) => fs.existsSync(p));
    return localPath ? { text: fs.readFileSync(localPath, "utf-8"), source: localPath } : null;
  };

  const order: Array<() => Promise<ExamplesSource | null> | ExamplesSource | null> =
    pref === "asset" ? [() => fetchExamplesAsset(langCode)]
    : pref === "local" ? [readLocal]
    : [readLocal, () => fetchExamplesAsset(langCode)];

  for (const attempt of order) {
    const got = await attempt();
    if (got) {
      console.log(`[examples] L${langCode} from ${got.source}`);
      return got;
    }
  }

  // Name only what was actually tried — EXAMPLES_SOURCE narrows the search, and reporting a
  // location that was never checked sends you looking in the wrong place.
  const tried = pref === "asset" ? [`${apiBase()}/L${langCode}/examples.md`]
    : pref === "local" ? [localPath]
    : [localPath, `${apiBase()}/L${langCode}/examples.md`];
  throw new Error(
    `No examples.md for L${langCode}. Tried: ${tried.join(", ")}. ` +
      `If the language should serve it, check its build-static copies spec/examples.md into dist/static/.`,
  );
}

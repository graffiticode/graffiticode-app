// Spec generation: the inverse of code generation. Given an authored item, produce a
// precise, platform-neutral English specification of its content that any other language's
// code generator can consume as a create_item description. The canonical artifact is the AST;
// `src` is decompiled from it via @graffiticode/parser's `unparse`, which we annotate with
// per-language hints (/* ... */ comments) to orient the translator. There is deliberately no
// RAG/demonstration layer: spec-gen is a determinacy-dominated, faithfulness-critical
// read-and-verbalize, and few-shot exemplars bias toward an "average spec," risking elision of
// artifact-specific detail. Knowledge lives in two rule layers only: instructions.md (canonical
// language semantics, reused from the gen direction) and unparse-hints (node-local deltas).

import axios from "axios";
import { unparse } from "@graffiticode/parser";
import { getApiTask, getApiData, getLanguageLexicon, getLanguageHints, getLanguageSpecDirective } from "./api.js";
import { readDialectInstructions, modelRejectsTemperature } from "./code-generation-service.js";
import { modeTierFor } from "./model-priority.js";
import { modelForProvider } from "./llm-models.js";
import { recordTokenUsage } from "./token-usage-service.js";
import { anthropicAuthHeaders, anthropicCredentialsConfigured } from "./anthropic-auth.js";

// Translation is faithfulness-critical and constrained (annotated src + instructions + the
// completeness contract fully determine the output), and get_spec sits in the hot path — so a
// small, fast model is the right DEFAULT. assertCoverage is the elision guard.
//
// Per-dialect, though, that reasoning can fail: a dialect shipping its own spec-directive.md may
// ask for something other than verbalize-the-content, and then the constraints no longer determine
// the output (L0177's recipe is the case — see its line in MODEL_PRIORITY). So the tier comes from
// the same table that decides code-gen routing, which is also the only place you can read it.
// Family is fixed: this calls the Anthropic Messages API directly.
const DEFAULT_SPEC_TIER = "fast" as const;

/**
 * Ceiling, and no thinking. Both were set by measurement on L0177, the longest spec this produces.
 *
 * 8192 was silently truncating: a run used 7990 output tokens, 3451 of them thinking, and anything
 * that thought longer lost the tail of the document — including the entire Verification steps
 * section — while still looking like a complete recipe and being cached as one.
 *
 * Raising it to 24576 fixed that and broke something worse: thinking expanded to fill the room, a
 * generation took 82.7s, and `get_spec` is a SYNCHRONOUS call behind Cloudflare's 100s edge
 * timeout. Real callers got a 524 while the work completed and cached server-side — an error for
 * the agent, with the answer sitting in the cache it never saw.
 *
 * Measured 3 cases x {adaptive, disabled}, same prompt, scored on 12 content checks:
 *   adaptive   86.3s   7663 output tokens   33/36
 *   disabled   42.7s   3707 output tokens   33/36
 * Identical quality, half the wall-clock, half the tokens. That is unsurprising for this task —
 * spec generation is a constrained read-and-verbalize whose output is determined by the source
 * plus the directive, which is the same reason there is no RAG layer here. Thinking had room to
 * spend and nothing to buy.
 *
 * The one observed difference: a thinking-disabled run emitted `#` headings where the directive
 * asks for `##`. Cosmetic, and cheap at 44 seconds.
 */
const SPEC_MAX_TOKENS = 16384;
const SPEC_THINKING = { type: "disabled" } as const;

// Generated specs are cached on the item doc, keyed by the taskId they were derived from.
// A taskId is content-addressed, so it covers every content change — but NOT a change to the
// prompt assets that shape the output for unchanged content (this file's SPEC_DIRECTIVE, a
// dialect's spec-directive.md, or its instructions.md). Bump this to invalidate every cached
// spec at once; it's the lever that exists so those edits never need a purge script. A model
// change needs no bump — the cache stamps the resolved model and compares it separately.
// 2 (2026-08-12): L0177 corrected three facts in instructions.md + spec-directive.md — the
// `init()` argument order (the shipped one registered no listeners and produced a silently blank
// editor), that `request.user` is an object, and that `errorListener` can fire after
// `readyListener`. None of that moves a taskId, a lang, or the resolved model, so 14 cached specs
// across two accounts would have kept serving instructions that cannot work. This is the case the
// version stamp exists for.
// 3 (2026-11-24): L0177's picker restriction changed (group_defaults false plus explicit template
// references; the old ten-group override was bypassed by search), and the prompt now carries the
// compiler's resolved picker and the design's holes (withCompiledData). Every cached L0177 recipe
// prescribes the old, bypassable restriction, and its taskId does not move. The bump is global
// because the holes block also reaches any other dialect that reports an incomplete design.
export const SPEC_CACHE_VERSION = 3;

/** SPEC_MODEL still wins outright — an operator hatch that needs no deploy and no table edit. */
export function specModelFor(lang: string | null | undefined): string {
  return process.env.SPEC_MODEL
    || modelForProvider("anthropic", modeTierFor(lang, "spec") || DEFAULT_SPEC_TIER);
}

// A completeness contract, NOT a style example. A checklist enforces structure without biasing
// the model toward an average level of detail (which would induce elision).
const SPEC_DIRECTIVE = `
You are given the source of a Graffiticode item in its authoring dialect, annotated with
/* ... */ hints. Using the dialect's semantics described above, describe this item's content as
a precise, PLATFORM-NEUTRAL English specification.

Rules:
- Enumerate EVERY authored element. For an assessment: every question, and for each its stem,
  every option, the answer key, and any rationale. For a sheet: every populated cell and its
  formula. Apply the analogous completeness bar to whatever this dialect authors.
- Preserve exact authored text (passages, prompts, option text, labels) verbatim.
- Omit ONLY language-specific encoding, plumbing, internal field names, and IDs.
- Do not mention Graffiticode, the dialect, node tags, or that you are reading source.
- Output only the specification prose. No preamble, no code fences.
`.trim();

export interface SpecResult {
  spec: string;
  lang: string;
  itemId: string;
  coverage: CoverageReport;
  /** The model that actually produced this spec, so a cache entry can stamp it. */
  model: string;
}

export interface CoverageReport {
  checked: number;
  missing: string[];
}

interface ClaudeCallArgs {
  system: string;
  user: string;
  model: string;
  rid?: string;
  itemId?: string | null;
  auth?: { uid: string };
}

async function callClaudeForSpec({ system, user, model, rid, itemId, auth }: ClaudeCallArgs): Promise<{ content: string; usage?: any }> {
  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: SPEC_MAX_TOKENS,
      thinking: SPEC_THINKING,
      // Opus deprecated `temperature` — omit it there or the API 400s.
      ...(modelRejectsTemperature(model) ? {} : { temperature: 0 }),
    },
    {
      headers: {
        "Content-Type": "application/json",
        ...(await anthropicAuthHeaders()),
        "anthropic-version": "2023-06-01",
      },
    },
  );
  // A truncated spec must never reach the caller, and must never be cached. Hitting the token
  // ceiling ends the response mid-sentence, but the text that did arrive still looks like a
  // recipe — headings, numbered steps, prose — just missing whatever came after the cut, which
  // for L0177 was the entire Verification steps section. Throwing is right rather than returning
  // partial text: getSpec's caller caches what it returns, so a silent truncation would be stored
  // and served indefinitely.
  if (resp.data?.stop_reason === "max_tokens") {
    throw new Error(
      `spec generation hit the ${SPEC_MAX_TOKENS}-token ceiling and was truncated ` +
      `(thinking + text share that budget); raise SPEC_MAX_TOKENS rather than shipping a partial spec`,
    );
  }

  // Record token usage if auth and rid are provided
  if (auth && rid && resp.data?.usage) {
    const usage = resp.data.usage;
    recordTokenUsage({
      auth,
      rid,
      stage: "spec_gen",
      itemId: itemId ?? null,
      provider: "anthropic",
      model,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
        cacheReadInputTokens: usage.cache_read_input_tokens || 0,
        reasoningTokens: 0,
      },
    }).catch(() => {
      // Never throw from usage recording
    });
  }

  // Join the TEXT blocks rather than reading content[0]. A thinking-capable model (Sonnet 5,
  // Opus 5 — thinking is on by default there, unlike 4.8) leads with a `thinking` block, so
  // content[0].text is undefined and the shortcut silently returned "" — a spec that was
  // generated, paid for, and thrown away, with no error anywhere. Latent until L0177 became the
  // first dialect to route get_spec off Haiku.
  const content = (resp.data?.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text ?? "")
    .join("");

  return { content, usage: resp.data?.usage };
}

// Collect substantial string literals from the AST pool. Short strings (keys, hex/encoding
// tokens, enum values) are skipped because the spec deliberately omits encoding; longer strings
// are very likely authored content (passages, stems, options) the spec must preserve.
const MIN_SALIENT_LEN = 16;

function collectSalientStrings(ast: any): string[] {
  const out: string[] = [];
  if (!ast || typeof ast !== "object") return out;
  for (const key of Object.keys(ast)) {
    if (key === "root") continue;
    const node = ast[key];
    if (node && typeof node === "object" && node.tag === "STR" && Array.isArray(node.elts)) {
      const v = node.elts[0];
      if (typeof v === "string" && v.trim().length >= MIN_SALIENT_LEN) {
        out.push(v);
      }
    }
  }
  return out;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Deterministic fidelity guard. Verifies the spec text references each salient authored string.
// Non-gating: returns a structured report so elisions are trackable ("loss is a bug"), and is
// immune to the demonstration-induced elision RAG would risk.
export function assertCoverage(spec: string, ast: any): CoverageReport {
  const salient = collectSalientStrings(ast);
  const haystack = normalize(spec);
  const missing = salient.filter((s) => !haystack.includes(normalize(s)));
  if (missing.length > 0) {
    console.warn(
      `[spec-gen] coverage: ${missing.length}/${salient.length} salient strings not found in spec`,
      missing.slice(0, 10),
    );
  }
  return { checked: salient.length, missing };
}

/**
 * Append what the compiler DERIVED to the prompt: values the source alone cannot carry.
 *
 * `<COMPILED_PATHS>`: each config key the design set, mapped to its exact destination path. The
 * mapping is the COMPILER's — irrecoverable from the source text, because the flattening is
 * ambiguous (L0177: `title-show` → `title.show`, but `enable-selection` → `enable_selection`).
 * L0177's directive tells the recipe to transcribe paths verbatim; while the prompt carried only
 * the unparsed AST, an implementer had to reconstruct them from Learnosity's docs, and under
 * fail-open semantics a derived path is worse than an acknowledged unknown.
 *
 * `<COMPILED_PICKER>`: L0177's resolved question-picker restriction — `group_defaults`, the groups
 * with their template references, and the templates they offer by name. The design names tags
 * (`allow-templates [BAR-CHART]`); the references are looked up by the compiler, so a recipe told
 * to copy them had nothing to copy until they were passed here.
 *
 * `<COMPILED_HOLES>`: the warnings of a design the compiler reports incomplete (`complete:
 * false`). Holes are what the recipe must tell the reader they still have to supply — including
 * an unsatisfiable picker restriction, for which the compiler deliberately emits no config.
 *
 * Each block is gated on its data being present, so a dialect that computes none of it gets a
 * byte-identical prompt.
 */
const PICKER_KEYS = ["group_defaults", "question_type_groups", "picker_templates"] as const;
export function withCompiledData(annSrc: string, compiled: any): string {
  let out = annSrc;
  const paths = compiled?.paths;
  if (paths && typeof paths === "object" && Object.keys(paths).length) {
    out += `\n\n<COMPILED_PATHS>\nThe compiler resolved each config key this design sets to its exact destination path. These are authoritative — reproduce them verbatim and never derive a path from a property name.\n${JSON.stringify(paths, null, 2)}\n`;
  }
  const picker = Object.fromEntries(PICKER_KEYS.filter((k) => compiled?.[k] !== undefined).map((k) => [k, compiled[k]]));
  if (Object.keys(picker).length) {
    out += `\n<COMPILED_PICKER>\nThe question-picker restriction the compiler resolved for this design. These values are authoritative — reproduce group_defaults and question_type_groups verbatim (every template reference exactly as given) and name the offered templates from picker_templates; never derive or retype a reference.\n${JSON.stringify(picker, null, 2)}\n`;
  }
  const holes = compiled?.complete === false && Array.isArray(compiled?.warnings) ? compiled.warnings : [];
  if (holes.length) {
    out += `\n<COMPILED_HOLES>\nThe compiler reports this design INCOMPLETE. Its warnings, holes first — the recipe must state each hole as something the reader must still provide, and must not present config the compiler did not emit:\n${JSON.stringify(holes, null, 2)}\n`;
  }
  return out;
}

/**
 * The compiled data a directive depends on could not be fetched. Retryable: nothing was generated
 * or cached, and the same request can succeed once the gateway answers.
 */
export class SpecDataUnavailableError extends Error {
  readonly code = "SPEC_DATA_UNAVAILABLE";
  readonly retryable = true;
  constructor(lang: string, taskId: string) {
    super(`get_spec: the compiled design for this L${lang} item is temporarily unavailable, and its recipe cannot be written without it. Nothing was generated or cached; retry get_spec. (task ${taskId})`);
    this.name = "SpecDataUnavailableError";
  }
}

/**
 * Whether a directive reads blocks that only compiled data supplies (`<COMPILED_PATHS>`,
 * `<COMPILED_PICKER>`, `<COMPILED_HOLES>`). For such a dialect a missing block is meaningful —
 * L0177 reads no `<COMPILED_PICKER>` as "write no restriction" — so data that failed to load must
 * stop generation rather than be mistaken for data that has none.
 */
export function directiveNeedsCompiledData(directive: string | null | undefined): boolean {
  return typeof directive === "string" && directive.includes("<COMPILED_");
}

/**
 * Generate an English spec for a task. `taskId` may be a composition chain (`head+up1+...`);
 * we describe the head (the authored item).
 */
export async function generateSpec({ auth, taskId, rid, itemId }: { auth: any; taskId: string; rid?: string; itemId?: string | null }): Promise<SpecResult> {
  const apiTask = await getApiTask({ id: taskId, auth });
  const taskList = Array.isArray(apiTask) ? apiTask : [apiTask];
  const task = taskList[0] || apiTask;
  const lang = task.lang;

  const [lexicon, hints, instructions, specDirective, compiled] = await Promise.all([
    getLanguageLexicon(lang, auth?.token),
    getLanguageHints(lang, auth?.token),
    readDialectInstructions(lang, auth?.token),
    getLanguageSpecDirective(lang, auth?.token),
    // The COMPILED data, for the one thing source cannot carry: values the compiler DERIVED.
    getApiData({ id: taskId, auth }),
  ]);

  // getApiData returns null on any failure. For a dialect whose directive reads compiled blocks
  // that null would silently produce a recipe missing them (an UNRESTRICTED picker, for L0177),
  // which the caller would then cache. Fail retryably instead.
  if (directiveNeedsCompiledData(specDirective) && (compiled === null || compiled === undefined)) {
    throw new SpecDataUnavailableError(lang, taskId);
  }

  const annSrc = unparse(task.code, lexicon || {}, { hints });

  if (!anthropicCredentialsConfigured()) {
    throw new Error("Anthropic credentials not configured; cannot generate spec");
  }

  // A dialect may ship a per-language spec-directive.md to override the global
  // content-oriented directive (e.g. to emit a developer "recipe" instead of a
  // content description). Absent → fall back to SPEC_DIRECTIVE (unchanged behavior).
  const directive = specDirective?.trim() || SPEC_DIRECTIVE;
  const system = `${instructions}\n\n${directive}`;
  const model = specModelFor(lang);
  const { content: spec } = await callClaudeForSpec({ system, user: withCompiledData(annSrc, compiled), model, rid, itemId, auth });
  const coverage = assertCoverage(spec, task.code);

  return { spec: spec.trim(), lang, itemId: taskId, coverage, model };
}

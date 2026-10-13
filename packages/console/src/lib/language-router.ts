import axios from "axios";
import { CLAUDE_MODELS } from "./code-generation-service";
import { listLanguages, findLanguageById, brandedLanguageIds, positiveSentences } from "./languages";
import { recordTokenUsage } from "./token-usage-service";
import {
  type RequestBudget,
  charge as chargeBudget,
} from "./request-budget";

// Hard bound on composition depth: head + at most (MAX_STAGES-1) upstream
// stages. Keeps chain length sane.
//
// Composition is REACTIVE — nothing in this file decides to compose. A head's
// generated program either emits `data use "<lang>"` or it does not, and
// generate-for-request.ts reads that off the parsed AST. What lives here is the
// FENCE (composesWithFor / fenceComposition), the head router (classifyAndRoute),
// and the per-stage prompt splitter (splitRequest).
//
// The pre-flight planner that used to live here — planSequence, planComposition,
// lookupPlanRAG over the L0010 planning corpus, orchestrateComposition,
// capturePlanForCuration — was removed on 2026-09-09. It ran before any code
// existed, so it could only guess from catalog blurbs, and its failures were
// charged to the wrong language: an upstream stage refusing the whole request
// with its own `OUT_OF_SCOPE:` sentinel told a user who asked L0173 for a bar
// chart that L0170 cannot draw charts. L0010 stays registered and keeps
// compiling; it is simply no longer called.
export const MAX_STAGES = 4;

// Pull language ids out of a string. With `requireUse`, matches only
// `use "<id>"` — the shape of a composition binding in source text, which is how
// generate-for-request.ts grandfathers the upstreams an item already had without
// a second parse round-trip.
export function extractLangIds(text: string, requireUse: boolean): string[] {
  if (!text) return [];
  const re = requireUse ? /\buse\s+"(\d{3,5})"/g : /"(\d{3,5})"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Composition permission helpers. Each language's `composesWith` allowlist is the HARD FENCE
// for composition: a head may only bind upstreams within it, and the client can never create
// an undeclared edge. It is a PERMISSION, not a trigger — what makes a head compose is its
// own instructions.md telling it to emit the binding.

// The upstreams a head language is permitted to compose with (["*"] = any non-internal).
// Empty ⇒ atomic only. Sourced from the static LANGUAGES array (sync, in-memory; hot-path).
export function composesWithFor(headLang: string): string[] {
  return findLanguageById(headLang)?.composesWith ?? [];
}

// Enforce the allowlist on a proposed sequence ([head, up1, up2, ...]). If ANY upstream
// is not permitted, drop to atomic [head] rather than post a partially-broken chain. Returns the
// fenced sequence plus any dropped (unpermitted) upstream ids for logging.
export function fenceComposition(
  sequence: string[],
  permits: string[],
): { sequence: string[]; dropped: string[] } {
  if (sequence.length <= 1) return { sequence, dropped: [] };
  const allowAny = permits.includes("*");
  const dropped = sequence.slice(1).filter((up) =>
    allowAny ? findLanguageById(up)?.internal === true : !permits.includes(up),
  );
  if (dropped.length > 0) return { sequence: [sequence[0]], dropped };
  return { sequence, dropped: [] };
}

interface LanguageSuggestion {
  id: string;
  name: string;
  description: string;
  reason: string;
}

interface RoutingResult {
  suggestions: LanguageSuggestion[];
}

// Build the catalog string used by both the routing helper (findBestLanguages)
// and findBestLanguages. excludeLang lets the routing path filter out the
// current language; findBestLanguages passes none so every
// language is in scope.
//
// Each entry uses scope.json fields (summary / in_scope / out_of_scope) when
// they're available from the lang server, falling back to routingHint or
// description otherwise. The richer block helps Haiku make a better routing
// suggestion than a single one-liner can.
async function buildLanguageCatalog(opts?: { excludeLang?: string; onlyLangs?: string[] }) {
  const languages = await listLanguages({ enrich: true });
  // Exclude internal dialects (e.g. the L0010 planner) so the router
  // never proposes itself as a composition stage; also honor excludeLang.
  //
  // Deprecated dialects are excluded too. This catalog feeds the two paths that
  // pick a language for NEW work — the scope gate's reroute and the composition
  // planner's upstreams — and neither should ever land on a dialect we have
  // superseded. languages.ts notes that `status` "is only a label and filters
  // nothing", with the steer left in the routingHint text; on 2026-08-29 that
  // steer lost. A concept-web request was rerouted to L0166, whose hint reads
  // "Deprecated in favor of L0179 — prefer L0179 for all new spreadsheet
  // content", and the reviewer got a spreadsheet in the dead dialect. Prose in a
  // catalog entry is a suggestion to a model; this is the fence.
  //
  // Deliberately narrow. Existing items still render, `language(id)` still
  // resolves, findLanguageById still answers, and composesWith still PERMITS a
  // deprecated upstream (L0158/L0176 keep composing with 0166) — a chain already
  // authored against one keeps working. Only the act of choosing one for
  // something new is blocked.
  const candidates = languages.filter(
    (l) =>
      !l.internal &&
      l.status !== "Deprecated" &&
      (!opts?.excludeLang || l.id !== opts.excludeLang) &&
      (!opts?.onlyLangs || opts.onlyLangs.includes(l.id)),
  );
  const catalog = candidates
    .map((l) => {
      const head = l.summary || l.routingHint || l.description;
      const lines = [`- L${l.id}: ${head}`];
      if (l.inScope && l.inScope.length > 0) {
        lines.push(`    in scope: ${l.inScope.join("; ")}`);
      }
      if (l.outOfScope && l.outOfScope.length > 0) {
        lines.push(`    out of scope: ${l.outOfScope.join("; ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  return { candidates, catalog };
}

export async function findBestLanguages({
  userRequest,
  outOfScopeReason,
  currentLang,
  rid,
  itemId,
  auth,
  budget,
}: {
  userRequest: string;
  outOfScopeReason: string;
  currentLang: string;
  rid?: string;
  itemId?: string | null;
  auth?: { uid: string };
  /** Request-wide token budget; these calls bypass the provider seam. */
  budget?: RequestBudget;
}): Promise<RoutingResult> {
  try {
    const { candidates, catalog } = await buildLanguageCatalog({ excludeLang: currentLang });

    if (candidates.length === 0) {
      return { suggestions: [] };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("[language-router] ANTHROPIC_API_KEY not set");
      return { suggestions: [] };
    }

    chargeRouterAttempt(budget);
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: CLAUDE_MODELS.HAIKU,
        max_tokens: 500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `A user asked: "${userRequest}"

This was rejected by the current language (L${currentLang}) because: ${outOfScopeReason}

Available languages:
${catalog}

Which languages (max 3) could handle this request? Match based on specific capabilities described above. Return JSON only:
{"suggestions": [{"id": "0159", "reason": "brief explanation"}]}

If none fit, return {"suggestions": []}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: ROUTER_TIMEOUT_MS,
      }
    );

    // Record token usage if auth and rid are provided
    chargeRouterResult(budget, response.data?.usage);
    if (auth && rid && response.data?.usage) {
      const usage = response.data.usage;
      await recordTokenUsage({
        auth,
        rid,
        stage: "route_rescope",
        itemId: itemId ?? null,
        lang: currentLang,
        provider: "anthropic",
        model: CLAUDE_MODELS.HAIKU,
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

    const text = response.data?.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { suggestions: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const suggestions: LanguageSuggestion[] = (parsed.suggestions || [])
      .slice(0, 3)
      .map((s: { id: string; reason: string }) => {
        const lang = candidates.find((l) => l.id === s.id);
        return {
          id: s.id,
          name: lang?.name || `L${s.id}`,
          description: lang?.description || "",
          reason: s.reason,
        };
      })
      .filter((s: LanguageSuggestion) => s.description);

    return { suggestions };
  } catch (error) {
    console.error("[language-router] Error:", error.message);
    return { suggestions: [] };
  }
}

export interface RouteResult {
  inScope: boolean;
  routedLang: string | null;
  reason: string;
}

// Authoritative pre-flight head router. Given a request and the language the client picked,
// decide whether the request is in-scope for that language; if not, name the best-fit language
// from the catalog. The SERVER uses this to honor or override the client's pick — the guardrail
// against clients (e.g. Codex/ChatGPT) freelancing the head language.
//
// FAIL-OPEN: any classifier error / missing key / unparseable response returns inScope:true
// (proceed with the client pick), logged. Availability beats blocking a valid request on an LLM
// hiccup; divergence is observable via logs. (This is the honest hole in "no exception".)
export async function classifyAndRoute({
  userRequest,
  currentLang,
  rid,
  itemId,
  auth,
  budget,
}: {
  userRequest: string;
  currentLang: string;
  rid?: string;
  itemId?: string | null;
  auth?: { uid: string };
  /** Request-wide token budget; these calls bypass the provider seam. */
  budget?: RequestBudget;
}): Promise<RouteResult> {
  const FAIL_OPEN: RouteResult = { inScope: true, routedLang: null, reason: "" };
  // Separate the ASK from source material pasted under it.
  //
  // get_spec is the platform's sanctioned cross-language bridge, and create_item
  // tells agents in so many words to pass its output "as this description, adding
  // only your intent/target framing". The resulting prompt is one instruction
  // followed by a wall of the OTHER language's content — so the sanctioned bridge
  // hands this classifier a request whose bulk argues for the language being
  // converted AWAY from. On 2026-08-29 a reviewer's "Create a concept web from the
  // following content" lost to the 1100 characters of column widths and hex fills
  // pasted beneath it, and the concept web came back a spreadsheet.
  //
  // Splitting on the first blank line is deterministic and reversible, which prose
  // guidance is not: telling the model to disregard quoted material was tried and
  // lost to sheer volume — a 3:1 ratio of spreadsheet vocabulary still routed to a
  // spreadsheet. Structure beats instruction when the instruction is outnumbered.
  //
  // No blank line means nothing to separate, and the whole prompt stays the ask.
  // The tail is kept (truncated) rather than dropped: it is real evidence about
  // subject matter, and a classifier that cannot see it would be guessing.
  const splitAt = userRequest.indexOf("\n\n");
  const askText = splitAt > 0 ? userRequest.slice(0, splitAt).trim() : userRequest;
  const sourceText = splitAt > 0 ? userRequest.slice(splitAt).trim().slice(0, 1200) : "";

  // A named brand outranks the item-type words beside it. "<Brand> quiz", naming a survey
  // product with the wrong noun, was left to the classifier once: "quiz" matched L0180 and the
  // survey language's own "do NOT route a quiz here" clause, and the user got a quiz. So when
  // the ASK names a brand, the verdict is confined to the languages that carry it: judged
  // against one of them (the client's pick if it is one), rerouted only among them, and refused
  // when none fits — a "<Brand> concept web" is refused, never quietly handed to L0169.
  const branded = brandedLanguageIds(askText);
  const evalLang = branded.length && !branded.includes(currentLang) ? branded[0] : currentLang;
  // In brand mode the question changes. A scope's out_of_scope clauses exist to keep
  // UNBRANDED requests out ("do NOT route a quiz here"), and a note saying the brand decides
  // lost to them: "Take the <Brand> quiz" was refused on the survey language's own quiz clause. With the
  // language already decided, the only question left is whether the ask is for the kind of
  // artifact it makes under any name, so those clauses — and the steer-away sentences in its
  // summary — are withheld and the question is asked directly.
  const brandNote = branded.length
    ? `
The request names ${branded.length === 1 ? "a product that" : "a platform whose products"} only ${branded.map((id) => `L${id}`).join(", ")} ${branded.length === 1 ? "serves" : "serve"}, so the language is already decided by that name. L${evalLang} makes exactly one kind of artifact: ${findLanguageById(evalLang)?.description ?? `L${evalLang} content`}. Users often call it by a looser or wrong noun (quiz, test, form, questionnaire), and that is still in scope. But if the request names a DIFFERENT kind of artifact — a concept web, diagram, chart, spreadsheet, flashcards, or anything else that is not that — it is out of scope. Do not judge details such as missing inputs; the language reports those itself.
`
    : "";
  // Relabel the verdict for the caller, who asked about currentLang.
  const verdict = (r: RouteResult): RouteResult =>
    evalLang === currentLang ? r
      : r.inScope ? { inScope: false, routedLang: evalLang, reason: `request names a brand served by L${evalLang}` }
      : r;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("[routing] ANTHROPIC_API_KEY not set; fail-open (in-scope)");
      return verdict(FAIL_OPEN);
    }
    const all = await listLanguages({ enrich: true });
    const current = all.find((l) => l.id === evalLang);
    const { candidates, catalog } = await buildLanguageCatalog({
      excludeLang: evalLang,
      onlyLangs: branded.length ? branded : undefined,
    });
    const curScope = [
      // Brand mode withholds the steer-away sentences with the out_of_scope list, same reason.
      (branded.length ? positiveSentences : (t: string) => t)(
        current?.summary || current?.routingHint || current?.description || `L${evalLang}`,
      ),
      current?.inScope?.length ? `in scope: ${current.inScope.join("; ")}` : "",
      !branded.length && current?.outOfScope?.length ? `out of scope: ${current.outOfScope.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    // Decide on the ASK; confirm on the SOURCE.
    //
    // Splitting the two (above) was not enough. Measured 2026-09-17 against the
    // real classifier and the live catalog: "Make a flashcard deck from this."
    // with a quiz spec pasted below it rerouted L0181 -> L0180 every time, and
    // the model's own reason said why — "the source material is a scored
    // assessment ... this is a quiz that belongs in L0180". The SAME ask with no
    // source attached is in-scope. One sentence of instruction does not outweigh
    // 1,200 characters of the other language's content, however the prompt is
    // worded: "classify on the request above, never on this" was already in the
    // prompt, and was already being read.
    //
    // So the source no longer reaches the decision that matters. Phase 1 sees the
    // ask alone — which is what the user actually asked for. Only when that comes
    // back OUT of scope does phase 2 re-ask with the source attached, and a
    // reroute requires both to agree.
    //
    // The asymmetry is deliberate. A false reroute silently produces the WRONG
    // ARTIFACT — flashcards requested, quiz delivered, no error anywhere — while
    // a missed reroute leaves the request with the language the client chose,
    // which the generator usually absorbs and which the downstream OUT_OF_SCOPE
    // path still catches. Spend the extra call on the damaging direction only.
    //
    // Phase 1 is also the cheaper call (1,200 fewer characters of input) and it is
    // the common case, so the ordinary create got faster, not slower.
    const classify = async (src: string): Promise<RouteResult> => {
      chargeRouterAttempt(budget);
      const response = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: CLAUDE_MODELS.HAIKU,
          max_tokens: 300,
          temperature: 0,
          // Stop once the JSON block closes.
          //
          // The verdict is the FIRST thing this model emits, and it emits it inside a
          // ```json fence. Everything after the closing fence is the model explaining
          // itself to nobody: the parser takes the first {...} and discards the rest.
          // Measured 2026-09-04 on the real prompt and real scopes, 7 cases: an
          // in-scope verdict cost 93-125 output tokens, of which 15 were the JSON.
          // Stopping at the fence cut those calls ~65% (2,167ms -> 696ms) and the set
          // 51%, with 0/7 verdict changes — reroutes included, which save little and
          // should, since their `reason` is genuinely part of the JSON.
          //
          // Anthropic excludes the stop text from the response, so "\n```" keeps the
          // closing brace the parser needs and drops only the fence. Degrades safely:
          // an unfenced answer never matches, and the call behaves exactly as before.
          //
          // NOT the same thing as telling the model to be terse. That was tried on the
          // same cases and CHANGED VERDICTS — "Multiply 10 and 21" rerouted away from
          // L0000. Sampling is untouched here; only the tail is cut.
          stop_sequences: ["\n```"],
          messages: [
            {
              role: "user",
              // "sent this request to", not "asked … to CREATE this".
              //
              // The frame is evidence to the classifier, and "create" asserted a verb
              // the request never used. For most languages that is harmless — creating
              // a spreadsheet IS the request — but a language whose purpose is acting
              // on something that already exists gets the frame arguing against it:
              // L0182 takes a survey the back end holds and cannot author one, so
              // "Take the you-can-choose survey." reached the model as a request to
              // CREATE a survey and matched L0182's own out-of-scope clause forbidding
              // exactly that. Measured on 13 cases, 2026-09-11: the neutral frame flips
              // that refusal (and "Answer the city-budget survey for me.") to in-scope
              // and changes no other verdict — the authoring request stays refused, and
              // every cross-language reroute lands where it did before.
              content: `A user sent this request to language L${evalLang}:
  "${askText}"
  ${src ? `
  The user also pasted the following SOURCE MATERIAL below that request. It is
  content to be CONVERTED, not a description of what to build — classify on the
  request above, never on this:
  """
  ${src}
  """
  ` : ""}
  L${evalLang} scope:
  ${curScope}
  ${brandNote}
  Decide whether this request is IN SCOPE for L${evalLang}.
  - If it clearly belongs in L${evalLang}, return {"inScope": true}.
  - If it does NOT belong in L${evalLang}, pick the single best-fit language id from the catalog below (or null if none fits): {"inScope": false, "routedLang": "<id or null>", "reason": "<one sentence>"}.

  Catalog of other languages:
  ${catalog || "(none)"}

  Be conservative: only route away when the request clearly belongs to a different language. Return JSON only.`,
            },
          ],
        },
        {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          timeout: ROUTER_TIMEOUT_MS,
        },
      );

      // Record token usage if auth and rid are provided
      chargeRouterResult(budget, response.data?.usage);
      if (auth && rid && response.data?.usage) {
        const usage = response.data.usage;
        await recordTokenUsage({
          auth,
          rid,
          stage: "route_scope_gate",
          itemId: itemId ?? null,
          lang: evalLang,
          provider: "anthropic",
          model: CLAUDE_MODELS.HAIKU,
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

      const text = response.data?.content?.[0]?.text || "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        // Was silent. A fail-open here disables the gate for that request, and the
        // stop sequence above is one more way to reach it (an answer that opened
        // with a fence on its own line would stop at once, empty). If this line
        // starts appearing, that is the first thing to check.
        console.warn(
          `[routing] rid=${rid} no JSON in classifier output; fail-open (in-scope) len=${text.length}`,
        );
        return verdict(FAIL_OPEN);
      }
      const parsed = JSON.parse(m[0]);
      if (parsed.inScope === true) return verdict({ inScope: true, routedLang: null, reason: "" });
      let routedLang: string | null = parsed.routedLang ? String(parsed.routedLang).replace(/^L/i, "") : null;
      // Validate against the real, non-internal catalog (buildLanguageCatalog already excludes internal).
      if (routedLang && !candidates.some((c) => c.id === routedLang)) routedLang = null;
      return { inScope: false, routedLang, reason: String(parsed.reason || "") };
    };

    const askOnly = await classify("");
    // Nothing was pasted, so there is no second opinion to be had.
    if (askOnly.inScope || !sourceText) return askOnly;

    const withSource = await classify(sourceText);
    if (withSource.inScope) {
      // The two disagree. Keep the client's pick: the ask is the request, and the
      // pasted material is what it operates ON.
      console.log(
        `[routing] rid=${rid} scope-gate split-verdict lang=L${currentLang} ask=out-of-scope source=in-scope — keeping the client pick`,
      );
      return withSource;
    }
    return {
      inScope: false,
      routedLang: withSource.routedLang ?? askOnly.routedLang,
      reason: withSource.reason || askOnly.reason,
    };
  } catch (err) {
    console.warn(`[routing] classifyAndRoute failed; fail-open (in-scope): ${(err as Error)?.message}`);
    return verdict(FAIL_OPEN);
  }
}

/**
 * Split one user request into a per-stage prompt for each language in an already-decided
 * sequence.
 *
 * Every stage of a composition used to be generated from the ORIGINAL prompt verbatim, on the
 * theory that "content always comes from the original prompt; the sequence only fixes order."
 * That works until a dialect has a sharp scope boundary: an upstream then receives the host's
 * framing (a stem, difficulty tags, an answer key, a second unrelated question) and a dialect
 * whose instructions say "if the request is for one of these, say so instead of emitting a
 * program" refuses a request it was correctly chosen for. Telling the upstream to ignore the
 * noise treats the symptom; not sending it is the fix.
 *
 * This runs AFTER the head has already been generated: the sequence comes from the `data use`
 * bindings the head emitted, which carry lang ids and nothing else. The head keeps the original
 * prompt (it is the language the user chose, and on an edit only the verbatim request lines up
 * with currentCode); only the upstreams get a scoped share. One Haiku call, fail-open.
 *
 * FIDELITY IS THE WHOLE RISK HERE. A vague sub-prompt ("a spreadsheet with some test scores")
 * is WORSE than the noise it replaces: the noise made a stage refuse loudly, while a lossy
 * sub-prompt compiles clean and authors the wrong content. So the split is a PARTITION, not a
 * summary — every concrete value in the request must reach exactly one stage verbatim, and on
 * any doubt the caller falls back to the original prompt rather than a paraphrase.
 *
 * Returns null (caller uses the original prompt for every stage) on any failure, malformed
 * output, or length mismatch.
 */
export async function splitRequest({
  prompt,
  sequence,
  rid,
  itemId,
  auth,
  budget,
}: {
  prompt: string;
  sequence: string[];
  rid?: string | null;
  itemId?: string | null;
  auth?: any;
  /** Request-wide token budget; these calls bypass the provider seam. */
  budget?: RequestBudget;
}): Promise<string[] | null> {
  if (sequence.length <= 1) return null;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const all = await listLanguages({ enrich: true });
    const roster = sequence
      .map((id, i) => {
        const l = all.find((x) => x.id === id);
        const scope = l?.summary || l?.routingHint || l?.description || `L${id}`;
        const role = i === 0 ? "HEAD — what the user ultimately gets" : `upstream stage ${i}`;
        return `L${id} (${role}): ${scope}`;
      })
      .join("\n\n");

    chargeRouterAttempt(budget);
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: CLAUDE_MODELS.HAIKU,
        max_tokens: 1500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `A user asked for this:
"${prompt}"

It will be built as a pipeline of ${sequence.length} stages, already decided:

${roster}

Write one prompt per stage, saying what THAT stage must author and nothing else.

Rules — the first is the one that matters:
1. PARTITION, DO NOT SUMMARIZE. Copy every concrete detail into the stage that owns it, VERBATIM: numbers, cell references, formulas, labels, option text, stems, tags, standards codes, answer keys. Never replace a value with a description of it — "85, 92, 78, 95, 88 in B2 through B6" must stay those digits and those cells, never "some test scores". If you cannot tell which stage owns a detail, put it in BOTH.
2. Each stage prompt must stand alone. It is read by a generator that sees ONLY that prompt — no other stage's text, no knowledge that a pipeline exists.
3. Give each stage only what its own description above says it authors. Do not hand a stage another stage's content.
4. Do not invent content the user did not ask for. If a stage's share is not described in the request, say plainly what little is known rather than inventing values.
5. Phrase each as a direct instruction ("Create ...", "Author ..."), not as a description of the request.

Return JSON only, exactly ${sequence.length} stages, in the same order:
{"stages": [${sequence.map((id) => `{"lang": "${id}", "prompt": "<what L${id} authors>"}`).join(", ")}]}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: ROUTER_TIMEOUT_MS,
      },
    );

    chargeRouterResult(budget, response.data?.usage);
    if (auth && rid && response.data?.usage) {
      const usage = response.data.usage;
      await recordTokenUsage({
        auth,
        rid,
        stage: "compose_split",
        itemId: itemId ?? null,
        lang: sequence[0],
        provider: "anthropic",
        model: CLAUDE_MODELS.HAIKU,
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

    const text = response.data?.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const stages = JSON.parse(m[0])?.stages;
    if (!Array.isArray(stages) || stages.length !== sequence.length) return null;

    // Order and langs must match the decided sequence exactly — a split that
    // disagrees about which lang is which would silently swap two stages' content.
    const prompts: string[] = [];
    for (let i = 0; i < sequence.length; i++) {
      const st = stages[i];
      if (String(st?.lang || "").replace(/^L/i, "") !== sequence[i]) return null;
      const p = String(st?.prompt || "").trim();
      if (!p) return null;
      prompts.push(p);
    }
    return prompts;
  } catch (err) {
    console.warn(`[composition] splitRequest failed; using original prompt for every stage: ${(err as Error)?.message}`);
    return null;
  }
}

/**
 * Charge a router Haiku call against the request budget.
 *
 * These calls post to the Anthropic API directly rather than through
 * `requestProvider`, so they are the one family of model calls the provider
 * seam cannot see. Without this they would be free, and a scope gate plus a
 * suggester plus a splitter is three calls a runaway never pays for.
 *
 * Floored at an estimate of what was sent, for the same reason the provider
 * seam floors its charge: a failed call reports no usage at all, and those are
 * the calls that matter here.
 */
function chargeRouterAttempt(budget: RequestBudget | undefined): void {
  if (!budget) return;
  // Counts the ATTEMPT only, no tokens. These calls are fail-open, so a
  // charge that ran only after a successful response would make exactly the
  // failing calls free — and a router stuck in a retry loop is one of the
  // shapes the call ceiling exists to stop. Tokens are added below when the
  // provider reports them.
  chargeBudget(budget, null, 0);
}

/**
 * Add what the provider actually reported, once the call has returned.
 * `countCall: false` — the attempt above already counted it.
 */
function chargeRouterResult(
  budget: RequestBudget | undefined,
  usage: any,
): void {
  if (!budget || !usage) return;
  chargeBudget(
    budget,
    {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
      reasoningTokens: 0,
    },
    0,
    false,
  );
}

/**
 * Timeout for the router calls.
 *
 * These were bare `axios.post` with no timeout at all — axios defaults to
 * infinite — and they never consult the request deadline, so one hung Haiku
 * call could eat the whole 420s request budget before generation began.
 */
const ROUTER_TIMEOUT_MS = 30_000;


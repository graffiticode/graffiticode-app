// Request-level code generation: the orchestration that turns ONE user request
// into a posted (possibly `+`-chained) task.
//
// This is the layer ABOVE the per-stage generator. `generateCode` in
// ../code-generation-service.ts generates a single language's program; this
// function owns everything around that — the scope gate, the reactive
// composition path and its permission fence, upstream generation, the atomic
// fallback, and stitching `head+s2+s3`.
//
// Composition here is REACTIVE, never planned: nothing decides to compose before
// the head is generated. The head's own instructions.md decides, by emitting
// `data use "<lang>"`; this module notices the binding after the parse and
// generates exactly those upstreams, if `composesWith` permits them. The
// pre-flight LLM planner that used to sit above generation (planSequence /
// planComposition / the L0010 planning-RAG) was removed on 2026-09-09: it ran on
// every fresh create whose head declared an edge, and its worst failure was
// silent to the head language — an upstream stage refusing the WHOLE request
// with its own `OUT_OF_SCOPE:` sentinel, so a user asking L0173 for a bar chart
// was told L0170 cannot draw charts.
//
// It lives here rather than in pages/api/resolvers.ts so that scripts, jobs and
// the GraphQL resolver all reach the SAME code path. When it lived in the
// resolver, scripts could only import the per-stage generator, so anything they
// produced was silently atomic — no plan, no upstream, no chain.
//
// IMPORTANT — do NOT re-export this from ../code-generation-service.ts or from a
// code-generation/index.ts barrel. language-router.ts imports
// code-generation-service, and this module imports language-router; routing the
// export through either of those recreates that cycle. Import the deep path.
import { unparse } from "@graffiticode/parser";
import { getLanguageAsset, getLanguageLexicon, isLangOverridden } from "../api";
import { generateCode as codeGenerationService, getRelevantExamples, extractSearchQuery } from "../code-generation-service";
import {
  MAX_STAGES,
  classifyAndRoute,
  composesWithFor,
  extractLangIds,
  fenceComposition,
  splitRequest,
} from "../language-router";
import { resolveUpstreams } from "../composition-discovery";
import {
  BUDGET_ERROR_CODE,
  BUDGET_ERROR_MESSAGE,
  budgetSummary,
  createRequestBudget,
  exhausted,
  tripped,
} from "../request-budget";
import { setItemGenerationChars } from "../../pages/api/resolvers";
import { ragLog, generateRequestId } from "../logger";
import { langKey, emitEvent, actor } from "../funnel-events";
import { classifyPromptLanguage, promptLanguageKey } from "../prompt-language";
import { buildRevisionLimitError } from "../free-plan-quota";
import { trialItemRevisionLimit } from "../plans-config";
import { getFirestore } from "../../utils/db";
import { parseCode, postTask } from "../task-api";

type AuthArg = {
  uid: string;
  token: string;
  freePlan?: boolean;
  sessionNamespace?: string;
  sessionUuid?: string;
};

const db = getFirestore();

// Template cache: short TTL, matching the lexicon and unparse-hints caches in lib/api.ts and
// for the same reason — a language deploy must be picked up within minutes. Without one this
// Map held a template for the life of the instance, so the New Item button kept seeding from
// whatever template.gc was current when the instance started, long after the language shipped
// a new one.
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;
const templateCache = new Map<string, { value: string; expires: number }>();

/**
 * Free-plan revision budget.
 *
 * Enforced at the top of generation rather than in updateItem because that's
 * where the money goes: the MCP client generates first and only then writes the
 * resulting taskId back through updateItem, so gating the write would bill the
 * LLM call and refuse it afterwards.
 *
 * A not-yet-written item doc (createItem generates its template before the doc
 * exists) and a first generation (no taskId yet) both read 0 and pass.
 */
async function assertRevisionsRemaining(auth: AuthArg, itemId?: string): Promise<void> {
  if (!auth.freePlan || !itemId) return;
  const limit = trialItemRevisionLimit();
  const snap = await db.doc(`users/${auth.uid}/items/${itemId}`).get();
  if (!snap.exists) return;
  const used = Number(snap.data()?.trialRevisions) || 0;
  if (used >= limit) {
    throw buildRevisionLimitError(limit);
  }
}

export async function generateCodeForRequest({
  auth,
  prompt,
  language,
  options,
  currentSrc,
  // What `currentSrc` COMPILES TO, when the caller has it. Context only — the
  // model edits the source, never this — and the only way it can see values that
  // live outside the program (a set the compiler fetched from a back end). See
  // renderCurrentDataSection in code-generation-service.ts.
  currentData = null,
  conversationSummary = null,
  itemId = undefined,
  // The surface this request came from ("mcp" | "console" | "front"), threaded
  // in solely so funnel events emitted HERE can be attributed. Without it the
  // language gate's event carries no `app`, fails isMcpOrigin in funnel-digest,
  // and silently vanishes from all three report surfaces — which looks exactly
  // like "no non-English traffic". Scripts pass nothing and land as "console",
  // correctly dropping out of the MCP-scoped report.
  client = undefined,
  // Pin the request to `language` and skip GUARDRAIL 1 (the scope gate) for this call only.
  //
  // For REPLAYING A CORPUS PROMPT, not for user traffic. The corpus is generated with the gate
  // off (scripts/create-items-from-prompts.ts sets SCOPE_GATE_ENABLED=false), so its prompts were
  // authored with the language already chosen and never have to justify it — most visibly for a
  // vendor-gated language like L0176, whose prompts do not name Learnosity because nothing made
  // them. Replaying such a prompt with the gate ON is refused every time, which says nothing
  // about whether the language can still generate.
  //
  // A PARAMETER rather than the env var the script uses: that script owns its process, while this
  // runs inside the server, where mutating process.env.SCOPE_GATE_ENABLED would disable the gate
  // for every concurrent user request.
  skipScopeGate = false,
}) {
  const rid = generateRequestId();

  // Per-stage timing. Accumulates (+=) rather than assigns, because the repair
  // loop re-enters codeGenerationService and parseCode — a run that repaired
  // twice should report the total spent generating, not the last attempt.
  //
  // Declared out here, with the outcome trackers, so the `finally` below can
  // emit on EVERY exit: the early returns (revision budget, non-English gate,
  // out-of-scope reject, composition error) are exactly the paths whose cost is
  // otherwise invisible, and the throw path is where a 300s timeout lands.
  const tStart = Date.now();
  const stageMs: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    stageMs[stage] = (stageMs[stage] ?? 0) + (Date.now() - since);
  };
  let composedRun = false;
  // Atomic fallbacks taken: an upstream failed and the head was regenerated
  // standalone. Was `repairs` (head regenerated because the PLANNER pre-committed
  // it to a tail it then failed to bind) — a different event with a different
  // cause, so it gets a different name rather than a quiet reuse.
  let fallbackRuns = 0;

  try {
    if (!language) {
      return { src: null, taskId: null, language, description: null, changeSummary: null, model: null, usage: null, errors: [{ message: "language is required" }], upstreamLangs: [], rid };
    }

    // Free-plan revision budget, checked before any generation spend. Creation
    // is gated separately (assertItemCreateAllowed); this bounds iteration on an
    // item that already exists.
    await assertRevisionsRemaining(auth, itemId);

    prompt = prompt.trim();
    // What every log line in this function must use in place of `language`.
    //
    // `language` is a free-text tool argument, so it is a prompt channel: clients
    // really do send descriptions in it, and the routing/RAG lines below fire on
    // the scope gate — precisely the path a non-language value takes. `language`
    // itself stays raw because the router needs the real value; only the LOGS get
    // the canonical form. Internally-derived ids (routedLang, permits, sequence,
    // headLang) are ours and need no such treatment.
    const langLog = langKey(language);
    let description = null;
    let changeSummary = null;
    let model = null;
    let provider = null;
    let tier = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    // Repair turns the head generation needed to reach a clean compile. Reported
    // by generateCode but dropped here, so callers (the training harness, the
    // analytics) could only infer "did this need fixing?" from token counts.
    let fixAttempts: number | null = null;

    ragLog(rid, "request.start", {
      promptLength: prompt.length,
      // langKey, not the raw value: `language` is a free-text tool argument and
      // clients put prompts in it. Logging promptLength instead of prompt right
      // above and then passing this through verbatim leaked the thing the line
      // above is careful about.
      language: langLog,
      hasCurrentSrc: !!currentSrc,
    });

    let src = null;
    // Build-time state layers added by composition. The head's posted taskId
    // gets these task ids appended with `+` to form the saved chain.
    let upstreamLangs: string[] = [];
    let upstreamTaskIds: string[] = [];
    let headLang = language;

    // Hoisted out of the `if (!src)` block below so the post-parse repair (which lives in
    // the outer scope) can reuse them: codegen options, the usage-limit message mapper, and
    // the head-lang retrieval (reused for the compose trigger, the head gen, and the repair).
    // No model/provider/tier here on purpose: the language's static priority list
    // decides which family serves the request, so there is nothing for a caller to
    // pass. See src/lib/model-priority.ts.
    // `effort` controls how much the model THINKS before answering, and it is the
    // dominant term in generation latency for this workload.
    //
    // claude-sonnet-5 runs adaptive thinking when `thinking` is omitted, which is
    // what codegen has always done — and Anthropic bills thinking inside
    // output_tokens without breaking it out, so it never appeared in our own
    // numbers. A 2026-08-31 L0179 sheet logged 15,278 output tokens over 149s for a
    // program whose source is roughly 4,000 tokens: the rest was invisible
    // reasoning. The spec service measured the same effect from the other side —
    // 42.7s with thinking disabled against 86.3s adaptive.
    //
    // Lowering effort is preferred to disabling thinking outright: it keeps the
    // model on its normal path while cutting the depth. Authoring a spreadsheet
    // from an explicit layout spec is closer to transcription than reasoning, which
    // is the workload shape that loses least at low effort.
    //
    // Env-driven and unset by default, so the current behaviour is unchanged until
    // it is turned on deliberately, and it can be tuned or reverted on a live
    // service without a rebuild.
    const codegenEffort = process.env.CODEGEN_EFFORT || undefined;
    // ONE deadline for the whole request, created here and threaded down.
    //
    // generateLongCode bounds its continuation loop, but it defaults the budget
    // when none is passed — so every caller that starts a fresh generation starts
    // a fresh budget, and those callers MULTIPLY: the repair loop runs up to
    // MAX_FIX_ATTEMPTS (5) generations, and each of those tries up to 2 providers.
    // 5 x 2 fresh 240s budgets is 40 minutes of legal runtime, which is not a
    // bound at all. Creating it once here is what makes the number mean something.
    //
    // 420s leaves headroom under the 900s Cloud Run / Cloud Tasks ceiling for
    // parse, postTask and the item write that follow generation. It is the
    // REQUEST budget; the per-generation budget inside the loop stays smaller.
    const requestDeadlineAt =
      Date.now() +
      (Number(process.env.CODEGEN_REQUEST_BUDGET_MS) > 0
        ? Number(process.env.CODEGEN_REQUEST_BUDGET_MS)
        : 420_000);
    // ONE token budget for the whole request, on exactly the same terms as the
    // deadline above and for the same reason: shared by reference so that every
    // composed stage, repair attempt and provider failover draws on one pool
    // rather than each starting a fresh one. Charged at the provider call
    // (requestProvider), so failed and aborted attempts count too.
    //
    // Sharing by reference is also what makes parallel stages stop together:
    // the instant one trips the budget, every sibling sees it.
    const requestBudget = createRequestBudget(rid);
    /**
     * Publish how much has been WRITTEN, so a waiting caller can tell a large
     * program from a stuck one.
     *
     * A user watching Codex poll render_item saw three identical "still generating"
     * lines and read it as thrashing. Elapsed seconds says the job is alive; this
     * says it is producing. Together they separate the three cases that actually
     * occur here: writing steadily, thinking with nothing emitted yet, and hung —
     * and the middle one is real, an L0179 run today spent 5.5 minutes emitting
     * ZERO characters.
     *
     * Characters, not tokens, because characters are what streams. Anthropic reports
     * output_tokens in `message_delta` at the end of a turn, so a token count cannot
     * tick during one. The MCP server converts at ~4 chars/token and says "~N
     * tokens", which is honest at the precision anyone reads it at.
     *
     * THROTTLED to one write per 2s, skipped when nothing new arrived, and fire and
     * forget. The cost lands on a path this session deliberately shortened, so it is
     * bounded: a 60s generation costs ~30 writes, a 3s one costs one, and a failure
     * to write can never delay or fail the generation.
     */
    const PROGRESS_WRITE_MS = 2_000;
    let lastProgressWrite = 0;
    let lastProgressChars = -1;
    const publishProgress = (writtenChars: number) => {
      if (!itemId || !auth?.uid) return;
      const now = Date.now();
      if (now - lastProgressWrite < PROGRESS_WRITE_MS) return;
      if (writtenChars === lastProgressChars) return;
      lastProgressWrite = now;
      lastProgressChars = writtenChars;
      setItemGenerationChars({ auth: auth as any, id: itemId, chars: writtenChars })
        .catch(() => {});
    };

    const codegenOptions = {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      deadlineAt: requestDeadlineAt,
      budget: requestBudget,
      onOutput: publishProgress,
      ...(codegenEffort ? { effort: codegenEffort } : {}),
    };
    /** Uniform refusal envelope — same shape GUARDRAIL 0 returns. */
    const budgetRefusal = (stage: string) => {
      const blocked = exhausted(requestBudget);
      console.log(
        `[budget] rid=${rid} tripped stage=${stage} ${budgetSummary(requestBudget)} blocked=${blocked}`,
      );
      ragLog(rid, "budget.exhausted", {
        stage,
        on: requestBudget.trippedOn,
        tokens: requestBudget.tokens,
        calls: requestBudget.calls,
        limit: requestBudget.tokenLimit,
        blocked,
      });
      if (!blocked) return null;
      // Only when a user was actually refused. Unlike non_english_request, the
      // shadow-mode signal is the log line above — a wall counter that also
      // counted non-refusals would misreport how often users hit a wall.
      emitEvent("wall_hit", {
        ...actor(auth),
        wall: "request_token_budget",
        lang: langLog,
      });
      return {
        src: null, taskId: null, language, description: null, changeSummary: null,
        model: null, usage: null,
        errors: [{ message: BUDGET_ERROR_MESSAGE, code: BUDGET_ERROR_CODE }],
        upstreamLangs: [], rid,
      };
    };
    const mapUsageLimit = (errs: any[]) => errs.map(err => ({
      ...err,
      message: err.message === 'Usage limit reached'
        ? 'Usage limit reached. Please upgrade your account or add overage units in Settings to continue. Your usage will reset to zero on the next billing cycle.'
        : err.message
    }));
    let headExamples: any[] = [];

    // Template generation
    if (prompt === "Create a minimal starting template") {
      const cacheKey = `L${language}`;
      // When this language is overridden for the caller the fetch is redirected
      // to a test revision, so bypass the shared (lang-keyed) template cache on
      // read and write. Non-overridden languages keep using the shared cache.
      const overridden = await isLangOverridden(language, auth?.token);
      const cached = overridden ? undefined : templateCache.get(cacheKey);
      src = cached && Date.now() < cached.expires ? cached.value : undefined;
      if (!src) {
        src = await getLanguageAsset(`L${language}`, 'template.gc', auth?.token);
        if (src && !overridden) {
          templateCache.set(cacheKey, { value: src, expires: Date.now() + TEMPLATE_CACHE_TTL_MS });
        }
      }
      if (src) {
        description = "Template";
        changeSummary = "Initial code";
        model = "template-file";
      }
    }

    // Code generation — if no template source.
    //
    // Composition cascade:
    //   1. ATOMIC GUARD (free): retrieve head-lang examples once; if none above
    //      threshold authors `data use "<id>"`, the request is atomic — go
    //      straight to single-language code gen, reusing that retrieval.
    //   2. Otherwise PLAN: planSequence() (L0010 planning-RAG hit, else Haiku);
    //      a length>1 sequence runs the tail-first executor.
    if (!src) {
      // GUARDRAIL 0 — is this request even written in English?
      //
      // Ahead of the scope gate because it is free and deterministic where that
      // one is an LLM call, and because a non-English prompt degrades every
      // stage BELOW here silently rather than failing (see prompt-language.ts).
      // Unlike GUARDRAIL 1 this is NOT `!currentSrc`-gated: an update in Russian
      // breaks retrieval exactly as a create does.
      //
      // Fed extractSearchQuery(prompt), never the raw prompt. On the update path
      // the MCP server sends a windowed conversation (buildContextualPrompt), so
      // judging the whole thing would let prior English turns outvote a Russian
      // request. extractSearchQuery isolates the latest turn — which is the very
      // text that gets embedded, so the gate judges what actually breaks.
      const gateMode = process.env.NON_ENGLISH_GATE || "shadow";
      if (gateMode !== "off") {
        const plr = classifyPromptLanguage(extractSearchQuery(prompt, language));
        if (plr.verdict === "non_english") {
          const blocked = gateMode === "enforce";
          console.log(`[routing] rid=${rid} language-gate lang=${langLog} verdict=${plr.verdict} key=${promptLanguageKey(plr)} latinRatio=${plr.latinRatio} blocked=${blocked}`);
          ragLog(rid, "preflight.language", { lang: langLog, script: plr.script, plang: plr.plang, latinRatio: plr.latinRatio, blocked });
          emitEvent("non_english_request", {
            ...actor(auth),
            app: client ?? "console",
            lang: langLog,
            script: plr.script,
            plang: plr.plang,
            blocked,
          });
          if (blocked) {
            // A wall in the taxonomy sense, recorded for consistency with the
            // other seven. It does NOT reach the digest/report/SMS: wall_hit
            // carries no `app`, so isMcpOrigin drops it. non_english_request
            // above is what those surfaces actually read.
            emitEvent("wall_hit", { ...actor(auth), wall: "non_english_request", lang: langLog, script: plr.script });
            const message =
              "Graffiticode does not yet support requests written in languages other than English. " +
              "Please restate the request in English and try again. Text that should appear inside " +
              "the item itself — vocabulary, names, quoted passages — may stay in its original language.";
            return { src: null, taskId: null, language, description: null, changeSummary: null, model: null, usage: null, errors: [{ message }], upstreamLangs: [], rid };
          }
        }
      }

      // GUARDRAIL 1 — authoritative pre-flight head routing. The server validates the request
      // against the chosen language's scope and re-routes to the correct language if the client
      // picked wrong (clients freelance). Fresh creates only — never relabel an edit. Independent
      // of client cooperation and of the generation LLM volunteering OUT_OF_SCOPE.
      if (process.env.SCOPE_GATE_ENABLED !== "false" && !skipScopeGate && !currentSrc) {
        const tRoute = Date.now();
        const route = await classifyAndRoute({ userRequest: prompt, currentLang: language, rid, itemId, auth, budget: requestBudget });
        mark("route", tRoute);
        // Log EVERY decision (in-scope included) so routing is observable — an in-scope verdict
        // is otherwise silent, which masks scope.json contracts that are too permissive.
        // `lang=${langKey(language)}` rather than `lang=L${language}`: this line
        // fires on the scope gate, which is exactly the path a junk `language`
        // reaches, so the raw interpolation printed whole prompts.
        console.log(`[routing] rid=${rid} scope-gate lang=${langLog} inScope=${route.inScope} routedLang=${route.routedLang ? "L" + route.routedLang : "none"}${route.reason ? ` reason=${route.reason}` : ""}`);
        ragLog(rid, "preflight.classify", { lang: langLog, inScope: route.inScope, routedLang: route.routedLang, reason: route.reason });
        if (route.inScope === false) {
          if (route.routedLang && route.routedLang !== language) {
            console.log(`[routing] rid=${rid} preflight.reroute from=${langLog} to=L${route.routedLang} reason=${route.reason}`);
            ragLog(rid, "preflight.reroute", { from: langLog, to: route.routedLang, reason: route.reason });
            language = route.routedLang;
            headLang = route.routedLang;
          } else if (!route.routedLang) {
            const reason = route.reason || `Request is out of scope for L${language}.`;
            console.log(`[routing] rid=${rid} preflight.reject lang=${langLog} reason=${reason}`);
            ragLog(rid, "preflight.reject", { lang: langLog, reason });
            // The demand signal. A refusal is the platform saying "someone wanted
            // something we do not have", and until now it was visible only by
            // grepping raw logs — which is how three of these went unnoticed until
            // the capability happened to get built anyway. Mirrors
            // non_english_request: the named event carries `app` so the MCP-origin
            // surfaces keep it, and the wall_hit below is taxonomy consistency.
            emitEvent("out_of_scope_request", {
              ...actor(auth),
              app: client ?? "console",
              lang: langLog,
            });
            emitEvent("wall_hit", { ...actor(auth), wall: "out_of_scope", lang: langLog });
            // `code` is additive and nothing branches on it today. It exists so a
            // non-human caller can tell "the platform correctly refused an out-of-scope
            // request" apart from "generation broke" without matching on prose — the
            // distinction the daily corpus ping needs (src/lib/corpus-ping.ts), where the
            // former is a stale corpus prompt and the latter is an outage.
            return { src: null, taskId: null, language, description: null, changeSummary: null, model: null, usage: null, errors: [{ message: `This request doesn't fit any available Graffiticode language. ${reason}`, code: "out_of_scope" }], upstreamLangs: [], rid };
          }
        }
      }

      // Head-lang retrieval (for the routed language), reused by the atomic gen and the
      // composition head. Never fail generation if retrieval errors; just treat it as atomic.
      try {
        const tRetrieve = Date.now();
        headExamples = await getRelevantExamples({ prompt, lang: language, rid }) || [];
        mark("retrieve", tRetrieve);
      } catch (err: any) {
        console.warn(`[composition] rid=${rid} head retrieval failed: ${err?.message}`);
      }

      // No pre-flight composition decision. The head generates FIRST, atomically;
      // whether this request composes is read off the program it produced (see the
      // reactive block after parseCode below). Composition is therefore something a
      // language OPTS INTO through its own instructions.md, which is the only place
      // that knows when a request needs an upstream — not something a planner infers
      // from a catalog blurb before a single line of code exists.
      {
        if (tripped(requestBudget)) {
          const refusal = budgetRefusal("atomic");
          if (refusal) return refusal;
        }
        const tGen = Date.now();
        const result = await codeGenerationService({
          auth,
          prompt,
          lang: language,
          options: codegenOptions,
          currentCode: currentSrc,
          currentData,
          rid,
          conversationSummary,
          precomputedExamples: headExamples,
          itemId,
        });
        mark("generate", tGen);

        if ('errors' in result && result.errors) {
          return { src: null, taskId: null, language, description: null, changeSummary: null, model: null, provider: (result as any).provider ?? null, tier: (result as any).tier ?? null, usage: null, errors: mapUsageLimit(result.errors), upstreamLangs: [], rid };
        }

        const successResult = result as {
          code: any;
          taskId: string;
          model: string;
          provider: string;
          tier: string;
          usage: any;
          description: string | null;
          changeSummary: string | null;
          fixAttempts?: number;
        };
        src = successResult.code;
        model = successResult.model;
        provider = successResult.provider;
        tier = successResult.tier;
        usage = successResult.usage;
        description = successResult.description;
        changeSummary = successResult.changeSummary;
        fixAttempts = successResult.fixAttempts ?? null;
      }
    }

    // Parse the head src, then post it. itemId is the one parse-time value; stored
    // user credentials are retired, and external APIs are reached only through a
    // connection (the credential broker).
    const publicValues: Record<string, string> = {};
    if (itemId) publicValues.itemId = itemId;
    // An empty generation is a GENERATOR failure, and must not be reported as a
    // parser one.
    //
    // `src` goes straight into parseCode, and the parser's verdict on an empty
    // program is "End of program reached." That string then becomes the item's
    // generationError and reaches the agent verbatim — where it reads as "your
    // program is malformed" about a program that was never written. On 2026-09-06 a
    // user watched a retirement calculator fail twice with it while the real cause
    // was a turn wall aborting the model before it emitted a character; the message
    // sent them, and me, looking at the wrong layer.
    //
    // Any cause of empty output lands here — a cut turn, a provider failure that
    // returns partial content, a budget refusal at the seam — so the check is on the
    // value rather than on any one of its causes.
    if (!src || String(src).trim() === "") {
      console.log(`[code-gen] rid=${rid} empty generation lang=L${headLang} — no code emitted`);
      ragLog(rid, "generation.empty", { lang: headLang });
      return {
        src: null, taskId: null, language, description, changeSummary, model, provider, tier, usage,
        errors: [{
          message:
            "The generator produced no code for this request. This is a generation " +
            "failure rather than a problem with the request or the item — trying again " +
            "usually succeeds.",
          code: "empty_generation",
        }],
        upstreamLangs: [], rid,
      };
    }
    const tParse = Date.now();
    const parseResult = await parseCode({ lang: headLang, src, publicValues, accessToken: auth?.token });
    mark("parse", tParse);
    if (parseResult.errors) {
      // Preserve the generated source alongside the parse errors so the
      // editor can render it with inline compile-error decorations, matching
      // the user-typed flow.
      return { src, taskId: null, language, description, changeSummary, model, provider, tier, usage, errors: parseResult.errors, upstreamLangs: [] };
    }
    let code = JSON.parse(parseResult.code);

    try {
      // REACTIVE COMPOSITION — the only composition path there is.
      //
      // The head is already generated and parsed. If it authored `data use "<lang>"`,
      // that binding IS the request to compose, and the head's instructions.md is what
      // put it there (L0176's "Pipeline Composition" section is the reference: it tells
      // the generator when a Learnosity `custom` question needs an L0179 spreadsheet
      // behind it, and makes the binding a hard requirement with a finish-time check).
      // `composesWith` says only whether that binding is PERMITTED — it is a fence, not
      // a trigger. A language with no such section never binds and is atomic in practice
      // whatever its allowlist says.
      const resolved = await resolveUpstreams(code);

      // Bindings the item ALREADY had are permitted regardless of the allowlist.
      //
      // Narrowing composesWith retroactively forbids edges that existing items were
      // built on: an L0158+L0166 or L0173+L0170 item still carries `data use` in its
      // source, the model preserves it across an edit, and the fence below would then
      // refuse to save a one-word change to an item that has worked for months.
      // Deprecating an edge must stop NEW ones, never strand live content.
      // extractLangIds reads the source text directly — no second parse.
      const grandfathered = currentSrc ? extractLangIds(currentSrc, true) : [];
      const permits = process.env.COMPOSITION_ENABLED === "false"
        ? []
        : [...composesWithFor(headLang), ...grandfathered];
      if (grandfathered.length > 0) {
        ragLog(rid, "composition.grandfathered", { headLang, langs: grandfathered });
      }
      // One line per run, composing or not, so an atomic outcome is observable rather
      // than merely silent — the same reason the scope gate logs its in-scope verdicts.
      console.log(
        `[composition] rid=${rid} head=${langKey(headLang)} requested=${langLog} ` +
        `permits=[${permits.join(",")}] upstreams=[${resolved.upstreams.join(",")}]`,
      );
      ragLog(rid, "composition.gate", {
        head: langKey(headLang), requested: langLog, permits, upstreams: resolved.upstreams,
      });

      if (resolved.upstreams.length > 0) {
        // resolveUpstreams returns EVERY `data use` in the node pool with no
        // limit, and each one below starts a full generateCode. A model emitting
        // N bindings would otherwise buy N concurrent generations, outside the
        // fence that exists to stop exactly that.
        const proposed = [headLang, ...resolved.upstreams];
        const fenced = fenceComposition(proposed, permits);
        const overDepth = proposed.length > MAX_STAGES;
        if (fenced.dropped.length > 0 || overDepth) {
          console.log(
            `[composition] rid=${rid} headLang=${headLang} refused ` +
            `dropped=${fenced.dropped.join(",") || "none"} depth=${proposed.length}/${MAX_STAGES}`,
          );
          ragLog(rid, "composition.refused", {
            headLang, proposed: resolved.upstreams, dropped: fenced.dropped, overDepth,
          });
          const detail = fenced.dropped.length > 0
            ? `L${headLang} is not permitted to compose with ${fenced.dropped.map((d) => "L" + d).join(", ")}.`
            : `A composition may use at most ${MAX_STAGES} languages; this one proposed ${proposed.length}.`;
          return {
            src: null, taskId: null, language, description: null, changeSummary: null,
            model, provider, tier, usage: null,
            errors: [{ message: `${detail} Try describing the item as a single language, or splitting it into separate items.` }],
            upstreamLangs: [], rid,
          };
        }
        code = resolved.ast;
        upstreamLangs = resolved.upstreams;
        composedRun = true;

        const tCompose = Date.now();
        // An upstream discovered from the head's `data use` would otherwise receive
        // the whole request, host framing and all. The head keeps the original prompt
        // (it is already generated by now); only the upstreams get a scoped share.
        // Fail-open to the original.
        const reactivePrompts = await splitRequest({
          prompt,
          sequence: [headLang, ...upstreamLangs],
          rid,
          itemId,
          auth,
          budget: requestBudget,
        });
        // allSettled, not all: a rejection here used to escape while every
        // sibling kept running, unhandled and uncancellable, spending tokens
        // for a request that had already decided to fail.
        const settled = await Promise.allSettled(
          upstreamLangs.map((uLang, i) =>
            codeGenerationService({
              auth,
              prompt: reactivePrompts?.[i + 1] ?? prompt,
              lang: uLang,
              options: codegenOptions,
              rid,
              itemId,
              // The head is already written: the upstream produces the fields it reads.
              downstreamContext: src ? { lang: headLang, src } : null,
            })
          )
        );
        mark("compose", tCompose);
        // Budget FIRST. After the per-result loop the caller would instead see
        // "Upstream L0179 failed to produce a taskId" — a downstream symptom
        // whose identity depends on which stage happened to trip first.
        if (tripped(requestBudget)) {
          const refusal = budgetRefusal("composition.reactive");
          if (refusal) return refusal;
        }
        const upstreamResults = settled.map((r) =>
          r.status === "fulfilled" ? r.value : { errors: [{ message: String((r as PromiseRejectedResult).reason?.message ?? r.reason) }] },
        );
        const upstreamErrors = upstreamResults.flatMap((r: any, i: number) => {
          if (r && 'errors' in r && r.errors) return r.errors;
          if (!r?.taskId) return [{ message: `Upstream L${upstreamLangs[i]} failed to produce a taskId` }];
          return [];
        });
        if (upstreamErrors.length > 0) {
          // ATOMIC FALLBACK — the head asked for an upstream and could not have it.
          //
          // Returning the upstream's own error here is what produced the 2026-09-09
          // report: a user asked for an interactive bar chart and was told "Out of
          // scope: L0170 is a data-transformation dialect ... it has no charting
          // capabilities" — L0170's OUT_OF_SCOPE sentinel, about a language the user
          // never named, refusing a capability the language they DID name has. The
          // failure of an upstream is not a reason to hand back nothing: the head can
          // almost always author the content inline instead, which is exactly what the
          // user did by hand once the platform gave up.
          //
          // Exactly one retry, and only if the budget allows the spend.
          const upstreamReason = upstreamErrors[0]?.message ?? "";
          console.warn(
            `[composition] rid=${rid} fallback.atomic head=L${headLang} ` +
            `failed_upstreams=[${upstreamLangs.join(",")}]`,
          );
          ragLog(rid, "composition.fallback.atomic", { headLang, upstreamLangs });
          const composedFailure = () => ({
            src: null, taskId: null, language, description: null, changeSummary: null,
            model, provider, tier, usage: null,
            errors: [{
              message:
                `L${headLang} needed an upstream ${upstreamLangs.map((l) => "L" + l).join(", ")} ` +
                `program and it could not be generated${upstreamReason ? ` (${upstreamReason})` : ""}. ` +
                `Try describing the item as a single language, or supplying the data inline.`,
            }],
            upstreamLangs: [], rid,
          });
          if (tripped(requestBudget)) {
            const refusal = budgetRefusal("composition.fallback");
            if (refusal) return refusal;
          }
          fallbackRuns++;
          const tFallback = Date.now();
          const fallback: any = await codeGenerationService({
            auth,
            lang: headLang,
            options: codegenOptions,
            currentCode: currentSrc,
            currentData,
            rid,
            conversationSummary,
            precomputedExamples: headLang === language ? headExamples : null,
            itemId,
            prompt: `${prompt}\n\nIMPORTANT: Author all content for this program INLINE. Do NOT emit \`data use\` — there is no upstream program available to bind, so a binding would render empty.`,
          });
          mark("fallback", tFallback);
          // The fallback's OWN failure is the freshest and most actionable one, and it
          // is about the language the user actually named — so report it rather than
          // composedFailure(), which would bury a usage-limit or a head-language refusal
          // under a story about an upstream. mapUsageLimit for the same reason it wraps
          // every other generation error on this path.
          if (fallback?.errors) {
            return { src: null, taskId: null, language, description: null, changeSummary: null, model, provider, tier, usage: null, errors: mapUsageLimit(fallback.errors), upstreamLangs: [], rid };
          }
          const tReparse = Date.now();
          const reparsed = await parseCode({ lang: headLang, src: fallback.code, publicValues, accessToken: auth?.token });
          mark("parse", tReparse);
          // Parse errors carry the source so the editor can decorate it inline, matching
          // the user-typed flow and the head parse above.
          if (reparsed.errors) {
            return { src: fallback.code, taskId: null, language, description, changeSummary, model, provider, tier, usage, errors: reparsed.errors, upstreamLangs: [] };
          }
          const reparsedCode = JSON.parse(reparsed.code);
          // Still bound ⇒ the head cannot author this content itself, and posting it
          // would render an empty interaction. That is the one case worth failing on.
          if ((await resolveUpstreams(reparsedCode)).upstreams.length > 0) {
            console.warn(`[composition] rid=${rid} fallback.failed head=L${headLang} still bound`);
            ragLog(rid, "composition.fallback.failed", { headLang, upstreamLangs });
            return composedFailure();
          }
          code = reparsedCode;
          src = fallback.code;
          model = fallback.model;
          provider = fallback.provider;
          tier = fallback.tier;
          usage = fallback.usage;
          description = fallback.description ?? description;
          changeSummary = fallback.changeSummary ?? changeSummary;
          upstreamLangs = [];
          upstreamTaskIds = [];
          composedRun = false;
          console.log(`[composition] rid=${rid} fallback.ok head=L${headLang} atomic`);
          ragLog(rid, "composition.fallback.ok", { headLang });
        } else {
          upstreamTaskIds = upstreamResults.map((r: any) => r.taskId as string);
        }
      }
    } catch (err: any) {
      return {
        src: null, taskId: null, language, description: null, changeSummary: null, model, provider, tier, usage: null,
        errors: [{ message: err?.message || "Composition discovery failed", from: -1, to: -1 }],
        upstreamLangs: [],
      };
    }

    const tPost = Date.now();
    const taskData = await postTask({
      auth,
      task: { lang: headLang, code },
      ephemeral: true,
      // Free-plan compiled tasks are owned by a shared service uid, so an
      // auth-less inline render (MCP widget iframe) can't read them. Post them
      // public so /form?id=<taskId> renders by their unguessable taskId.
      isPublic: auth.freePlan === true,
    });
    mark("post", tPost);
    const headTaskId = taskData.id;
    if (!headTaskId) {
      throw new Error("Failed to get taskId");
    }
    const taskId = upstreamTaskIds.length > 0
      ? `${headTaskId}+${upstreamTaskIds.join("+")}`
      : headTaskId;
    console.log(`[composition] rid=${rid} final taskId=${taskId} upstreamLangs=${upstreamLangs.length ? upstreamLangs.join(",") : "none"}`);
    const lexicon = await getLanguageLexicon(headLang, auth?.token);
    const resolvedSrc = unparse(code, lexicon || {});

    ragLog(rid, "request.end", {
      taskId,
      model,
      provider,
      tier,
      usage,
      upstreamLangs,
      success: true,
    });

    // `taskCode` is the AST this function just POSTED as the task (see postTask
    // above, `task: { lang: headLang, code }`) — the head segment's code for a
    // composition, which is exactly the segment updateItem's code refresh keeps.
    // Handing it back lets the caller persist it without a `GET /task` round trip
    // to read back what it already had: 229-369ms measured, 66% of the remaining
    // time between generation finishing and the item reading "ready".
    //
    // Safe because the API returns the AST verbatim. Verified 2026-09-05 by
    // posting a stored AST and re-fetching it, 7/7 byte-identical across L0010,
    // L0166, L0175, L0176, L0177, L0179 and L0180, at 282 to 103,424 chars.
    return { src: resolvedSrc, taskCode: code, taskId, language: headLang, description, changeSummary, model, provider, tier, usage, fixAttempts, errors: null, upstreamLangs, rid };
  } catch (error) {
    console.error("generateCodeForRequest()", "ERROR", error);
    ragLog(rid, "request.error", { error: error.message });
    // Outermost catch: sits outside the scope where model/provider/tier are
    // bound, and a throw this far out may predate generation entirely — so
    // nulls here are the honest answer, not a dropped field.
    return { src: null, taskId: null, language, description: null, changeSummary: null, model: null, provider: null, tier: null, usage: null, errors: [{ message: error.message }], upstreamLangs: [], rid };
  } finally {
    // Best-effort, and deliberately in `finally`: the early returns above (revision
    // budget, non-English gate, out-of-scope reject, composition error) and the
    // caught throw are exactly the runs whose cost is otherwise unrecorded.
    // emitEvent swallows its own errors, so this cannot break a generation.
    //
    // `language` is the function PARAMETER and is reassigned by a preflight
    // reroute, so this reports the language that actually generated — matching
    // the [composition] head= line rather than the caller's original pick.
    emitEvent("item_generation_timing", {
      ...actor(auth),
      lang: langKey(language),
      app: client ?? "console",
      rid,
      total_ms: Date.now() - tStart,
      // Milliseconds per stage. Absent means the stage did not run — an atomic
      // request has no compose_ms, an edit has no route_ms — which is itself the
      // signal: it says which pipeline a run actually took.
      ...Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [`${k}_ms`, v])),
      composed: composedRun,
      fallbacks: fallbackRuns,
    });
  }
}


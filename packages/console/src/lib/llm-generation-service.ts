/**
 * Provider-neutral long-form generation with continuation and one-shot
 * cross-provider failover. A fallback always restarts the full generation so
 * output from different providers is never spliced together.
 */

import axios from "axios";
import OpenAI from "openai";
import {
  GenerationRoute,
  GenerationTier,
  LlmProvider,
  modelForProvider,
  modelRejectsTemperature,
  modelSupportsEffort,
  resolveGenerationRoute,
} from "./llm-models";
import {
  type RequestBudget,
  BUDGET_ERROR_CODE,
  BUDGET_ERROR_MESSAGE,
  budgetSummary,
  charge as chargeBudget,
  estimateTokens,
  exhausted,
} from "./request-budget";

export interface StreamOptions {
  /** Language id — selects the family ordering. Not caller-selectable beyond this. */
  lang?: string | number | null;
  tier?: GenerationTier;
  /** Internal/eval model pin. No GraphQL field maps here — see GenerationRouteInput. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxContinuations?: number;
  thinking?: unknown;
  effort?: string;
  /**
   * Called as visible characters stream in, with the RUNNING TOTAL for this
   * generation. Rides on options because that bag already flows from
   * generate-for-request down to generateLongCode; nothing else does.
   *
   * Characters, not tokens, because characters are the only thing available live:
   * Anthropic reports output_tokens in `message_delta`, which arrives at the END of
   * a turn, so a token count cannot tick during one. The caller converts.
   *
   * Never called from requestAnthropic/requestOpenAI directly — the running total
   * has to span continuation chunks, and only generateLongCode sees those.
   */
  onOutput?: (writtenChars: number) => void;
  /**
   * Per-call timeout. Generation wants the long default (a program can take
   * 60-110s); an observer like the judge wants a much shorter leash, since a
   * hung judge would stall the run it is only scoring. Falls back to
   * CODEGEN_PROVIDER_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /**
   * Wall-clock deadline (epoch ms) for the WHOLE generation, continuation loop
   * included. Created once per request and threaded down, so the repair loop and
   * provider failover can't each start a fresh budget.
   */
  deadlineAt?: number;
  /** Cumulative output-token ceiling across every continuation chunk. */
  maxOutputTokensTotal?: number;
  /**
   * Token ceiling for the WHOLE request, shared by reference across every
   * stage, repair attempt and provider failover — the same one-object-threaded
   * -down shape as `deadlineAt` above, and for the same reason: created once
   * per request so composition cannot start a fresh budget per stage.
   *
   * Charged in `requestProvider` (not in recordTokenUsage, which runs only on
   * success). Callers outside a request pass `unlimitedBudget()`.
   */
  budget?: RequestBudget;
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export type SystemPrompt = string | SystemBlock[];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /**
   * Reasoning tokens, where the provider reports them separately (OpenAI's
   * output_tokens_details.reasoning_tokens; 0 on Anthropic, which does not break
   * thinking out of output_tokens).
   *
   * This is a SUBSET of outputTokens, not an addition to it — OpenAI bills
   * reasoning at the output rate and includes it in output_tokens, so adding it
   * again would double-count. It is tracked only so cost-per-success can be
   * attributed across effort levels; do not fold it into a total.
   */
  reasoningTokens: number;
}

export interface GenerationAttempt {
  provider: LlmProvider;
  model: string;
  success: boolean;
  latencyMs: number;
  status?: number;
  code?: string;
  reason?: string;
  error?: string;
}

interface ProviderRequestResult {
  content: string;
  usage: TokenUsage;
  stopReason?: string;
  failure?: ProviderFailure;
  /**
   * What the turn did before it wrote its first visible character.
   *
   * On Sonnet 5 thinking is on by default and billed inside `output_tokens`, under
   * the same `max_tokens` ceiling as the response — so a turn can spend its entire
   * budget reasoning and emit nothing (`out=<cap> chars=0 stop=max_tokens`). Without
   * these fields that turn is indistinguishable from a stalled stream, which is how
   * it went four incidents unexplained: the fix was argued from the visible/output
   * ratio because nothing measured the phase directly.
   *
   * `msToFirstText` is null when no text block ever opened — the spiral itself.
   * `thinkingChars` is 0 whenever `thinking.display` is "omitted" (the Sonnet 5
   * default, and what we send): the blocks stream with empty text but the tokens are
   * still spent, so presence is the signal, not length.
   */
  reasoning?: {
    sawThinkingBlock: boolean;
    msToFirstText: number | null;
    thinkingChars: number;
  };
}

interface LongGenerationResult {
  content: string;
  usage: TokenUsage;
  chunks: number;
  failure?: ProviderFailure;
  /**
   * Why the continuation loop stopped short, if it did. Absent means the model
   * finished on its own terms.
   *
   * Load-bearing for measurement: without it "we cut a runaway" and "we cut a
   * good run" are the same event, and the caps below can't be tuned.
   */
  stopEarly?: "deadline" | "output_budget" | "restart" | "no_growth" | "request_budget" | "no_output";
  /**
   * The reasoning phase across the run — see ProviderRequestResult.reasoning.
   * `msToFirstText: null` with a non-empty run means every chunk was silent, which
   * is the zero-output spiral and the reason `stopEarly` is "no_output".
   */
  reasoning?: { sawThinkingBlock: boolean; msToFirstText: number | null };
}

interface ClaudeStreamEvent {
  type: "content" | "thinking" | "block" | "usage" | "complete" | "error";
  content?: string;
  /** `block` events: which content block just opened ("thinking" | "text" | ...). */
  blockType?: string;
  stopReason?: string;
  error?: string;
  code?: string;
  usage?: TokenUsage;
}

class ProviderFailure extends Error {
  readonly provider: LlmProvider;
  readonly failoverable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly reason?: string;

  constructor(
    message: string,
    provider: LlmProvider,
    failoverable: boolean,
    status?: number,
    code?: string,
    reason?: string,
  ) {
    super(message);
    this.name = "ProviderFailure";
    this.provider = provider;
    this.failoverable = failoverable;
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

const EMPTY_USAGE = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
});

const providerCircuit = new Map<
  LlmProvider,
  { failures: number; openUntil: number }
>();

function configuredNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerTimeoutMs(): number {
  return configuredNumber("CODEGEN_PROVIDER_TIMEOUT_MS", 180_000);
}

/**
 * How long a live stream may go without delivering a byte before we abort it.
 *
 * This is NOT redundant with `providerTimeoutMs`. Both providers are called with
 * streaming responses, and a stream timeout covers time-to-RESPONSE-HEADERS
 * only: once the first SSE byte arrives, `for await (const chunk of ...)` has no
 * deadline of any kind. A stream that opens and then goes silent hangs until
 * something upstream gives up.
 *
 * That is not hypothetical — three production runs on 2026-08-23/28 ran ~1800s
 * and returned ZERO output tokens, which no token-budget or chunk-count cap can
 * explain or stop. Only aborting the read does.
 *
 * 15s (30s until 2026-10-03): the widest observed healthy inter-chunk gap is far
 * below this (streams deliver continuously at 60-140 tok/s once started), so this can
 * only fire on a genuinely dead stream. Keep-alive pings do not count as data.
 *
 * "ONCE STARTED" is doing all the work in that sentence, and applying the same
 * number BEFORE the first byte was a bug. Extended thinking emits no stream data
 * while it thinks, and claude-sonnet-5 thinks by default — so on a long prescriptive
 * prompt the first token can be well over 30s away and the watchdog aborted a
 * perfectly healthy generation. Measured 2026-09-01 on a 2751-char case: 0/2 runs at
 * 30s (both `outputTokens: 0`), 2/2 first-pass at 120s, nothing else changed.
 */
function streamStallMs(): number {
  return configuredNumber("CODEGEN_STREAM_STALL_MS", 15_000);
}

/**
 * How long to wait for the FIRST byte, which is a different question.
 *
 * This window covers queueing, prompt ingestion and the whole thinking phase, none
 * of which produce stream data. It has to be generous enough for the slowest
 * legitimate request — the ones an agent actually sends, where a short user ask has
 * been expanded into a 2-3KB layout spec — while still bounding the ~1800s
 * zero-token hangs that motivated the watchdog in the first place.
 *
 * Separate from the inter-chunk threshold on purpose: keeping the tight 15s for a
 * stream that has already started is what still catches a genuinely dead stream
 * mid-answer, which a single blunt timeout large enough for thinking would not.
 */
function firstTokenMs(): number {
  return configuredNumber("CODEGEN_FIRST_TOKEN_MS", 180_000);
}

/**
 * The ceiling on how long one provider turn may spend EMITTING.
 *
 * Not on the turn. That distinction is the whole of this comment, and getting it
 * wrong took down generation on 2026-09-06.
 *
 * What this exists for: `streamStallMs` and `firstTokenMs` both measure SILENCE, so
 * a stream delivering steadily at ~100 tok/s trips neither however long it runs. The
 * 567s and 318s L0179 runs were healthy streams with 60,828 and 32,768 tokens to
 * emit, and `options.timeoutMs` cannot bound them — with `responseType: "stream"`
 * axios `timeout` covers only the wait for headers.
 *
 * WHY IT IS ARMED ON THE FIRST CONTENT TOKEN, not at the start of the turn: this
 * shipped as a wall-clock timer from turn start, set to 30s. claude-sonnet-5 thinks
 * before it writes, and on a long prescriptive prompt the first token is well over
 * 30s away — so the timer fired mid-thought, aborted the turn at `chars=0`, and the
 * continuation loop's no-growth guard then failed the whole generation. L0179 and
 * L0173 creates ran 120-145s and produced nothing; a user's Codex session got
 * `generation_failed`. 30s is the exact value `firstTokenMs` had been RAISED from,
 * on 2026-09-01, for this identical reason — the comment on firstTokenMs records the
 * measurement (0/2 runs at 30s, 2/2 at 120s) and it was quoted in the commit that
 * then reintroduced the bug from the other side.
 *
 * So the thinking phase belongs to `firstTokenMs` alone, and this timer starts when
 * the model begins to write. A turn that never writes is already bounded at 180s.
 *
 * 120s of emitting, not 30: at ~100 tok/s that is ~12,000 tokens, where the largest
 * legitimate program measured is ~2,250 (L0179 max codeChars 8,982) — roughly 5x
 * headroom, chosen deliberately wide because the failure mode of "too tight" is
 * silent truncation of real work, and this knob has already caused one incident.
 * The 567s run is still cut to ~120s of emitting.
 */
function turnBudgetMs(): number {
  return configuredNumber("CODEGEN_TURN_BUDGET_MS", 120_000);
}

/**
 * The target every turn is SUPPOSED to meet. Nothing is aborted at this threshold;
 * exceeding it logs one `[codegen-turn] over_soft` line naming the language, the
 * model, and where the tokens went.
 *
 * It is a separate number from the wall on purpose. The wall is what production can
 * survive today; this is the standard, and the gap between them is the backlog. A
 * violation is not a failure to page on — it is a request that spent more than 10s
 * in one provider call, with enough on the line to say why.
 */
function turnSoftMs(): number {
  return configuredNumber("CODEGEN_TURN_SOFT_MS", 10_000);
}

function circuitIsOpen(provider: LlmProvider): boolean {
  const state = providerCircuit.get(provider);
  return !!state && state.openUntil > Date.now();
}

function noteProviderSuccess(provider: LlmProvider): void {
  providerCircuit.delete(provider);
}

function noteProviderFailure(failure: ProviderFailure): void {
  if (!failure.failoverable) return;
  const threshold = configuredNumber("CODEGEN_CIRCUIT_FAILURE_THRESHOLD", 2);
  const cooldownMs = configuredNumber("CODEGEN_CIRCUIT_COOLDOWN_MS", 30_000);
  const current = providerCircuit.get(failure.provider) || {
    failures: 0,
    openUntil: 0,
  };
  const failures = current.failures + 1;
  providerCircuit.set(failure.provider, {
    failures,
    openUntil: failures >= threshold ? Date.now() + cooldownMs : 0,
  });
}

function failoverableProviderError({
  status,
  code,
  message,
}: {
  status?: number;
  code?: string;
  message?: string;
}): boolean {
  const normalized = `${code || ""} ${message || ""}`.toLowerCase();
  // BEFORE the deny list, and deliberately so — this is the one invalid_request that
  // must fail over.
  //
  // A model rejecting a PARAMETER says nothing about the request being wrong; it says
  // this model's surface does not carry that knob. The other family is a different
  // model with a different surface, so the fallback is not a retry of a doomed call —
  // it is the one case where we know the second attempt is materially different.
  //
  // The case that motivated this: `output_config.effort` sent to Haiku 4.5 returned
  // `invalid_request_error: "This model does not support the effort parameter."`, the
  // clause below matched `invalid[_ -]?request` first, and L0176 hard-failed with
  // `openai+balanced` sitting unused in its priority list. modelSupportsEffort now stops
  // that request being built at all; this stops the NEXT one costing a language.
  //
  // Narrow on purpose. Blanket-failing-over every 400 would send over-length prompts and
  // safety refusals to the second provider to fail identically, doubling latency and
  // spend on requests that cannot succeed anywhere.
  if (
    /(does not support|not supported|unsupported|unrecognized)[^.]{0,40}(parameter|field|argument|property|for this model|on this model|with this model)/i.test(
      normalized,
    ) ||
    /(unsupported|unknown|invalid)_(parameter|value)/i.test(normalized)
  ) {
    return true;
  }
  if (
    /(content[_ -]?filter|safety|refusal|context[_ -]?length|too many tokens|invalid[_ -]?request)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /(missing_credentials|timeout|timed out|econnreset|econnrefused|enotfound|network|socket hang up|overloaded|server_error|rate_limit|temporarily_unavailable|model_not_found|invalid_api_key|authentication|permission|insufficient_quota)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

function flattenSystemPrompt(systemPrompt?: SystemPrompt): string | undefined {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    return systemPrompt.map((block) => block.text).join("\n\n");
  }
  return undefined;
}

/**
 * First non-empty line of a block, normalized. Shared by the continuation loop
 * and assembleProgram so "did this chunk restart" has exactly one definition.
 */
function firstCodeLine(value: string): string {
  return (value.split("\n").find((line) => line.trim()) || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One chunk re-opening the program the previous one began. */
function isRestartLine(first: string, next: string): boolean {
  return (
    first.length >= 8 &&
    next.length >= 8 &&
    (first.startsWith(next) || next.startsWith(first))
  );
}

/**
 * Whether the accumulated content ends in Graffiticode's `..` terminator.
 *
 * Checks the LAST FENCED BLOCK, and falls back to the raw tail when fence
 * parsing yields nothing usable. The subtlety: this runs over the CONCATENATION
 * of every continuation chunk, and a model asked to "continue" routinely re-opens
 * its own ``` fence. That opener then parses as the previous block's CLOSER,
 * every later block mis-segments, and the final block is a fragment that cannot
 * end in `..` no matter what the model wrote. `needsContinuation` would then loop
 * to the cap on a program that finished — consistent with 89,486 output tokens
 * for a program worth a few thousand.
 *
 * Checking the trimmed tail of the whole content as a fallback is immune to fence
 * mis-segmentation: if the last thing the model emitted is `..`, it terminated.
 */
function programIsTerminated(content: string): boolean {
  // Strip trailing whitespace and any closing fence, then ask whether the last
  // thing the model actually wrote was the terminator. Immune to fence
  // mis-segmentation, because it never needs to know where blocks begin.
  const tail = content
    .replace(/\s*```[\w]*\s*$/, "")
    .trimEnd();
  if (tail.endsWith("..")) return true;
  // Original behavior, kept as the fallback for content that ends in prose after
  // the program. Deliberately the LAST block only, not any block: `..` can occur
  // inside a program's data, so an early match is not proof of termination.
  const blocks = extractCodeBlocks(content);
  const lastBlock = blocks.length ? blocks[blocks.length - 1] : content;
  return lastBlock.trimEnd().endsWith("..");
}

function needsContinuation(content: string, stopReason?: string): boolean {
  if (stopReason) {
    // "turn_budget" is the wall in turnBudgetMs() cutting a healthy stream. It means
    // the same thing max_tokens does — the model stopped because it ran out of room,
    // not because the program was finished — so it continues on the same terms. The
    // termination check still applies: a turn cut just after the final `..` is done.
    return (
      (stopReason === "max_tokens" || stopReason === "turn_budget") &&
      !programIsTerminated(content)
    );
  }
  const fenceCount = (content.match(/```/g) || []).length;
  return (
    fenceCount % 2 !== 0 ||
    (fenceCount > 0 && !programIsTerminated(content))
  );
}

class ClaudeStreamParser {
  private buffer = "";

  parseChunk(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const events: ClaudeStreamEvent[] = [];
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") {
        events.push({ type: "complete" });
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "content_block_start") {
          // The one event that distinguishes "thinking" from "hung". Everything
          // below streams inside a block; until 2026-09-10 nothing read this, so a
          // turn that spent its whole budget reasoning was indistinguishable from a
          // dead stream — see the reasoning fields on ProviderRequestResult.
          events.push({
            type: "block",
            blockType: parsed.content_block?.type || "",
          });
        } else if (parsed.type === "content_block_delta") {
          // Branch on the DELTA type. `thinking_delta` carries its payload on
          // `delta.thinking` and `signature_delta` on `delta.signature`; reading
          // `delta.text` off all three yielded "" for the thinking phase, which the
          // consumer then dropped as empty content. That is why a spiral logged
          // `chars=0` with no other trace: not a bug in what was collected, but a
          // whole phase of the turn that nothing could see.
          const delta = parsed.delta || {};
          if (delta.type === "thinking_delta") {
            events.push({ type: "thinking", content: delta.thinking || "" });
          } else if (delta.type === "text_delta" || typeof delta.text === "string") {
            events.push({ type: "content", content: delta.text || "" });
          }
        } else if (parsed.type === "message_start" && parsed.message?.usage) {
          const usage = parsed.message.usage;
          events.push({
            type: "usage",
            usage: {
              inputTokens: usage.input_tokens || 0,
              outputTokens: 0,
              cacheCreationInputTokens:
                usage.cache_creation_input_tokens || 0,
              cacheReadInputTokens: usage.cache_read_input_tokens || 0,
              // Anthropic bills thinking inside output_tokens and does not break
              // it out, so there is nothing to attribute here.
              reasoningTokens: 0,
            },
          });
        } else if (parsed.type === "message_delta") {
          if (parsed.usage) {
            events.push({
              type: "usage",
              usage: {
                inputTokens: 0,
                outputTokens: parsed.usage.output_tokens || 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                reasoningTokens: 0,
              },
            });
          }
          if (parsed.delta?.stop_reason) {
            events.push({
              type: "complete",
              stopReason: parsed.delta.stop_reason,
            });
          }
        } else if (parsed.type === "error") {
          events.push({
            type: "error",
            error: parsed.error?.message || "Unknown Anthropic stream error",
            code: parsed.error?.type,
          });
        }
      } catch {
        console.warn("[llm-generation] Ignoring malformed Anthropic SSE event");
      }
    }
    return events;
  }
}

async function readAxiosErrorBody(data: unknown): Promise<string> {
  try {
    if (
      data &&
      typeof (data as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] === "function"
    ) {
      let body = "";
      for await (const chunk of data as AsyncIterable<Buffer | string>) {
        body += chunk.toString();
      }
      return body;
    }
    if (typeof data === "string") return data;
    return data ? JSON.stringify(data) : "";
  } catch {
    return "";
  }
}

async function requestAnthropic({
  model,
  systemPrompt,
  messages,
  options,
  onChunk,
}: {
  model: string;
  systemPrompt?: SystemPrompt;
  messages: Array<{ role: string; content: string }>;
  options: StreamOptions;
  onChunk?: (chunk: string) => void;
}): Promise<ProviderRequestResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      content: "",
      usage: EMPTY_USAGE(),
      failure: new ProviderFailure(
        "ANTHROPIC_API_KEY is not configured",
        "anthropic",
        true,
        undefined,
        "missing_credentials",
        "missing_credentials",
      ),
    };
  }

  const usage = EMPTY_USAGE();
  let content = "";
  let stopReason: string | undefined;
  // Aborts the stream read itself. `timeout` below cannot: with
  // responseType:"stream" it bounds only the wait for headers. See streamStallMs().
  const controller = new AbortController();
  let stalled = false;
  let watchdog: NodeJS.Timeout | undefined;
  // Two thresholds, not one: the generous window applies until the first CONTENT
  // token, the tight one between content chunks thereafter. Keyed on content and
  // not on raw stream activity — the SSE stream sends message_start and
  // thinking-block events immediately, so "some bytes arrived" goes true long
  // before the model has written anything and put the tight threshold back in
  // front of the thinking phase. Measured: keying on raw chunks still failed 0/2
  // with "between chunks". See firstTokenMs().
  let sawData = false;
  // Reasoning-phase telemetry — see ProviderRequestResult.reasoning. `startedAt` is
  // the send, not the first byte, so msToFirstText covers queueing and the whole
  // thinking phase: the interval the spiral lives in.
  const startedAt = Date.now();
  let sawThinkingBlock = false;
  let thinkingChars = 0;
  let msToFirstText: number | null = null;
  const reasoningSnapshot = () => ({ sawThinkingBlock, msToFirstText, thinkingChars });
  // The emit wall. Armed by the FIRST CONTENT TOKEN and never re-armed — unlike
  // armWatchdog, which measures silence and resets on every event. Before that first
  // token the turn is thinking, and thinking is firstTokenMs's business, not this
  // timer's. Arming at turn start is what broke generation on 2026-09-06; see
  // turnBudgetMs().
  let overran = false;
  let turnStartedAt = 0;
  let turnTimer: NodeJS.Timeout | undefined;
  const armTurnWall = () => {
    if (turnTimer) return;
    turnStartedAt = Date.now();
    turnTimer = setTimeout(() => {
      overran = true;
      controller.abort();
    }, turnBudgetMs());
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, sawData ? streamStallMs() : firstTokenMs());
  };
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model,
        system: systemPrompt,
        messages,
        max_tokens: options.maxTokens || 4096,
        ...(modelRejectsTemperature(model)
          ? {}
          : { temperature: options.temperature ?? 0.2 }),
        ...(options.thinking !== undefined
          ? { thinking: options.thinking }
          : {}),
        // Gated on the MODEL, exactly like temperature three lines up: Haiku 4.5
        // (ANTHROPIC_MODELS.FAST) 400s on `output_config.effort`, so a global
        // CODEGEN_EFFORT would otherwise take down every language routed to the
        // fast tier. See modelSupportsEffort.
        ...(options.effort !== undefined && modelSupportsEffort(model)
          ? { output_config: { effort: options.effort } }
          : {}),
        stream: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        responseType: "stream",
        timeout: options.timeoutMs || providerTimeoutMs(),
        signal: controller.signal,
      },
    );

    const parser = new ClaudeStreamParser();
    armWatchdog();
    for await (const chunk of response.data) {
      const events = parser.parseChunk(chunk.toString());
      // Re-armed only by a chunk that carries an event, never by a bare one. Anthropic sends
      // `ping` events to keep an idle stream open, and they parse to nothing: re-arming on
      // every chunk let a stream that had written its whole program in 747ms and then never
      // closed hold the turn for 114s (L0185 corpus, 2026-10-03) — the pings kept resetting
      // a watchdog that was meant to measure silence.
      if (events.length) armWatchdog();
      for (const event of events) {
        if (event.type === "content" && event.content) {
          // First written character: the model has stopped thinking and started
          // emitting, so the emit wall starts here and not before.
          armTurnWall();
          if (msToFirstText === null) msToFirstText = Date.now() - startedAt;
          sawData = true;
          content += event.content;
          onChunk?.(event.content);
        } else if (event.type === "block") {
          if (event.blockType === "thinking") sawThinkingBlock = true;
        } else if (event.type === "thinking") {
          // Deliberately NOT added to `content` and NOT counted as sawData: this is
          // the phase firstTokenMs() exists to wait through, and treating it as
          // output would put the tight between-chunks watchdog back in front of it.
          thinkingChars += event.content?.length || 0;
        } else if (event.type === "usage" && event.usage) {
          usage.inputTokens += event.usage.inputTokens;
          usage.outputTokens += event.usage.outputTokens;
          usage.cacheCreationInputTokens +=
            event.usage.cacheCreationInputTokens;
          usage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
          usage.reasoningTokens += event.usage.reasoningTokens;
        } else if (event.type === "complete" && event.stopReason) {
          stopReason = event.stopReason;
        } else if (event.type === "error") {
          const message = event.error || "Anthropic stream failed";
          return {
            content,
            usage,
            reasoning: reasoningSnapshot(),
            failure: new ProviderFailure(
              message,
              "anthropic",
              failoverableProviderError({
                code: event.code,
                message,
              }),
              undefined,
              event.code,
              "stream_error",
            ),
          };
        }
      }
    }
    return { content, usage, stopReason, reasoning: reasoningSnapshot() };
  } catch (error: any) {
    if (overran) {
      // NOT a failure, and deliberately NOT failoverable: the stream was healthy and
      // the request well-formed, so the other provider would emit the same program at
      // the same rate and spend the budget twice. Keep what streamed and hand it back
      // as a seam — `needsContinuation` treats "turn_budget" like "max_tokens", so the
      // continuation loop resumes from here instead of losing the work.
      console.log(
        `[codegen-turn] cut provider=anthropic model=${model} ms=${Date.now() - turnStartedAt} chars=${content.length}`,
      );
      return { content, usage, stopReason: "turn_budget", reasoning: reasoningSnapshot() };
    }
    if (stalled) {
      // Failoverable: the stream died, the request itself was well-formed, and
      // the other provider deserves a turn. Content generated before the stall
      // is returned rather than discarded.
      return {
        content,
        usage,
        reasoning: reasoningSnapshot(),
        failure: new ProviderFailure(
          `Anthropic stream stalled: no data for ${sawData ? streamStallMs() : firstTokenMs()}ms ${sawData ? "between chunks" : "before the first byte"}`,
          "anthropic",
          true,
          undefined,
          "stream_stalled",
          "stream_stalled",
        ),
      };
    }
    const status = error.response?.status as number | undefined;
    const body = await readAxiosErrorBody(error.response?.data);
    const code =
      error.code ||
      (() => {
        try {
          return JSON.parse(body)?.error?.type;
        } catch {
          return undefined;
        }
      })();
    const message = body || error.message || "Anthropic request failed";
    return {
      content,
      usage,
      reasoning: reasoningSnapshot(),
      failure: new ProviderFailure(
        `Anthropic request failed${status ? ` (${status})` : ""}: ${message}`,
        "anthropic",
        failoverableProviderError({ status, code, message }),
        status,
        code,
        "request_error",
      ),
    };
  } finally {
    // Every exit path, or a pending timer keeps the process awake and can abort
    // a controller nobody is reading any more.
    clearTimeout(watchdog);
    clearTimeout(turnTimer);
  }
}

let openAIClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI | undefined {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openAIClient) {
    openAIClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: providerTimeoutMs(),
    });
  }
  return openAIClient;
}

async function requestOpenAI({
  model,
  systemPrompt,
  messages,
  options,
  onChunk,
}: {
  model: string;
  systemPrompt?: SystemPrompt;
  messages: Array<{ role: string; content: string }>;
  options: StreamOptions;
  onChunk?: (chunk: string) => void;
}): Promise<ProviderRequestResult> {
  const client = getOpenAIClient();
  if (!client) {
    return {
      content: "",
      usage: EMPTY_USAGE(),
      failure: new ProviderFailure(
        "OPENAI_API_KEY is not configured",
        "openai",
        true,
        undefined,
        "missing_credentials",
        "missing_credentials",
      ),
    };
  }

  let content = "";
  let response: any;
  let refusal = "";
  let streamError: { message: string; code?: string } | undefined;
  // Same reasoning as the Anthropic path: the SDK timeout does not bound the
  // async iteration over a stream that has already started. See streamStallMs().
  const controller = new AbortController();
  let stalled = false;
  let watchdog: NodeJS.Timeout | undefined;
  // Two thresholds, not one: the generous window applies until the first CONTENT
  // token, the tight one between content chunks thereafter. Keyed on content and
  // not on raw stream activity — the SSE stream sends message_start and
  // thinking-block events immediately, so "some bytes arrived" goes true long
  // before the model has written anything and put the tight threshold back in
  // front of the thinking phase. Measured: keying on raw chunks still failed 0/2
  // with "between chunks". See firstTokenMs().
  let sawData = false;
  // The emit wall. Armed by the FIRST CONTENT TOKEN and never re-armed — unlike
  // armWatchdog, which measures silence and resets on every chunk. Before that first
  // token the turn is thinking, and thinking is firstTokenMs's business, not this
  // timer's. Arming at turn start is what broke generation on 2026-09-06; see
  // turnBudgetMs().
  let overran = false;
  let turnStartedAt = 0;
  let turnTimer: NodeJS.Timeout | undefined;
  const armTurnWall = () => {
    if (turnTimer) return;
    turnStartedAt = Date.now();
    turnTimer = setTimeout(() => {
      overran = true;
      controller.abort();
    }, turnBudgetMs());
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, sawData ? streamStallMs() : firstTokenMs());
  };
  try {
    // The installed SDK predates GPT-5.6 model ids and its expanded reasoning
    // effort union. The request shape is current Responses API, so keep this
    // narrow cast at the version boundary rather than weakening application
    // types.
    const request: any = {
      model,
      instructions: flattenSystemPrompt(systemPrompt),
      input: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
      max_output_tokens: options.maxTokens || 4096,
      stream: true,
      store: false,
      ...(modelRejectsTemperature(model) ||
      options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.effort && modelSupportsEffort(model)
        ? { reasoning: { effort: options.effort } }
        : {}),
    };
    // Per-request timeout override: the client is cached and carries the long
    // generation default, so a short-leash caller (the judge) passes its own here
    // rather than getting the 180s one.
    const stream = await client.responses.create(request, {
      signal: controller.signal,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });

    armWatchdog();
    for await (const event of stream as any) {
      armWatchdog();
      if (event.type === "response.output_text.delta") {
        const delta = event.delta || "";
        // See the Anthropic path: the emit wall starts at the first written character.
        armTurnWall();
        sawData = true;
        content += delta;
        onChunk?.(delta);
      } else if (event.type === "response.refusal.delta") {
        refusal += event.delta || "";
      } else if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        response = event.response;
      } else if (event.type === "error") {
        streamError = {
          message: event.message || "OpenAI stream failed",
          code: event.code || undefined,
        };
      }
    }

    if (streamError) {
      throw Object.assign(new Error(streamError.message), {
        code: streamError.code,
      });
    }
    if (response?.error) {
      throw Object.assign(
        new Error(response.error.message || "OpenAI response failed"),
        { code: response.error.code },
      );
    }
    if (refusal) {
      return {
        content,
        usage: EMPTY_USAGE(),
        failure: new ProviderFailure(
          `OpenAI refused the request: ${refusal}`,
          "openai",
          false,
          undefined,
          "refusal",
          "refusal",
        ),
      };
    }

    const reported = response?.usage;
    const cachedTokens =
      reported?.input_tokens_details?.cached_tokens || 0;
    const cacheWriteTokens =
      reported?.input_tokens_details?.cache_write_tokens ||
      reported?.cache_write_tokens ||
      0;
    const usage: TokenUsage = {
      // OpenAI reports cached input inside input_tokens; normalize to the
      // disjoint convention used by the rest of the application.
      inputTokens: Math.max(
        0,
        (reported?.input_tokens || 0) - cachedTokens - cacheWriteTokens,
      ),
      // Includes reasoning tokens, which OpenAI bills at the output rate. Kept
      // whole so the cost is right; the reasoning share is reported separately
      // below for attribution only.
      outputTokens: reported?.output_tokens || 0,
      cacheCreationInputTokens: cacheWriteTokens,
      cacheReadInputTokens: cachedTokens,
      reasoningTokens:
        reported?.output_tokens_details?.reasoning_tokens || 0,
    };
    const incompleteReason = response?.incomplete_details?.reason;
    if (response?.status === "failed") {
      return {
        content,
        usage,
        failure: new ProviderFailure(
          "OpenAI response failed",
          "openai",
          false,
          undefined,
          response?.error?.code,
          "response_failed",
        ),
      };
    }
    if (
      incompleteReason &&
      incompleteReason !== "max_output_tokens"
    ) {
      const message = `OpenAI response incomplete: ${incompleteReason}`;
      return {
        content,
        usage,
        failure: new ProviderFailure(
          message,
          "openai",
          false,
          undefined,
          incompleteReason,
          "response_incomplete",
        ),
      };
    }
    return {
      content,
      usage,
      stopReason:
        incompleteReason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn",
    };
  } catch (error: any) {
    if (overran) {
      // NOT a failure, and deliberately NOT failoverable: the stream was healthy and
      // the request well-formed, so the other provider would emit the same program at
      // the same rate and spend the budget twice. Keep what streamed and hand it back
      // as a seam — `needsContinuation` treats "turn_budget" like "max_tokens", so the
      // continuation loop resumes from here instead of losing the work.
      console.log(
        `[codegen-turn] cut provider=openai model=${model} ms=${Date.now() - turnStartedAt} chars=${content.length}`,
      );
      // EMPTY_USAGE, matching the stall path above: the Responses stream reports usage
      // only in the terminal `response.completed` event, which a cut turn never sees.
      // The tokens were spent; requestProvider's estimate floor is what keeps the
      // request budget from being blind to them.
      return { content, usage: EMPTY_USAGE(), stopReason: "turn_budget" };
    }
    if (stalled) {
      return {
        content,
        usage: EMPTY_USAGE(),
        failure: new ProviderFailure(
          `OpenAI stream stalled: no data for ${sawData ? streamStallMs() : firstTokenMs()}ms ${sawData ? "between chunks" : "before the first byte"}`,
          "openai",
          true,
          undefined,
          "stream_stalled",
          "stream_stalled",
        ),
      };
    }
    const status = error.status as number | undefined;
    const code = error.code || error.error?.code;
    const message = error.message || "OpenAI request failed";
    return {
      content,
      usage: EMPTY_USAGE(),
      failure: new ProviderFailure(
        `OpenAI request failed${status ? ` (${status})` : ""}: ${message}`,
        "openai",
        failoverableProviderError({ status, code, message }),
        status,
        code,
        "request_error",
      ),
    };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(turnTimer);
  }
}

/**
 * The one chokepoint every streaming provider call passes through — its only
 * callers are `completeOnce` and `generateLongCode`, which between them cover
 * generation, every repair attempt, the L0010 planner's nested codegen and the
 * judge. The request token budget is charged and checked HERE rather than at
 * recordTokenUsage, because this layer sees failures and aborted streams, and
 * those spent real tokens.
 *
 * On breach it returns a synthetic failure instead of dispatching.
 * `failoverable: false` is load-bearing: a failoverable refusal would send
 * generateCodeWithContinuation to the other provider, which trips identically —
 * a wasted round trip and doubled log noise for a decision already made.
 */
async function requestProvider(
  provider: LlmProvider,
  args: Parameters<typeof requestAnthropic>[0],
): Promise<ProviderRequestResult> {
  const budget = args.options?.budget;

  if (!budget && process.env.NODE_ENV !== "production") {
    // Not an error — scripts and the eval harness legitimately run unbudgeted.
    // It is a warning because the options bag is rebuilt field-by-field in
    // code-generation-service, which drops unnamed fields with no type error,
    // and that is exactly how a threaded request-wide bound goes inert.
    console.warn(
      `[budget] unbudgeted provider call provider=${provider} model=${args.model}`,
    );
  }

  if (budget && exhausted(budget)) {
    console.log(
      `[budget] rid=${budget.rid} refused provider=${provider} ${budgetSummary(budget)}`,
    );
    return {
      content: "",
      usage: EMPTY_USAGE(),
      failure: new ProviderFailure(
        BUDGET_ERROR_MESSAGE,
        provider,
        false,
        undefined,
        BUDGET_ERROR_CODE,
        BUDGET_ERROR_CODE,
      ),
    };
  }

  const turnStartedAt = Date.now();
  const result = provider === "openai"
    ? await requestOpenAI(args)
    : await requestAnthropic(args);
  const turnMs = Date.now() - turnStartedAt;

  // The standard, measured at the only place that sees every provider call. Nothing
  // is aborted here — the wall is turnBudgetMs(), inside the stream. This line is the
  // backlog: `chars` against `out` says whether the turn was slow because it wrote a
  // large program or because it spent the budget thinking. Across 7 days of
  // production the visible-to-output ratio is 0.52 in every size band, so the
  // expected answer today is "half of it was thinking" — and that is the thing to
  // fix before this threshold can become the wall.
  if (turnMs > turnSoftMs()) {
    // `think=` is the field that names the failure instead of implying it. A turn
    // that writes nothing reads `chars=0 stop=max_tokens think=never`: the budget
    // went to the reasoning phase and no text block ever opened. Before this,
    // `chars=0` alone could not tell that apart from a stalled stream.
    const r = result.reasoning;
    const think = r
      ? ` think=${r.msToFirstText === null ? "never" : r.msToFirstText + "ms"}` +
        `${r.sawThinkingBlock ? "" : " thinkBlock=no"}`
      : "";
    console.log(
      `[codegen-turn] over_soft rid=${budget?.rid || "-"} provider=${provider} ` +
        `model=${args.model} ms=${turnMs} out=${result.usage.outputTokens} ` +
        `chars=${result.content.length} stop=${result.stopReason || "-"}${think}`,
    );
  }

  if (budget) {
    // Floor the charge at an estimate of what we sent. A failed call reports
    // EMPTY_USAGE() on both OpenAI failure paths and partial usage on the
    // Anthropic stall path, but the input tokens were billed either way —
    // trusting reported usage would leave the accumulator blind to failures,
    // which is the case it exists for.
    const sent =
      estimateTokens(
        typeof args.systemPrompt === "string"
          ? args.systemPrompt
          : args.systemPrompt?.map((b) => b.text).join(""),
      ) +
      args.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    chargeBudget(budget, result.usage, sent);
  }

  return result;
}

/**
 * One provider call, raw text back — no continuation loop, no code-block
 * extraction, no program assembly.
 *
 * This is the seam for provider-neutral callers that are NOT generating a
 * program: the LLM judge, and anything else that wants a single scored/parsed
 * response. Generation should keep using generateCodeWithContinuation, which
 * adds the continuation and assembly this deliberately omits.
 *
 * Returns `{ content, usage, failure }` rather than throwing, matching the
 * adapters — a judge that throws would take down the request it was observing.
 */
export async function completeOnce({
  provider,
  model,
  systemPrompt,
  messages,
  options = {},
}: {
  provider: LlmProvider;
  model: string;
  systemPrompt?: SystemPrompt;
  messages: Array<{ role: string; content: string }>;
  options?: StreamOptions;
}): Promise<{ content: string; usage: TokenUsage; failure?: ProviderFailure }> {
  const result = await requestProvider(provider, {
    model,
    systemPrompt,
    messages,
    options,
  });
  return {
    content: result.content,
    usage: result.usage,
    failure: result.failure,
  };
}

async function generateLongCode({
  provider,
  model,
  prompt,
  systemPrompt,
  messages = [],
  options = {},
  onChunk,
}: {
  provider: LlmProvider;
  model: string;
  prompt?: string;
  systemPrompt?: SystemPrompt;
  messages?: Array<{ role: string; content: string }>;
  options?: StreamOptions;
  onChunk?: (chunk: string) => void;
}): Promise<LongGenerationResult> {
  const maxContinuations = options.maxContinuations || 10;
  const conversationHistory = [...messages];
  const usage = EMPTY_USAGE();
  let fullContent = "";
  let chunks = 0;
  let stopEarly: LongGenerationResult["stopEarly"];
  // Budgets for the WHOLE loop. Each chunk was already bounded (16k tokens,
  // 180s); nothing bounded their product, which is how a run reached 60,828
  // tokens over 9.5 minutes with every individual chunk behaving normally.
  // The EARLIER of this generation's own budget and the request-wide deadline.
  // Not `??`: the request deadline (420s) is longer than the per-generation one
  // (240s), so preferring it would quietly widen the bound this loop exists to
  // enforce. One generation never gets the whole request's budget, and no
  // generation outlives the request either.
  const generationDeadline =
    Date.now() + configuredNumber("CODEGEN_GENERATION_BUDGET_MS", 240_000);
  const deadlineAt = options.deadlineAt
    ? Math.min(options.deadlineAt, generationDeadline)
    : generationDeadline;
  // Cumulative output ceiling across every continuation chunk.
  //
  // MUST stay above one chunk's `max_tokens` (DEFAULT_MAX_TOKENS), or the
  // continuation loop is dead: a chunk that fills its own budget trips the
  // `output_budget` break below before it can continue, so a program too long for
  // one chunk is truncated instead of resumed, silently and with no error.
  //
  // That is not hypothetical. CODEGEN_MAX_OUTPUT_TOKENS_TOTAL=8000 was set on the
  // Cloud Run service on 2026-09-06 00:35Z as an incident brake, below the 16384
  // (later 8192) chunk size. Continuations across the two weeks either side: 46
  // before that revision, 0 after. It has no diff and nothing to typecheck, which
  // is exactly why the floor is asserted here rather than left to the deployment.
  const maxOutputTokensTotal = Math.max(
    options.maxOutputTokensTotal ??
      configuredNumber("CODEGEN_MAX_OUTPUT_TOKENS_TOTAL", 40_000),
    // Room for a continuation, not just the chunk that triggered it. The `|| 4096`
    // matches the send site's own fallback below; DEFAULT_MAX_TOKENS is not imported
    // because code-generation-service imports THIS module, and the cycle is worse
    // than restating the fallback.
    2 * (options.maxTokens || 4096),
  );
  // Spans continuation chunks: a caller watching this wants "how much has been
  // written for my request", not "for this turn".
  let writtenChars = 0;
  let firstChunkLine = "";
  let lowGrowthStreak = 0;
  // Reasoning across the whole run, not one chunk: `no_output` fires on the first
  // chunk that writes nothing, and the question a reader has then is "was it
  // thinking, and for how long".
  let sawThinkingBlock = false;
  let msToFirstText: number | null = null;
  // Whether ANY provider turn reported the phase at all. Only the Anthropic path
  // measures it; without this flag an OpenAI run reports `think=never` — which reads
  // as "spent the whole budget reasoning and wrote nothing", the precise signature this
  // field exists to name. Observed in production on the first ping after deploy:
  // `L0175 model=gpt-5.6-sol codeChars=1677 think=never`. Unmeasured must be ABSENT,
  // not a value; a diagnostic that lies about the other provider is worse than no field.
  let measuredReasoning = false;

  if (prompt) {
    conversationHistory.push({ role: "user", content: prompt });
  }

  while (chunks < maxContinuations) {
    if (Date.now() >= deadlineAt) {
      stopEarly = "deadline";
      break;
    }
    // Breaking here rather than letting requestProvider refuse the next chunk
    // keeps the content assembled so far: a partial program may still compile,
    // where a refusal at the seam below converts the whole run into a failure.
    if (options.budget && exhausted(options.budget)) {
      stopEarly = "request_budget";
      break;
    }
    const result = await requestProvider(provider, {
      model,
      systemPrompt,
      messages: conversationHistory,
      onChunk: options.onOutput
        ? (chunk: string) => {
            writtenChars += chunk.length;
            options.onOutput!(writtenChars);
            onChunk?.(chunk);
          }
        : onChunk,
      options: {
        ...options,
        // Never let the last chunk overrun the budget it is being measured against.
        timeoutMs: Math.max(
          1_000,
          Math.min(
            options.timeoutMs || providerTimeoutMs(),
            deadlineAt - Date.now(),
          ),
        ),
      },
    });
    chunks += 1;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cacheCreationInputTokens +=
      result.usage.cacheCreationInputTokens;
    usage.cacheReadInputTokens += result.usage.cacheReadInputTokens;
    usage.reasoningTokens += result.usage.reasoningTokens;
    if (result.reasoning) measuredReasoning = true;
    if (result.reasoning?.sawThinkingBlock) sawThinkingBlock = true;
    if (msToFirstText === null && result.reasoning?.msToFirstText != null) {
      msToFirstText = result.reasoning.msToFirstText;
    }

    if (result.failure) {
      return {
        content: joinContinuation(fullContent, result.content),
        usage,
        chunks,
        failure: result.failure,
      };
    }

    const grew = result.content.trim().length;
    fullContent = joinContinuation(fullContent, result.content);
    if (!needsContinuation(fullContent, result.stopReason)) break;

    // A chunk that spent its ENTIRE token budget and wrote nothing has not been
    // interrupted mid-program — it never began one, and there is nothing to
    // continue from. Asking it to "continue exactly where you left off" from an
    // empty assistant turn buys another full budget of the same.
    //
    // This is the L0179 runaway in its pure form, seen twice today with identical
    // telemetry (rid 715f0ad5 and bb31ddb8): out=16384 chars=0 stop=max_tokens,
    // twice, then no_growth — 318s and 330s to produce zero characters for a
    // spreadsheet a normal run writes in about 200 tokens.
    //
    // Nothing else catches it. The emit wall arms on the first content token, which
    // never arrives. `firstTokenMs` is 180s and a 16,384-token thinking chunk takes
    // ~164s at the measured rate, so it lands JUST under and the chunk "succeeds".
    // The low-growth streak below needs two chunks by design, which is one chunk too
    // many when the first produced literally nothing.
    if (grew === 0) {
      stopEarly = "no_output";
      break;
    }

    // --- Non-convergence guards -------------------------------------------
    // A chunk that hits max_tokens AND makes no progress will not make progress
    // on the next turn either; continuing just buys another 16k tokens of the
    // same. These are the cheapest signals that distinguish "writing a big
    // program" from "going in circles".
    const line = firstCodeLine(result.content.replace(/^\s*```[\w]*\n?/, ""));
    if (!firstChunkLine) {
      firstChunkLine = line;
    } else if (line && isRestartLine(firstChunkLine, line)) {
      // The model started the program over instead of continuing it. Whatever it
      // produces now replaces what came before, so the earlier chunks were pure
      // cost. Every L0179 program opens with `sheets [`, so this is the common
      // shape for the spreadsheet runaways.
      stopEarly = "restart";
      break;
    }
    if (grew < 200) {
      if (++lowGrowthStreak >= 2) {
        stopEarly = "no_growth";
        break;
      }
    } else {
      lowGrowthStreak = 0;
    }
    if (usage.outputTokens >= maxOutputTokensTotal) {
      stopEarly = "output_budget";
      break;
    }
    if (Date.now() >= deadlineAt) {
      stopEarly = "deadline";
      break;
    }

    console.log(
      `[llm-generation] provider=${provider} continuing chunk ${chunks + 1}/${maxContinuations}`,
    );
    conversationHistory.push({
      role: "assistant",
      content: result.content,
    });
    conversationHistory.push({
      role: "user",
      content: "Continue exactly where you left off. Do not repeat any content.",
    });
  }

  if (stopEarly) {
    console.log(
      `[llm-generation] provider=${provider} stopped early reason=${stopEarly} ` +
        `chunks=${chunks} outputTokens=${usage.outputTokens}` +
        (measuredReasoning
          ? ` think=${msToFirstText === null ? "never" : msToFirstText + "ms"}` +
            `${sawThinkingBlock ? "" : " thinkBlock=no"}`
          : ""),
    );
  }
  return {
    content: fullContent,
    usage,
    chunks,
    stopEarly,
    reasoning: measuredReasoning ? { sawThinkingBlock, msToFirstText } : undefined,
  };
}

/**
 * Append a continuation chunk to the content so far.
 *
 * A chunk cut at max_tokens leaves its code fence open, and a continuation often
 * opens a fresh one. Concatenated as-is, extractCodeBlocks pairs the new opening
 * fence with the old one, the pairing shifts by one, and the continuation's code
 * falls between blocks and is dropped. Observed 2026-09-30 on a large L0179 create
 * (rid 0a7a069d): chunk 2 held the program's end, so the assembled program was
 * chunk 1 alone and failed with "Missing program terminator". So when the content
 * so far has an unclosed fence, a leading fence on the continuation is removed.
 */
export function joinContinuation(content: string, next: string): string {
  const unclosed = ((content.match(/```/g) || []).length % 2) === 1;
  if (!unclosed) return content + next;
  return content + next.replace(/^\s*```[\w-]*[ \t]*\n?/, "");
}

export function extractCodeBlocks(content: string): string[] {
  const codeBlockRegex = /```(?:[\w]*\n|\n)?([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push(match[1].trim());
  }
  if (blocks.length === 0 && content.trim()) {
    blocks.push(content.trim());
  }
  return blocks;
}

function assembleProgram(content: string): string {
  const codeBlocks = extractCodeBlocks(content);
  // Shared with the continuation loop's restart guard — one definition, so the
  // loop cannot decide a chunk restarted while the assembler decides it didn't.
  const firstLine = firstCodeLine;
  const isRestart = isRestartLine;
  let finalCode = "";
  let firstBlockLine = "";

  for (const block of codeBlocks) {
    if (!block.trim()) continue;
    if (
      firstBlockLine &&
      isRestart(firstBlockLine, firstLine(block))
    ) {
      finalCode = "";
    }
    if (!finalCode) firstBlockLine = firstLine(block);
    finalCode += block;
    if (finalCode.trimEnd().endsWith("..")) break;
  }
  return finalCode.trim();
}

export async function generateCodeWithContinuation({
  prompt,
  formattedPrompt,
  lang = "0000",
  currentCode = null,
  options = {},
  onProgress,
}: {
  prompt?: string;
  formattedPrompt?: string;
  lang?: string;
  currentCode?: string | null;
  options?: StreamOptions;
  onProgress?: (message: string) => void;
}): Promise<{
  code: string;
  usage: TokenUsage;
  chunks: number;
  provider: LlmProvider;
  model: string;
  tier: GenerationTier;
  /** Where the family ordering came from — see GenerationRoute.source. */
  routeSource: GenerationRoute["source"];
  /**
   * The effort actually sent, after `route.effort ?? options.effort`.
   *
   * Reported because "is the per-language entry applying?" was unanswerable from
   * production on 2026-09-09: a slow L0179 create could not be told from an
   * unbounded one except by inferring from the visible/output ratio, which moves
   * with the request at least as much as with the setting. Null when neither the
   * table nor CODEGEN_EFFORT had an opinion, which is itself the answer.
   */
  effort?: string | null;
  /** The family ordering this call resolved to, post circuit filtering. */
  priority: LlmProvider[];
  attempts: GenerationAttempt[];
  fallbackReason?: string;
  /** Characters the model emitted in total, before assembly. */
  rawChars?: number;
  /** Set when the continuation loop cut the run short — see LongGenerationResult. */
  stopEarly?: LongGenerationResult["stopEarly"];
  /** The reasoning phase — see LongGenerationResult.reasoning. */
  reasoning?: LongGenerationResult["reasoning"];
  error?: string;
}> {
  let systemPrompt: SystemPrompt;
  let messages: Array<{ role: string; content: string }> = [];

  if (formattedPrompt) {
    try {
      const parsed = JSON.parse(formattedPrompt);
      systemPrompt = parsed.system;
      messages = parsed.messages;
    } catch {
      console.error(
        "[llm-generation] Failed to parse formatted prompt; using it as user content",
      );
      systemPrompt = `You are a programming assistant that translates natural language into code written in Graffiticode dialect L${lang}.

Generate ONLY valid Graffiticode code. Put the code between triple backticks (\`\`\`).
Do not include any explanatory text outside the code blocks unless specifically requested.`;
      messages.push({ role: "user", content: formattedPrompt });
    }
  } else {
    systemPrompt = `You are a programming assistant that translates natural language into code written in Graffiticode dialect L${lang}.

Generate ONLY valid Graffiticode code. Put the code between triple backticks (\`\`\`).
Do not include any explanatory text outside the code blocks unless specifically requested.`;
    if (currentCode && prompt) {
      messages.push({
        role: "user",
        content: `Current code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nModify it to: ${prompt}`,
      });
    } else if (prompt) {
      messages.push({ role: "user", content: prompt });
    }
  }

  const route = resolveGenerationRoute(options);
  let providers = [...route.providers];
  let circuitFallbackReason: string | undefined;
  // Drop families whose circuit is open so an outage doesn't make every request
  // wait for the failing provider first. Never drop the last one — an all-open
  // list must still attempt something and report a real failure rather than
  // returning "no provider available", which tells an operator nothing.
  if (providers.length > 1) {
    const closed = providers.filter(provider => !circuitIsOpen(provider));
    if (closed.length && closed.length < providers.length) {
      circuitFallbackReason = `circuit_open_${providers
        .filter(provider => circuitIsOpen(provider))
        .join("_")}`;
      onProgress?.(
        `Skipping unavailable ${providers
          .filter(provider => circuitIsOpen(provider))
          .join(", ")} provider(s); using ${closed[0]}.`,
      );
      providers = closed;
    }
  }

  onProgress?.("Starting code generation...");
  const attempts: GenerationAttempt[] = [];
  // Usage across EVERY attempt, failed ones included. Returning only the
  // successful attempt's usage under-reported every failover run — the first
  // provider's whole generation vanished from the usage row, even on success —
  // and returning EMPTY_USAGE() on total failure discarded all of it.
  const attemptUsage = EMPTY_USAGE();
  let fallbackReason: string | undefined = circuitFallbackReason;
  let lastFailure: ProviderFailure | undefined;
  let lastProvider = providers[0];
  let lastModel =
    route.model || modelForProvider(lastProvider, route.tierByProvider?.[lastProvider] ?? route.tier);

  // At most one cross-family restart per logical call, however long the priority
  // list is: a request that has already burned a full generation on a dead
  // provider should surface that, not walk the whole list while the caller waits.
  const attemptOrder = providers.slice(0, 2);

  for (const provider of attemptOrder) {
    const model =
      route.model && providers[0] === provider
        ? route.model
        // Per-family tier from the priority table, else the route-wide default. A language
        // can run fast on its primary and balanced on its fallback.
        : modelForProvider(provider, route.tierByProvider?.[provider] ?? route.tier);
    lastProvider = provider;
    lastModel = model;
    const startedAt = Date.now();
    const result = await generateLongCode({
      provider,
      model,
      systemPrompt,
      messages,
      options: {
        ...options,
        maxTokens: options.maxTokens || 4096,
        maxContinuations: options.maxContinuations || 10,
        // Per-language effort beats the global CODEGEN_EFFORT that `options` carries.
        // Resolved here, beside the model, because the two are one decision: effort is
        // meaningless without knowing which model is about to receive it, and a model
        // with no effort dial drops it again at the send site.
        ...(route.effort ? { effort: route.effort } : {}),
      },
    });
    attemptUsage.inputTokens += result.usage.inputTokens;
    attemptUsage.outputTokens += result.usage.outputTokens;
    attemptUsage.cacheCreationInputTokens += result.usage.cacheCreationInputTokens;
    attemptUsage.cacheReadInputTokens += result.usage.cacheReadInputTokens;
    attemptUsage.reasoningTokens += result.usage.reasoningTokens;

    if (!result.failure) {
      noteProviderSuccess(provider);
      attempts.push({
        provider,
        model,
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      onProgress?.(
        `Generation complete with ${provider}. Processed ${result.chunks} chunk(s).`,
      );
      return {
        code: assembleProgram(result.content),
        // Length of everything the model emitted, before assembleProgram picks
        // the surviving program out of it. Paired with the assembled code's
        // length this is the only measurement that separates "the model wrote
        // prose around the code" from "we discarded restarted chunks" — the two
        // are indistinguishable in outputTokens alone.
        rawChars: result.content.length,
        usage: attemptUsage,
        chunks: result.chunks,
        // Why the loop stopped short, if it did. Carried up so the [code-gen]
        // line can distinguish a bounded runaway from a clean finish.
        stopEarly: result.stopEarly,
        // How long the turn thought before writing. The [code-gen] line reports it
        // as `think=`; on Anthropic it is the ONLY view of the reasoning phase,
        // since thinking is folded into output_tokens and broken out nowhere.
        reasoning: result.reasoning,
        provider,
        model,
        // The tier that actually ran, not the route-wide default: with per-family
        // overrides those differ, and reporting the default would log `tier=balanced`
        // while serving haiku — making the log unusable for confirming a deploy.
        tier: route.tierByProvider?.[provider] ?? route.tier,
        routeSource: route.source,
        effort: route.effort ?? options.effort ?? null,
        priority: providers,
        attempts,
        fallbackReason,
      };
    }

    lastFailure = result.failure;
    noteProviderFailure(result.failure);
    attempts.push({
      provider,
      model,
      success: false,
      latencyMs: Date.now() - startedAt,
      status: result.failure.status,
      code: result.failure.code,
      reason: result.failure.reason,
      error: result.failure.message,
    });

    if (!result.failure.failoverable || provider === attemptOrder.at(-1)) {
      break;
    }
    fallbackReason =
      result.failure.code ||
      result.failure.reason ||
      `status_${result.failure.status || "unknown"}`;
    onProgress?.(
      `${provider} is unavailable; restarting generation with the fallback provider.`,
    );
  }

  return {
    code: "",
    // NOT EMPTY_USAGE(): every attempt above spent real tokens, and zeroing them
    // is why a failed generation left no trace in the usage collection at all.
    usage: attemptUsage,
    chunks: 0,
    provider: lastProvider,
    model: lastModel,
    tier: route.tierByProvider?.[lastProvider] ?? route.tier,
    routeSource: route.source,
    effort: route.effort ?? options.effort ?? null,
    priority: providers,
    attempts,
    fallbackReason,
    error: lastFailure?.message || "Code generation failed",
  };
}

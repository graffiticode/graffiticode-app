// Replaying a corpus row the way it was authored — shared by the ping, the sweep and the
// re-baseline, so all three exercise the same thing the corpus stored.
//
// A corpus row can be a CONVERSATION. 72 of L0182's 82 rows are two turns (take a survey, then
// answer it), and the answering turn is generated as an edit that sees what the first turn
// compiled to — the survey's items exist only there. Replaying the joined `prompt` as a single
// create asks the model to answer a survey nobody has shown it, so it fails or (under the current
// instructions) declines to answer, and a sweep reads that as a regression on every run.
import { generateCodeForRequest } from "@graffiticode-app/core/lib/code-generation/generate-for-request";
import { modelPriorityFor } from "@graffiticode-app/core/lib/model-priority";
import { inferProviderFromModel, type LlmProvider } from "@graffiticode-app/core/lib/llm-models";
import { anthropicCredentialsConfigured } from "@graffiticode-app/core/lib/anthropic-auth";
import { fetchTaskData } from "./fetch-task-data";

/**
 * A row's turns, in order. Turns come from `messages` when it carries them, never from splitting
 * `prompt`: a passage-bearing language (L0175) has blank lines inside a SINGLE request, so
 * splitting text would invent turns that were never asked. A row embedded before messages were
 * stored replays as one turn.
 */
export function corpusTurns(row: { messages?: unknown; prompt?: unknown }): string[] {
  const turns = Array.isArray(row.messages)
    ? row.messages
        .filter((m: any) => m?.role === "user" && typeof m?.content === "string")
        .map((m: any) => m.content.trim())
        .filter(Boolean)
    : [];
  if (turns.length > 0) return turns;
  const prompt = String(row.prompt ?? "").trim();
  return prompt ? [prompt] : [];
}

/**
 * Does this taskId actually evaluate, and to what? A 200 is NOT sufficient: /data answers 200
 * with an errors array. The payload comes back too, because a later turn is handed it as
 * `currentData` — for L0182 it is the only place the survey's items exist.
 */
export async function taskCompiles(
  taskId: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{ compiled: boolean; error?: string; data?: unknown }> {
  try {
    const resp = await fetchTaskData(taskId, accessToken, timeoutMs);
    if (resp.status !== 200) return { compiled: false, error: `/data returned ${resp.status}` };
    const obj = ((await resp.json()) as any)?.data;
    const errors = Array.isArray(obj?.errors) ? obj.errors : [];
    if (errors.length > 0) {
      const message = errors
        .map((e: any) => (typeof e === "string" ? e : e?.message || JSON.stringify(e)))
        .join("; ");
      return { compiled: false, error: `Compile error: ${message}` };
    }
    if (obj?.data == null) return { compiled: false, error: "/data returned no compile output" };
    return { compiled: true, data: obj.data };
  } catch (x: any) {
    return { compiled: false, error: `/data fetch failed: ${x?.message || x}` };
  }
}

export interface ReplayResult {
  /** The last turn's generation (src, taskId, model, …) — what the row stores. */
  gen: any;
  /** The model that wrote each turn, in order. */
  models: (string | null)[];
  /** Set when a turn failed; `turn` is 1-based and the message is prefixed with it when multi-turn. */
  failure?: { stage: "generate" | "empty" | "compile"; turn: number; message: string };
}

/**
 * Generate every turn, each a request of its own; a later turn edits the previous one's source
 * and is given what it compiled to. Every turn compiles — the verdict for the last, the next
 * turn's data model for any before it. The SAME itemId on every turn is what makes them turns:
 * L0182 writes it as `session-id`, which brings back the version this taker was shown.
 */
export async function replayConversation(opts: {
  auth: { uid: string; token: string };
  lang: string;
  turns: string[];
  itemId: string;
  timeoutMs: number;
  /** Wraps each generation, e.g. with a timeout carrying a label. */
  wrap?: <T>(p: Promise<T>, label: string) => Promise<T>;
}): Promise<ReplayResult> {
  const { auth, lang, turns, itemId, timeoutMs } = opts;
  const wrap = opts.wrap ?? (<T>(p: Promise<T>) => p);
  const multi = turns.length > 1;
  const models: (string | null)[] = [];
  let gen: any = null;
  let currentSrc: string | null = null;
  let currentData: unknown = null;

  for (let t = 0; t < turns.length; t++) {
    const fail = (stage: "generate" | "empty" | "compile", message: string): ReplayResult => ({
      gen,
      models,
      failure: { stage, turn: t + 1, message: multi ? `turn ${t + 1}: ${message}` : message },
    });

    gen = await wrap(
      generateCodeForRequest({
        auth,
        prompt: turns[t],
        language: lang,
        options: { maxTokens: 4096 },
        currentSrc,
        currentData,
        itemId,
        // Replay the prompt under the regime it was authored in (see corpus-ping.ts PingOutcome).
        skipScopeGate: true,
      }),
      multi ? `generate L${lang} turn ${t + 1}` : `generate L${lang}`,
    );
    models.push(gen?.model || null);

    if (gen?.errors?.length > 0) return fail("generate", String(gen.errors[0]?.message || gen.errors[0]));
    if (!gen?.src || !gen?.taskId) return fail("empty", "generation returned no source or taskId");

    const compile = await taskCompiles(gen.taskId, auth.token, timeoutMs);
    if (!compile.compiled) return fail("compile", compile.error || "did not compile");

    currentSrc = gen.src;
    currentData = compile.data ?? null;
  }
  return { gen, models };
}

/** The provider production tries first for `lang`. */
export function primaryProvider(lang: string): LlmProvider {
  return modelPriorityFor(lang)[0];
}

function providerConfigured(p: LlmProvider): boolean {
  return p === "openai" ? Boolean(process.env.OPENAI_API_KEY) : anthropicCredentialsConfigured();
}

/**
 * Languages whose first-choice provider has no credential here. Generation quietly fails over to
 * the next provider when the first has no key, so a local run without OPENAI_API_KEY measures
 * (and a re-baseline would store) the fallback model instead of production's — it happened on
 * 2026-11-16, when a full L0182 sweep ran entirely on Haiku instead of Luna.
 */
export function unconfiguredPrimaries(langs: string[]): { lang: string; provider: LlmProvider }[] {
  return langs
    .map((lang) => ({ lang, provider: primaryProvider(lang) }))
    .filter(({ provider }) => !providerConfigured(provider));
}

/** True when every turn was written by the language's first-choice provider. */
export function writtenByPrimary(lang: string, models: (string | null)[]): boolean {
  const want = primaryProvider(lang);
  return models.length > 0 && models.every((m) => !!m && inferProviderFromModel(m) === want);
}

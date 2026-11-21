// The agent-facing routing surface the routing eval measures, for the
// installation the run selects (installations plan, "Routing eval").
//
// The installation is loaded FIRST, from PROFILE_DIR exactly as the servers
// load it, and only then are the modules that read it imported: the
// instructions, the tool descriptions, the catalog filter and the catalog
// client all read the installed profile when called, and with PROFILE_DIR set
// and nothing installed they refuse (core/src/profile/current.ts). Without
// PROFILE_DIR the surface is the built-in Graffiticode one, unchanged.
//
// What a profile changes here:
//   - the server instructions (copy mcp.instructions.*) and the inlined
//     catalog, filtered to what the installation offers and advertises;
//   - the list_languages and get_language_info descriptions (copy
//     mcp.tool.<name>.description), as toolsForClient serves them;
//   - the create_item tool, as the installation serves it (the same in
//     built-in and Graffiticode-profile modes);
//   - which languages a case may expect (planCase).
import type Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { Language } from "../src/api.js";
import type { ToolContext } from "../src/tools.js";

export type DiscoveryTool = { name: string; description: string; input_schema: Record<string, unknown> };

export async function loadRoutingSurface(env: NodeJS.ProcessEnv = process.env) {
  const installation = await import("../src/installation.js");
  // No storage: the eval reads the catalog through the console API and never
  // touches Firestore.
  const receipt = installation.loadInstallation(env, { requireStorage: false });
  const tools = await import("../src/tools.js");
  const api = await import("../src/api.js");
  const { isLanguageOffered } = await import("@graffiticode-app/core/lib/languages");

  const served = tools.toolsForClient();
  const discoveryTool = (name: string): DiscoveryTool => {
    const t = served.find((x) => x.name === name);
    if (!t) throw new Error(`${name} isn't a served tool`);
    return { name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Record<string, unknown> };
  };

  return {
    /** The installation receipt, or null for the built-in installation. */
    receipt,
    /** The server instructions, built as server.ts builds them. */
    instructions: (catalog: Language[] | null) => tools.buildServerInstructions(catalog),
    discoveryTools: [discoveryTool("list_languages"), discoveryTool("get_language_info")],
    /** create_item as the installation serves it (description and schema); the eval stubs its handler. */
    createItemTool: discoveryTool("create_item"),
    /** render_item and update_item as served: the survey workflow's tools. Their handlers are stubbed. */
    workflowTools: [discoveryTool("render_item"), discoveryTool("update_item")],
    /** Whether the installation offers a language ("L0180" or "0180"). */
    offered: (id: string) => isLanguageOffered(id.replace(/^L/i, "").padStart(4, "0")),
    handleListLanguages: tools.handleListLanguages,
    handleGetLanguageInfo: tools.handleGetLanguageInfo,
    listCatalog: api.listLanguages,
  };
}

export type RoutingSurface = Awaited<ReturnType<typeof loadRoutingSurface>>;

/** A survey case: the run must render the item, then record a response to it naming these ideas. */
export type ExpectUpdate = { itemId: string; mentions: string[] };
type CaseShape = { expect?: string; expectReachable?: string; expectNot?: string[]; expectUpdate?: ExpectUpdate; followUp?: string };

/**
 * How a case is judged for this installation. A case whose expected new-item language
 * the installation doesn't offer can't be routed there, so it is judged as
 * "not-offered": creating in a language the installation doesn't offer fails
 * (the server refuses it), and so does settling for an offered language the
 * case didn't ask for; asking the user, or declining, passes. Without a
 * profile every case is judged as written.
 */
export function planCase(c: CaseShape, surface: Pick<RoutingSurface, "receipt" | "offered">):
  { kind: "as-written" } | { kind: "not-offered"; language: string } {
  if (!surface.receipt) return { kind: "as-written" };
  // Only NEW items are restricted to what the installation offers; an existing item stays
  // revisable whatever its language (core applies the offer at creation), so a case that
  // updates an existing item is judged as written.
  const wanted = c.expect ?? c.expectReachable;
  if (wanted && !surface.offered(wanted)) return { kind: "not-offered", language: wanted };
  return { kind: "as-written" };
}

/** The language ids inlined in instructions' catalog ("L0180 — …" lines). */
export function inlinedCatalogIds(instructions: string): string[] {
  const at = instructions.indexOf("Catalog (id — what it makes):");
  if (at < 0) return [];
  const section = instructions.slice(at).split("\n\n")[0];
  return [...section.matchAll(/^L(\d{4}) — /gm)].map((m) => `L${m[1]}`);
}

// --- The model loop and its judgment -------------------------------------------------------

/**
 * The text the eval's create_item stub used before it took the served tool. Only for
 * comparing against older runs (--legacy-create-stub): no client is ever sent it.
 */
export const LEGACY_CREATE_ITEM_STUB: DiscoveryTool = {
  name: "create_item",
  description:
    "Create interactive content in a Graffiticode language. Call list_languages() first to " +
    "discover available languages, then pass the language ID here.",
  input_schema: {
    type: "object",
    properties: {
      language: { type: "string", description: "Language ID (e.g., 'L0166')" },
      description: { type: "string", description: "Natural language description of what to create" },
    },
    required: ["language", "description"],
  },
};

// The escape hatch: an agent with no good match should ASK, not force the closest language.
export const ASK_USER_STUB: DiscoveryTool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question. Use this when no available Graffiticode language fits " +
    "the request, instead of forcing the closest match.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

export const MAX_TURNS = 8;

/**
 * What a text-only reply does, judged from the WHOLE reply by a classifier: a question mark
 * can't tell a clarifying question from a quiz written into the chat. `clarify` asks the user
 * for missing information; `decline` says nothing available fits; `content` delivers (part of)
 * what was asked in the chat instead of using a tool; `other` is anything else.
 */
export type ReplyKind = "clarify" | "decline" | "content" | "other";
/** Every piece of text a run wrote, with the classifier's verdict: the run's evidence. */
export type ReplyRecord = { text: string; reply?: ReplyKind };
export type ClassifyReply = (args: { request: string; reply: string }) => Promise<ReplyKind>;

/**
 * How a run ended.
 *   create / update / ask: a decision (update ends the survey workflow);
 *   none: a text-only reply, with its full text and what the classifier made of it;
 *   exhausted: still calling tools when the turn budget ran out, which is never a pass.
 * `afterClarification`: the run clarified first, got the case's fixed reply, then decided.
 * `replies`: all the text the run wrote, alongside tool calls or not, each with its verdict,
 * including a clarification the run continued past; `clarification` records that exchange
 * itself (the question, asked through ask_user or in text, and the follow-up supplied).
 */
/** A clarification the run continued past: what it asked, how, and the fixed answer it got. */
export type Clarification = { via: "ask_user" | "text"; question: string; followUp: string };
type Evidence = { discovery: number; replies: ReplyRecord[]; clarification?: Clarification };
export type Outcome =
  | ({ kind: "create"; language: string; afterClarification?: boolean } & Evidence)
  | ({ kind: "update"; itemId: string; modification: string; rendered: string[] } & Evidence)
  | ({ kind: "ask"; question: string } & Evidence)
  | ({ kind: "none"; text: string; reply?: ReplyKind } & Evidence)
  | ({ kind: "exhausted" } & Evidence);

type Messages = { create(req: Anthropic.MessageCreateParamsNonStreaming): Promise<Pick<Anthropic.Message, "content">> };

const norm = (id: string) => `L${id.replace(/^L/i, "").padStart(4, "0")}`.toUpperCase();

/** A survey item render_item can return: the eval's stand-in for an item the user already has. */
export type FixtureItem = { item_id: string; status: "ready"; language: string; name: string; summary: string };

type RouteSurface = Pick<RoutingSurface, "discoveryTools" | "createItemTool" | "workflowTools" | "handleListLanguages" | "handleGetLanguageInfo">;

/**
 * One run: the model with the installation's served tools. create_item and update_item are
 * stubbed (a call ends the run), render_item answers from `items`, and ask_user lets a model
 * that would ask do so explicitly. With `followUp`, a first reply that clarifies (an ask_user
 * call, or text the classifier calls `clarify`) gets the case's fixed answer and the run goes
 * on; the decision after it is marked `afterClarification`.
 */
export async function routeOnce(
  client: { messages: Messages },
  { prompt, system, model, surface, ctx, legacyCreateStub = false, items = {}, followUp, classifyReply }: {
    prompt: string; system: string; model: string; ctx: ToolContext; legacyCreateStub?: boolean;
    surface: RouteSurface; items?: Record<string, FixtureItem>; followUp?: string; classifyReply?: ClassifyReply;
  },
): Promise<Outcome> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  // Discovery calls before the decision: the latency the inlined catalog exists to avoid.
  let discovery = 0;
  let clarified = false;
  // Items render_item actually returned: a failed render is not a read.
  const rendered: string[] = [];
  const replies: ReplyRecord[] = [];
  let clarification: Clarification | undefined;
  // The evidence every outcome carries.
  const evidence = () => ({ discovery, replies, ...(clarification ? { clarification } : {}) });
  const tools = [
    ...surface.discoveryTools,
    legacyCreateStub ? LEGACY_CREATE_ITEM_STUB : surface.createItemTool,
    ...surface.workflowTools,
    ASK_USER_STUB,
  ] as Anthropic.Tool[];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({ model, max_tokens: 8000, thinking: { type: "adaptive" } as any, system, tools, messages });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    // Every piece of text is classified, beside tool calls too: content written into the chat
    // fails a case however the run goes on.
    let reply: ReplyKind | undefined;
    if (text) {
      reply = classifyReply ? await classifyReply({ request: prompt, reply: text }) : undefined;
      replies.push(reply ? { text, reply } : { text });
    }

    if (calls.length === 0) {
      if (followUp && !clarified && reply === "clarify") {
        clarified = true;
        clarification = { via: "text", question: text, followUp };
        messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
        messages.push({ role: "user", content: followUp });
        continue;
      }
      return { kind: "none", text, reply, ...evidence() };
    }

    // A decision ends the run (an ask with a follow-up gets the fixed answer instead).
    for (const call of calls) {
      const input = call.input as Record<string, unknown>;
      if (call.name === "create_item") {
        return { kind: "create", language: norm(String(input.language ?? "")), ...evidence(), ...(clarified ? { afterClarification: true } : {}) };
      }
      if (call.name === "update_item") {
        return { kind: "update", itemId: String(input.item_id ?? ""), modification: String(input.modification ?? ""), rendered, ...evidence() };
      }
      if (call.name === "ask_user" && !(followUp && !clarified)) {
        return { kind: "ask", question: String(input.question ?? ""), ...evidence() };
      }
    }

    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = call.input as Record<string, unknown>;
      let out: unknown;
      if (call.name === "ask_user") {
        clarified = true;
        clarification = { via: "ask_user", question: String(input.question ?? ""), followUp: followUp! };
        out = followUp;
      } else if (call.name === "render_item") {
        const id = String(input.item_id ?? "");
        if (items[id]) rendered.push(id);
        out = items[id] ?? { error: `Item not found: ${id}` };
      } else {
        discovery += 1;
        try {
          out = call.name === "list_languages"
            ? await surface.handleListLanguages(ctx, input as any)
            : call.name === "get_language_info"
              ? await surface.handleGetLanguageInfo(ctx, input as any)
              : { error: `${call.name} isn't available in this eval` };
        } catch (err) {
          out = { error: String(err) };
        }
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: typeof out === "string" ? out : JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "exhausted", ...evidence() };
}

export type JudgedCase = CaseShape & { prompt: string; why?: string };

const clarifies = (o: Outcome) => o.kind === "ask" || (o.kind === "none" && o.reply === "clarify");
const declines = (o: Outcome) => clarifies(o) || (o.kind === "none" && o.reply === "decline");

/** Whether a run wrote the requested content into the chat, anywhere in it. */
export const wroteContent = (o: Outcome) => o.replies.some((r) => r.reply === "content");

/**
 * Whether a case's runs pass, and the check's label. Two rules hold for every kind of case: an
 * exhausted run fails, and so does a run that wrote content into the chat, with or without tools.
 */
export function judge(c: JudgedCase, plan: ReturnType<typeof planCase>, outcomes: Outcome[]): { ok: boolean; label: string } {
  const result = judgeCase(c, plan, outcomes);
  return { ...result, ok: result.ok && !outcomes.some(wroteContent) };
}

function judgeCase(c: JudgedCase, plan: ReturnType<typeof planCase>, outcomes: Outcome[]): { ok: boolean; label: string } {
  const why = c.why ? ` (${c.why})` : "";
  if (plan.kind === "not-offered") {
    // Routing there is impossible, and settling for another language is the over-routing the
    // instructions forbid: clarifying or declining passes; any create, content or exhaustion fails.
    return { ok: outcomes.every(declines), label: `not-offered ${plan.language}  "${c.prompt}"` };
  }
  if (c.expectUpdate) {
    // Render the referenced survey, then record a response to it naming the chosen ideas.
    const { itemId, mentions } = c.expectUpdate;
    const ok = outcomes.every((o) => o.kind === "update" && o.itemId === itemId && o.rendered.includes(itemId) &&
      mentions.every((m) => o.modification.toLowerCase().includes(m.toLowerCase())));
    return { ok, label: `update ${itemId}  "${c.prompt}"${why}` };
  }
  if (c.followUp && c.expect) {
    // Clarify first, then create from the fixed reply.
    const ok = outcomes.every((o) => o.kind === "create" && o.language === c.expect && o.afterClarification === true);
    return { ok, label: `clarify, then ${c.expect}  "${c.prompt}"${why}` };
  }
  if (c.expect) {
    return { ok: outcomes.every((o) => o.kind === "create" && o.language === c.expect), label: `${c.expect}  "${c.prompt}"` };
  }
  if (c.expectReachable) {
    // Creating in the named language, or clarifying, passes; anything else fails.
    return {
      ok: outcomes.every((o) => (o.kind === "create" && o.language === c.expectReachable) || clarifies(o)),
      label: `${c.expectReachable}  "${c.prompt}"${why}`,
    };
  }
  // Must not land on a gated language, and must decide; clarifying or declining passes.
  return {
    ok: outcomes.every((o) => o.kind !== "exhausted" && !(o.kind === "create" && c.expectNot!.includes(o.language))),
    label: `not-Learnosity  "${c.prompt}"${why}`,
  };
}

/**
 * The reply classifier the eval uses: a small model reads the user's request and the WHOLE
 * text reply and says what the reply does. Structured output, so the verdict is one of the
 * four kinds or the call fails.
 */
export function replyClassifier(client: { messages: { parse: (req: any) => Promise<any> } }, model = "claude-haiku-5-5"): ClassifyReply {
  return async ({ request, reply }) => {
    const res = await client.messages.parse({
      model,
      max_tokens: 1024,
      system:
        "You label the text of an AI assistant's reply to a user's request. The assistant creates " +
        "content with tools; it may also have called tools in this reply, but you see only its " +
        "text. Label what the text does:\n" +
        "- clarify: it asks the user for information it needs before creating what was asked " +
        "(details, content, values, a reference), and does not deliver the content itself.\n" +
        "- decline: it says what was asked can't be done with what is available, possibly suggesting alternatives.\n" +
        "- content: it delivers what was asked (or a draft of it) in the reply itself, with or without questions.\n" +
        "- other: anything else.",
      messages: [{ role: "user", content: `<request>\n${request}\n</request>\n\n<reply>\n${reply}\n</reply>` }],
      output_config: { format: jsonSchemaOutputFormat(REPLY_SCHEMA) },
    });
    // The SDK's schema transform moves `enum` into the description, so the verdict is checked here.
    const kind = (res.parsed_output as { kind?: unknown } | null)?.kind;
    if (!REPLY_KINDS.includes(kind as ReplyKind)) throw new Error(`the reply classifier returned no valid verdict (${JSON.stringify(kind)})`);
    return kind as ReplyKind;
  };
}

const REPLY_KINDS: readonly ReplyKind[] = ["clarify", "decline", "content", "other"];
const REPLY_SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: ["clarify", "decline", "content", "other"] } },
  required: ["kind"],
  additionalProperties: false,
} as const;

/**
 * The verbose evidence for a case's runs: every reply with its verdict, a clarification the run
 * continued past (its question and the follow-up it got), and the ask or update it ended on.
 */
export function evidenceLines(outcomes: Outcome[]): string[] {
  const lines: string[] = [];
  const indent = (t: string) => t.replace(/\n/g, "\n        ");
  outcomes.forEach((o, i) => {
    const run = `        run ${i + 1}`;
    for (const r of o.replies) lines.push(`${run} SAID (${r.reply ?? "unclassified"}): ${indent(r.text)}`);
    if (o.clarification) {
      lines.push(`${run} CLARIFIED (${o.clarification.via}): ${indent(o.clarification.question)}`);
      lines.push(`${run} FOLLOW-UP: ${o.clarification.followUp}`);
    }
    if (o.kind === "ask") lines.push(`${run} ASKED: ${o.question}`);
    if (o.kind === "update") lines.push(`${run} UPDATE ${o.itemId}: ${o.modification}`);
  });
  return lines;
}

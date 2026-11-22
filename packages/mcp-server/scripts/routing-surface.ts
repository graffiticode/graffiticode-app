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
    /** Whether the installation offers a language ("L0180" or "0180"). */
    offered: (id: string) => isLanguageOffered(id.replace(/^L/i, "").padStart(4, "0")),
    handleListLanguages: tools.handleListLanguages,
    handleGetLanguageInfo: tools.handleGetLanguageInfo,
    listCatalog: api.listLanguages,
  };
}

export type RoutingSurface = Awaited<ReturnType<typeof loadRoutingSurface>>;

type CaseShape = { expect?: string; expectReachable?: string; expectNot?: string[] };

/**
 * How a case is judged for this installation. A case whose expected language
 * the installation doesn't offer can't be routed there, so it is judged as
 * "not-offered": creating in a language the installation doesn't offer fails
 * (the server refuses it), and so does settling for an offered language the
 * case didn't ask for; asking the user, or declining, passes. Without a
 * profile every case is judged as written.
 */
export function planCase(c: CaseShape, surface: Pick<RoutingSurface, "receipt" | "offered">):
  { kind: "as-written" } | { kind: "not-offered"; language: string } {
  if (!surface.receipt) return { kind: "as-written" };
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
 * How a run ended. `none`: the model answered in text without calling a routing tool (a
 * decline). `exhausted`: it was still calling discovery tools when the turn budget ran out:
 * no decision at all, which is never a pass.
 */
export type Outcome =
  | { kind: "create"; language: string; discovery: number }
  | { kind: "ask"; question: string; discovery: number }
  | { kind: "none"; text: string; discovery: number }
  | { kind: "exhausted"; discovery: number };

type Messages = { create(req: Anthropic.MessageCreateParamsNonStreaming): Promise<Pick<Anthropic.Message, "content">> };

const norm = (id: string) => `L${id.replace(/^L/i, "").padStart(4, "0")}`.toUpperCase();

/** One routing run: the model with the installation's surface, create_item and ask_user stubbed. */
export async function routeOnce(
  client: { messages: Messages },
  { prompt, system, model, surface, ctx, legacyCreateStub = false }: {
    prompt: string; system: string; model: string; ctx: ToolContext; legacyCreateStub?: boolean;
    surface: Pick<RoutingSurface, "discoveryTools" | "createItemTool" | "handleListLanguages" | "handleGetLanguageInfo">;
  },
): Promise<Outcome> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  // Discovery calls before the decision: the latency the inlined catalog exists to avoid.
  let discovery = 0;
  const tools = [
    ...surface.discoveryTools,
    legacyCreateStub ? LEGACY_CREATE_ITEM_STUB : surface.createItemTool,
    ASK_USER_STUB,
  ] as Anthropic.Tool[];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({ model, max_tokens: 8000, thinking: { type: "adaptive" } as any, system, tools, messages });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) return { kind: "none", text, discovery };
    // A routing decision ends the run.
    for (const call of calls) {
      if (call.name === "create_item") return { kind: "create", language: norm(String((call.input as any).language ?? "")), discovery };
      if (call.name === "ask_user") return { kind: "ask", question: String((call.input as any).question ?? ""), discovery };
    }
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      let out: unknown;
      discovery += 1;
      try {
        out = call.name === "list_languages"
          ? await surface.handleListLanguages(ctx, call.input as any)
          : await surface.handleGetLanguageInfo(ctx, call.input as any);
      } catch (err) {
        out = { error: String(err) };
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "exhausted", discovery };
}

export type JudgedCase = CaseShape & { prompt: string; why?: string };

/** Whether a case's runs pass, and the check's label. An exhausted run fails every mode. */
export function judge(c: JudgedCase, plan: ReturnType<typeof planCase>, outcomes: Outcome[]): { ok: boolean; label: string } {
  const decided = outcomes.every((o) => o.kind !== "exhausted");
  if (plan.kind === "not-offered") {
    // Routing there is impossible, and settling for another language is the over-routing the
    // instructions forbid: asking or declining passes, any create fails.
    return { ok: decided && outcomes.every((o) => o.kind === "ask" || o.kind === "none"), label: `not-offered ${plan.language}  "${c.prompt}"` };
  }
  if (c.expect) {
    return { ok: outcomes.every((o) => o.kind === "create" && o.language === c.expect), label: `${c.expect}  "${c.prompt}"` };
  }
  if (c.expectReachable) {
    // Creating in the named language, or asking, passes; a no-call or an exhausted loop fails.
    return {
      ok: outcomes.every((o) => (o.kind === "create" && o.language === c.expectReachable) || o.kind === "ask"),
      label: `${c.expectReachable}  "${c.prompt}"${c.why ? ` (${c.why})` : ""}`,
    };
  }
  // Must not land on a gated language; asking or declining passes.
  return {
    ok: decided && outcomes.every((o) => !(o.kind === "create" && c.expectNot!.includes(o.language))),
    label: `not-Learnosity  "${c.prompt}"${c.why ? ` (${c.why})` : ""}`,
  };
}

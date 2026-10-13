import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getData,
  getItemWithTask as apiGetItemWithTask,
  getSpec as apiGetSpec,
  startCodeGeneration,
  listLanguages as apiListLanguages,
  getLanguageInfo as apiGetLanguageInfo,
  type AuthContext,
  type Language,
  CONSOLE_URL,
  APP_URL,
  MCP_ENDPOINT,
} from "./api.js";
import { normalizeClientKind } from "./events.js";
import { contentToMarkdown, describeItem, normalizeLang } from "./item-content.js";
import { widgetResourceUris } from "./widget/index.js";

// --- Help Entry Structure (matches console HelpPanel) ---

interface HelpEntry {
  user: string;
  help: { type?: "code"; text: string };
  type: "user";
  timestamp: string;
  taskId?: string;
}

export function parseHelp(helpJson: string | null): HelpEntry[] {
  if (!helpJson) return [];
  try {
    const parsed: unknown = JSON.parse(helpJson);
    return Array.isArray(parsed) ? parsed as HelpEntry[] : [];
  } catch {
    return [];
  }
}

function buildContextualPrompt(
  help: HelpEntry[],
  newMessage: string
): string {
  // If no meaningful history, just return the new message
  if (help.length < 1) return newMessage;

  let context = "Previous conversation:\n\n";
  const limitedHistory = help.slice(-6); // Last 6 messages (3 exchanges)

  for (const item of limitedHistory) {
    context += `User: ${item.user}\n`;
    if (item.taskId) {
      context += `Assistant: [Generated Graffiticode code]\n`;
    }
  }

  // NB: we deliberately do NOT inline the current source here. generateCode()
  // already receives it as the typed `currentSrc` argument, so embedding it in
  // the prompt text is redundant — and on the free-plan path it pushed the
  // prompt past the backend's 2000-char cap, failing every edit of a non-trivial
  // item. Keep the prompt to conversation history + the new request only.
  context += "\nNow, please address this new request:\n";
  return context + newMessage;
}

// --- Server Instructions (sent to agents at connection time) ---

/**
 * Some hosts keep only the first ~2KB of server instructions. Claude Code cuts at
 * 2048 chars ("…Never pick one unless the user actually named th… [truncated]"),
 * and claude.ai Claude also defers our tools behind tool search, so the model
 * sees bare tool names and this head and nothing else. When the catalog sat at
 * the END of 8.4KB of instructions, no Claude host ever saw it: 2026-09-28→10-01,
 * 730 Claude connects listed our tools and made zero tool calls, while
 * openai-mcp, which reads the whole text, made 58 off 93 connects.
 *
 * So the head carries what decides whether Graffiticode gets used at all — what
 * it makes, "use it, don't write it yourself", and the catalog — and must fit
 * INSTRUCTIONS_HEAD_BUDGET. Everything after it is refinement a truncating host
 * can lose without losing the routing.
 */
export const INSTRUCTIONS_HEAD_BUDGET = 2000;

const INSTRUCTIONS_LEAD = `Graffiticode makes interactive content from a plain-English description: quizzes and assessment items, flashcard decks, spreadsheets, charts, surveys, concept webs, and more. When the user asks you to make one of these, make it with Graffiticode rather than writing it out in chat: call create_item(language, description), then render_item(item_id) to show it.`;

const LEAD_WITH_CATALOG = `${INSTRUCTIONS_LEAD} Pick the language from the catalog below and call create_item directly — the platform re-routes a wrong guess.`;

const LEAD_WITHOUT_CATALOG = `${INSTRUCTIONS_LEAD} Call list_languages to find the language first.`;

const INSTRUCTIONS_BODY = `FAST-PATH PATTERNS — minimize your thinking time:

1. PASS-THROUGH: When the user provides explicit content, pass it directly to create_item — no invention needed:
   "Create spreadsheet: Rent 1500, Food 400, Total with SUM" → create_item immediately
   "Quiz: Q1 What is 2+2? A)3 B)4 C)5, correct B" → create_item immediately

2. CLARIFY: When content is vague, ASK the user for specifics rather than inventing:
   "Create an invoice" → Ask: "What line items and amounts?"
   "Make a quiz on fractions" → Ask: "How many questions? What operations?"
   Inventing content takes time and may miss what the user wants.

3. INVENT: Only when the user explicitly delegates creativity:
   "Surprise me with a quiz on photosynthesis" → invent

When the user's request doesn't match another available tool, check whether Graffiticode has a language that fits. If the catalog already names an obvious fit, call create_item(language, description) DIRECTLY — do not call list_languages() or get_language_info() first. Those two calls cost the user roughly fourteen seconds before any work starts, and for a clear request they add nothing: create_item accepts a best guess and the platform re-routes the request if another language fits better.

Call list_languages(search, domain) only when the catalog does not obviously answer the request — to search by keyword, to narrow by domain (e.g. 'assessments', 'sheets', 'diagrams'), or to confirm what exists before telling the user nothing fits. Call get_language_info(language) only when you need detail the catalog line does not give you: supported item types, example prompts, or scope boundaries for a request you are unsure the language covers.

Some languages are gated: they target a specific vendor or platform and carry a \`when_to_use\` note saying so. Never pick one unless the user actually named that vendor or platform — matching item types (multiple-choice, cloze, short text) is never sufficient. If no language fits the request, tell the user what Graffiticode does have and ask, rather than settling for the nearest match.

All requests to create_item and update_item must be natural language descriptions of what to create or change. A language-specific AI backend handles all code generation. Do not attempt to generate Graffiticode DSL code directly.

Write those descriptions in ENGLISH. The generator is English-only and rejects a request written in another language. This constrains the instruction you send, not the content you ask for: text that should appear inside the item — vocabulary, names, quoted passages, a whole passage in another language — may be in any language. So a user writing to you in Russian gets an English description of what to build, with their Russian content carried through verbatim.

get_language_info returns an inline authoring_guide summary, supported_item_types, and example_prompts — these are usually sufficient to compose a good create_item request. For deeper reference (vocabulary cues, scope boundaries, detailed item-type docs) read the user_guide_resource URI via ReadResource.

Division of labor: the generator is the router — it identifies which languages a request needs and composes any pipeline. Your job is to send it the highest-quality description. Item ids are opaque handles. To reuse an existing item's content in a new request (any language), do NOT pass its id or get_item output (src/data) — those are private to that item's own language. Converge the content in its own language first, then call get_spec(item_id) to get a platform-neutral English description, and pass THAT (plus your intent framing) as the create_item description. Never name upstream languages or wire pipelines yourself; describe what you want and let the generator compose.

A survey (L0182) is the one thing you both author and use, and taking it is not optional. After create_item returns a survey — and whenever a user hands you one — call render_item to read its ideas, then call update_item to record YOUR OWN response. A created survey with no response is unfinished work, so there is always an update_item after the create_item.

Answer as a participant: pick the ideas you genuinely prefer, respect the survey's minimum and maximum, and put them in priority order with the most important first. Add one idea of your own that is not already in the set. Name each idea you choose by its EXACT TEXT as render_item showed it — a survey's ideas are fetched when it compiles, so you have not seen their ids, and a guessed position records the wrong ideas without failing. A survey response is never right or wrong; there is nothing to score and no answer to get correct.

Workflow, common case: create_item(language, description) → render_item(item_id) → update_item(item_id, modification) → render_item(item_id) to iterate. Add list_languages / get_language_info at the front ONLY when the catalog is insufficient (see above). render_item is the preferred user-facing retrieval tool: it keeps language-private code and compiled data out of the model transcript while still hydrating supported host widgets. Use get_item only when a caller explicitly needs the raw language-private src/data for programmatic work. To reuse content in a new request: get_spec(item_id) → create_item(language, spec + intent framing).

create_item and update_item start generation and return immediately with status "generating"; normally follow them with render_item(item_id) to retrieve and display the result. render_item and get_item both wait for completion and return status "ready", "failed", or "generating" (call the same retrieval tool again).

When you create a SECOND or later item for the same user, pass the earlier item's id as create_item's continue_from_item_id. Their items then stay together and one sign-in link saves all of them; without it, each item is saved separately.`;

/** The instructions a session gets when no catalog is cached. */
export const SERVER_INSTRUCTIONS = `${LEAD_WITHOUT_CATALOG}\n\n${INSTRUCTIONS_BODY}`;

/**
 * Instructions with the catalog inlined.
 *
 * Discovery used to cost ~14s of a ~45s request: SERVER_INSTRUCTIONS prescribed
 * list_languages -> get_language_info -> create_item, and each pre-flight call
 * costs its own latency PLUS a model turnaround (measured 2.7s and 7.2s). The
 * whole catalog as "id — description" is ~1.3KB / ~330 tokens, so carrying it in
 * the instructions is far cheaper than fetching it, every session, forever.
 *
 * Each language gets its description in the catalog AND any LIMIT sentences pulled
 * out of its routing hint. Both halves are load-bearing and they answer different
 * questions: the description says what a language MAKES, the limits say what it
 * REFUSES. They are printed apart — descriptions in the head, limits at the tail —
 * because only the head survives a truncating host (INSTRUCTIONS_HEAD_BUDGET).
 *
 * Shipping descriptions alone was tried first and regressed immediately. With only
 * "L0180 — Quizzes and assessment items" in front of it, the model routed
 * "Write a cloze fill-in-the-blank item" to L0180 on 3 of 3 runs; it had correctly
 * declined on 3 of 3 before. L0180's "cloze ... not built yet — do not route those
 * here" lives in its routing hint, so cutting hints for size cut exactly the signal
 * that prevents over-routing. Vendor gates survived (they sit in the description),
 * capability limits did not.
 *
 * So we extract only the sentences that constrain — the ones carrying ONLY/NOT/
 * never/EARLY/not built — and cap them, rather than inlining hints whole: those run
 * to 1.4KB each and would dwarf the instructions. get_language_info stays the way to
 * get the full hint when a request genuinely needs that detail.
 *
 * `isDiscoverable` is applied here for the same reason handleListLanguages applies
 * it: instructions must not advertise a language the tool would refuse to return.
 *
 * Falls back to the bare instructions when no catalog is cached, which is why this
 * takes the catalog rather than fetching it — building instructions happens while
 * a session is being created, and that path must never wait on the console.
 */

/**
 * The sentences in a routing hint that RULE THINGS OUT, for the inlined catalog.
 *
 * A hint is mostly a description of capability, which the catalog line already has.
 * What it uniquely carries is the negative half — the vendor gate, and the item
 * types a language does not implement yet. That half is small and it is what keeps
 * a model from routing a cloze request to a choice-only language.
 *
 * Capped because a couple of hints enumerate their limits at length, and the point
 * of inlining is to stay far cheaper than fetching.
 */
function limitSentences(hint?: string | null, maxChars = 400): string {
  if (!hint) return "";
  const kept = hint
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i.test(sentence))
    .map((sentence) => sentence.trim());
  if (kept.length === 0) return "";
  let out = "";
  for (const sentence of kept) {
    if (out.length + sentence.length + 1 > maxChars) break;
    out += (out ? " " : "") + sentence;
  }
  return out;
}

export function buildServerInstructions(catalog?: Language[] | null): string {
  const listed = (catalog ?? []).filter((l) => isDiscoverable(l.id));
  if (listed.length === 0) return SERVER_INSTRUCTIONS;
  // Descriptions in the head, limits at the tail: the limit sentences run to
  // ~1KB and alone would push the catalog past the cut (see
  // INSTRUCTIONS_HEAD_BUDGET). Losing them costs little — the server's scope
  // gate re-routes an over-routed request — while losing the catalog cost every
  // Claude session the reason to call us at all.
  const catalogLines = listed.map((l) => `L${l.id} — ${l.description}`).join("\n");
  const limitLines = listed
    .map((l) => ({ id: l.id, limits: limitSentences(l.routingHint) }))
    .filter((l) => l.limits)
    .map((l) => `L${l.id} — ${l.limits}`)
    .join("\n");
  const head = `${LEAD_WITH_CATALOG}

Catalog (id — what it makes):
${catalogLines}`;
  if (head.length > INSTRUCTIONS_HEAD_BUDGET) {
    console.warn(
      `[instructions] head is ${head.length} chars, over the ${INSTRUCTIONS_HEAD_BUDGET} budget; ` +
        "truncating hosts will lose the end of the catalog — shorten catalog descriptions"
    );
  }
  const tail = limitLines
    ? `\n\nLanguage limits (what each one does NOT do — check before routing):\n${limitLines}`
    : "";
  return `${head}\n\n${INSTRUCTIONS_BODY}${tail}`;
}

// --- Tool Definitions ---

const nullableString = { type: ["string", "null"] } as const;

const generationOutputSchema = {
  type: "object",
  properties: {
    item_id: { type: "string" },
    status: { const: "generating" },
    operation: { enum: ["create", "update"] },
    language: { type: "string" },
    name: nullableString,
    message: { type: "string" },
  },
  required: ["item_id", "status", "operation", "language", "name", "message"],
  additionalProperties: false,
} as const;

const itemStatusProperties = {
  item_id: { type: "string" },
  status: { enum: ["ready", "generating", "failed"] },
  language: { type: "string" },
  name: nullableString,
  message: { type: "string" },
  error: { type: "string" },
  // The chat-facing prose. It is ALSO the tool result's text block, and the
  // duplication is deliberate: clients that honour `outputSchema` (Claude Code,
  // Cowork) render structuredContent and drop the text block, so a summary that
  // lived only there reached those models not at all. Declared here because every
  // one of these schemas is `additionalProperties: false` — an undeclared field is
  // a validation failure, not a silent extra.
  summary: { type: "string" },
  // Live progress for a still-generating item, e.g. "43s, ~2,736 tokens written".
  //
  // A separate FIELD and not only prose inside `summary`, because a widget host
  // renders neither the summary nor the text block — ChatGPT mounts the widget and
  // shows its own card, so on 2026-09-09 a user watching there saw a static
  // "Generating… / Your item is being created." while the counter was working
  // perfectly for terminal clients reading the text. The widget needs something it
  // can display, not prose it would have to parse.
  progress: { type: "string" },
} as const;

const renderItemOutputSchema = {
  type: "object",
  properties: {
    ...itemStatusProperties,
    // The item's links are part of the COMPACT contract, not widget hydration.
    // Widget hosts render the item inline and read these from _meta; every other
    // client (ChatGPT, Codex, programmatic callers) has no widget and no _meta —
    // hydration is stripped for them — so if the link only lived in the prose
    // summary it would be the one thing they need and cannot address as a field.
    // src/data stay out; a URL is not language-private.
    view_url: { type: "string" },
    claim_url: { type: "string" },
    claim_message: { type: "string" },
  },
  required: ["item_id", "status", "language", "name"],
  additionalProperties: false,
} as const;

const rawItemOutputSchema = {
  type: "object",
  properties: {
    ...itemStatusProperties,
    task_id: { type: "string" },
    src: { type: "string" },
    data: {},
    created: { type: "string" },
    updated: { type: "string" },
    view_url: { type: "string" },
    claim_url: { type: "string" },
    claim_message: { type: "string" },
  },
  required: ["item_id", "status", "language", "name"],
  additionalProperties: false,
} as const;

export const createItemTool = {
  name: "create_item",
  description: `Create interactive content in any Graffiticode language. Describe what you want in natural language — a language-specific AI generates the result.

Call list_languages() first to discover available languages, then pass the language ID here. Your closest match is good enough — the platform validates it against the language's scope and re-routes the request if another language fits better. The description should be a natural language request, not code, written in English. Be specific about the content, structure, layout, theme, and any assessment or interaction requirements.

Only the description itself must be English — content you want to appear in the item (vocabulary, names, passages) may be in any language.

To reuse content from an existing item (any language) — e.g. "make this spreadsheet into a Learnosity question" — call get_spec(item_id) and use its returned text as this description, adding only your intent/target framing. Never paste another item's src/data or its id, and do not name upstream languages or wire a pipeline: just describe what you want and let the generator identify the languages and compose.

Generation runs asynchronously: this returns immediately with an item_id and status "generating". Call render_item(item_id) to retrieve and display the result.`,
  inputSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "Language ID (e.g., 'L0180'). Call list_languages() to discover options. A best guess is fine — the platform re-routes the request if another language is a better fit.",
      },
      description: {
        type: "string",
        description: "Natural language description of what to create. Be specific about content, structure, and visual preferences.",
      },
      name: {
        type: "string",
        description: "Optional friendly name for the item",
      },
      continue_from_item_id: {
        type: "string",
        description:
          "Optional. The item_id of an item you created earlier in THIS conversation. Pass it whenever you are making another item for the same user, so all their items stay together and a single sign-in link saves all of them. Omit it only for the user's first item.",
      },
    },
    required: ["language", "description"],
  },
  outputSchema: generationOutputSchema,
  // Annotations locked for the OpenAI submission (a change forces resubmission):
  //  - readOnlyHint: false — it creates an item.
  //  - destructiveHint: false — creation destroys nothing.
  //  - openWorldHint: true — the created item's view_url is publicly viewable
  //    (a logged-out visitor can open the "Open in Graffiticode" link), so this
  //    changes publicly-visible internet state.
  annotations: {
    title: "Create Item",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  // NO widget: create_item returns "generating" and its result can never update to
  // the finished item (that comes from a separate render_item call), so a widget
  // here would leave a stuck "Generating…" card. It shows a text summary instead;
  // render_item is what renders the result.
} as const;

export const updateItemTool = {
  name: "update_item",
  description: `Modify an existing Graffiticode item by describing what to change in natural language.

This replaces the item's current content in place — the previous version cannot be restored through the assistant, so treat each update as an overwrite.

The language is auto-detected from the item. Conversation history is preserved, so you can make incremental changes: "add another concept", "change the theme to dark", "make the header row blue".

Write the modification in English, as with create_item; content destined for the item itself may be in any language.

Like create_item, generation runs asynchronously: this returns immediately with status "generating". Call render_item(item_id) to retrieve and display the updated result.`,
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The item ID from a previous create_item call",
      },
      modification: {
        type: "string",
        description: "Natural language description of what to change",
      },
    },
    required: ["item_id", "modification"],
  },
  outputSchema: generationOutputSchema,
  // Annotations locked for the OpenAI submission (a change forces resubmission):
  //  - readOnlyHint: false — it modifies an item.
  //  - destructiveHint: TRUE — update_item overwrites the current item's src/data in
  //    place. Platform revert exists but is NOT exposed through MCP, and the common
  //    ChatGPT flow is anonymous, so a user cannot PRACTICALLY restore the prior
  //    content through this surface. Marking destructive is the accurate, low-risk
  //    choice (annotation mismatch is a documented rejection reason; a destructive
  //    tool is acceptable, at most adding confirmation friction). Flip to false in a
  //    reviewed update once revert is surfaced via MCP (see post-submission follow-up).
  //  - openWorldHint: true — same public-view_url reasoning as create_item.
  annotations: {
    title: "Update Item",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  // NO widget (same reason as create_item): the "generating" result can't update
  // to the finished item, so render_item renders the result instead.
} as const;

export const getItemTool = {
  name: "get_item",
  description: `Get an existing Graffiticode item by ID.

Returns the item's raw data, code, and metadata for programmatic clients. Prefer render_item for normal user-facing retrieval because it keeps the language-private src/data out of the model transcript while still rendering supported widgets. If generation is still running, this waits for completion and returns status "ready", "generating", or "failed".

The returned src and data are PRIVATE to this item's language — do not pass them to another language's create_item; to move this content to a different language, call get_spec(item_id) instead.`,
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The item ID to retrieve",
      },
    },
    required: ["item_id"],
  },
  outputSchema: rawItemOutputSchema,
  annotations: {
    title: "Get Item",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  // No widget: get_item is for programmatic access to raw src/data.
  // Use render_item for user-facing display with widget rendering.
} as const;

export const renderItemTool = {
  name: "render_item",
  description: `Retrieve and display an existing Graffiticode item by ID.

This is the preferred retrieval tool after create_item or update_item. It waits for generation to complete and returns compact status and identity fields; supported hosts receive the full language-private rendering payload separately as widget metadata, keeping source code, compiled data, and answer keys out of the model transcript.

Use get_item only when the caller explicitly needs raw src/data for programmatic work.`,
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The item ID to retrieve and display",
      },
    },
    required: ["item_id"],
  },
  outputSchema: renderItemOutputSchema,
  annotations: {
    title: "Render Item",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: { "openai/resultCanProduceWidget": true },
} as const;

export const getSpecTool = {
  name: "get_spec",
  description: `Get a precise, platform-neutral English specification of an existing item's content.

Call this FIRST whenever the user gives you a Graffiticode item — its id, or a link such as https://app.graffiticode.org/form/<item_id> (the id is the last path segment) — and asks to reuse, recreate, convert, copy, or turn it into something else. An item id is exactly this tool's input: never tell the user an id is not enough or ask them for a screenshot of the item — fetch its content here.

Use the result to reproduce or wrap the item's content in ANOTHER language: pass the returned spec as the create_item description for the target language. The spec captures every authored detail (questions, options, answer keys, formulas, passages) with no language-specific encoding.

Never pass an item id or get_item output (src/data) to create_item — those are private to the item's own language and another language's generator cannot interpret them. get_spec is the only correct way to move content across languages.`,
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The item's id — as returned by create_item, or the last path segment of a https://app.graffiticode.org/form/<item_id> link",
      },
    },
    required: ["item_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string" },
      language: { type: "string" },
      spec: { type: "string" },
    },
    required: ["item_id", "language", "spec"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get Item Spec",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

export const listLanguagesTool = {
  name: "list_languages",
  description: `Discover available Graffiticode languages. Use this to find a language that matches the user's needs.

The catalog is dynamic and grows over time. Use the search parameter to match by keyword (e.g., "spreadsheet", "flashcard", "chart"), or the domain parameter to narrow to a domain (e.g., "assessments"). Returns language IDs, names, descriptions, domain memberships, and a \`when_to_use\` steering note.

Read \`when_to_use\` before choosing: it states the conditions a language requires and, where one exists, the gate that rules it out. Honor its negative clauses — a language that says "do NOT use for X" must not be chosen for X, however well its question types or item types seem to match. If nothing in the returned set fits the request, say so and ask the user rather than forcing the closest match.`,
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Filter by domain (e.g., 'assessments', 'sheets', 'diagrams'). Omit to see every Graffiticode language. Discover available values from the `domains` field on returned languages. The 'learnosity' domain is vendor-gated — scope to it only when the user names Learnosity (or a Learnosity Item Bank / Items API / Learnosity-integrated LMS).",
      },
      search: {
        type: "string",
        description: "Search by keyword (e.g., 'spreadsheet', 'flashcard', 'chart')",
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      languages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            when_to_use: { type: "string" },
            domains: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "description", "domains"],
          additionalProperties: false,
        },
      },
    },
    required: ["languages"],
    additionalProperties: false,
  },
  annotations: {
    title: "List Languages",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

export const getLanguageInfoTool = {
  name: "get_language_info",
  description: `Get detailed authoring information about a Graffiticode language.

Returns an inline authoring_guide summary, supported_item_types, example_prompts, and a user_guide_resource URI (readable via ReadResource for the full markdown guide). Usually sufficient to compose a good create_item request.

Call this after list_languages() to learn about a specific language before using create_item().`,
  inputSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "Language ID (e.g., 'L0180')",
      },
    },
    required: ["language"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      when_to_use: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
      authoring_guide: nullableString,
      supported_item_types: { type: "array", items: { type: "string" } },
      not_for: { type: "array", items: { type: "string" } },
      example_prompts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            produces: nullableString,
            notes: nullableString,
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      user_guide_resource: { type: "string" },
      spec_url: { type: "string" },
    },
    required: ["id", "name", "description", "domains", "authoring_guide", "supported_item_types", "not_for", "example_prompts", "user_guide_resource", "spec_url"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get Language Info",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

// v1 ships noauth-only for the OpenAI submission: every tool works anonymously via
// the free-plan path, and we are NOT standing up the OAuth connection in the portal
// (the OAuth callback still needs the console-side token-off-URL fix before it is
// review-ready — see docs/openai-submission.md go/no-go gate). Advertising only
// `noauth` keeps the Scan Tools snapshot consistent with what we submit; the `oauth2`
// scheme is added back in the reviewed OAuth update. This is metadata only — the
// OAuth endpoints and API-key path remain functional for the existing Claude
// connector; authenticated requests still work, they're just not advertised here.
export const TOOL_SECURITY_SCHEMES = [
  { type: "noauth" },
] as const;

// Attach the security schemes to every tool descriptor (top-level + _meta mirror),
// preserving any existing _meta (e.g. the widget marker on get_item/render_item).
function withSecuritySchemes(tool: Record<string, unknown>): Record<string, unknown> {
  const meta = (tool._meta as Record<string, unknown>) ?? {};
  return {
    ...tool,
    securitySchemes: TOOL_SECURITY_SCHEMES,
    _meta: { ...meta, securitySchemes: TOOL_SECURITY_SCHEMES },
  };
}

// Export all tools as array (cast to allow _meta + securitySchemes extensions).
export const tools = [
  createItemTool,
  updateItemTool,
  renderItemTool,
  getItemTool,
  getSpecTool,
  listLanguagesTool,
  getLanguageInfoTool,
].map((t) => withSecuritySchemes(t as Record<string, unknown>)) as unknown as Tool[];

/**
 * Whether to serve the native MCP Apps widget to this client.
 *
 * WHITELIST, deliberately — only hosts we've verified render our widget correctly
 * (the Claude family: `claude-ai`, `claude-code`/Cowork, `claude-desktop`). Everyone
 * else — ChatGPT web/desktop/mobile, Codex, and any unknown client — gets NO UI and
 * the compact text + link. We whitelist rather than blacklist OpenAI because we
 * cannot reliably enumerate ChatGPT's client names (the consumer app reports a name
 * our old `/openai|chatgpt|codex/` blacklist missed, so the widget leaked to it and
 * got stuck "Generating…" on web). A whitelist guarantees a clean, consistent no-UI
 * OpenAI experience for submission regardless of what name ChatGPT connects as.
 */
export function isWidgetHost(clientName?: string): boolean {
  return !!clientName && /claude/i.test(clientName);
}

/**
 * Whether to advertise the widget to this client.
 *
 * Two conditions, and BOTH must hold: the client declared
 * `capabilities.extensions["io.modelcontextprotocol/ui"]` during `initialize`, AND
 * its name passes the Claude whitelist.
 *
 * The declaration is the part that was missing. A name whitelist alone (`/claude/i`)
 * misfired in both directions, both observed in one production log window:
 *
 *   host=claude-code v=2.1.219                → matched the name, declares NOTHING
 *   host=local-agent-mode-graffiticode …      → declares the extension, name misses
 *
 * The first was handed a widget it cannot mount, which is what rendered "Unable to
 * reach Graffiticode" on every render_item (it never even fetched the app HTML). The
 * second was refused a widget it can actually render, purely because its client name
 * doesn't contain "claude".
 *
 * Only the FIRST misfire is fixed here, by requiring the declaration on top of the
 * name whitelist. Dropping the name check entirely would fix the second too, but it
 * would let ANY unknown client that declares the extension render the widget —
 * including `web-sandbox`-style names. A false negative (a dev connector getting a
 * text link) is cheap; a false positive is not.
 *
 * OpenAI is now a SECOND, separate route rather than an exclusion. ChatGPT does not
 * declare `io.modelcontextprotocol/ui` — it reads `openai/outputTemplate`, which the
 * Apps SDK documents as a compatibility alias for `_meta.ui.resourceUri` — so the
 * extension test can never admit it and a name match is the only signal available.
 * That is the same shape as the original blacklist which ChatGPT's consumer app
 * slipped past, so this is deliberately an ALLOW-list of OpenAI names, not a
 * catch-all: an unknown client still gets text.
 *
 * The reason it is safe to serve now and was not before: the widget used to latch on
 * the first result and sit on "Loading…" forever when a host delivered nothing, which
 * is what "stuck Generating…" was. Those are fixed, and a native mount that draws
 * nothing now falls back to the content card. The worst case is the card.
 */
export type WidgetRoute = "mcp-apps" | "openai" | "none";

export function widgetRouteFor(
  clientName?: string,
  declaresUiExtension?: boolean
): WidgetRoute {
  // The mcp-apps route is open to any RECOGNISED family that DECLARED the
  // extension — Claude or OpenAI — rather than to Claude names alone.
  //
  // Observed, and the reason this changed: Codex connects as `codex-mcp-client`
  // declaring `[io.modelcontextprotocol/ui, openai/form]`. It was routed to
  // "openai" purely on its name, handed the Skybridge contract, and rendered
  // nothing; the log line records it reading the widget resource and the user
  // getting a link.
  //
  // The allow-list is NOT dropped, and that is deliberate: `web-sandbox`-style
  // clients declare the extension too, and tools-contract.test.ts pins that they
  // still get text. Declaring is necessary here, not sufficient — the first
  // version of this change made it sufficient and that test caught it.
  if (declaresUiExtension === true && (isWidgetHost(clientName) || isOpenAIClient(clientName))) {
    return "mcp-apps";
  }
  if (isOpenAIClient(clientName)) return "openai";
  return "none";
}

/** Back-compat predicate: "does this client get a widget at all". */
export function shouldAdvertiseWidget(
  clientName?: string,
  declaresUiExtension?: boolean
): boolean {
  return widgetRouteFor(clientName, declaresUiExtension) !== "none";
}

// Used for BOTH the funnel classification and the OpenAI widget route.
export function isOpenAIClient(clientName?: string): boolean {
  return !!clientName && /openai|chatgpt|codex/i.test(clientName);
}

/**
 * How a client binds a connection to a Graffiticode account — the only thing the
 * reconnect copy actually turns on. Built on the matchers above rather than a
 * second name-matching scheme.
 *
 *   claude-code — a config-file client that takes an Authorization header, and the
 *                 one Claude host that is separable by name (production logs show
 *                 `host=claude-code v=2.1.219` distinct from `claude-ai`).
 *   claude-app  — claude.ai / Claude Desktop: connector UI, NO header field, so
 *                 OAuth is its only account-binding path.
 *   openai      — ChatGPT / Codex: same constraint as claude-app.
 *   editor      — Cursor / VS Code / Windsurf / Zed: MCP config file, takes a header.
 *   unknown     — unnamed or unrecognized. Send them to the page and let them pick.
 *
 * This bucket, not the raw client name, is what travels to the console on the claim
 * URL: one taxonomy, defined here, rendered there.
 */
export type ClientHost = "claude-code" | "claude-app" | "openai" | "editor" | "unknown";

export function classifyClientHost(clientName?: string): ClientHost {
  if (!clientName) return "unknown";
  if (/claude-?code/i.test(clientName)) return "claude-code";
  if (isWidgetHost(clientName)) return "claude-app";
  if (isOpenAIClient(clientName)) return "openai";
  if (/cursor|vs-?code|visual[-\s]?studio|windsurf|zed/i.test(clientName)) return "editor";
  return "unknown";
}

// Whether the connector UIs that have no header field (claude.ai, ChatGPT) can yet
// bind a connection to an account. Until `/oauth/consent` accepts the email and
// wallet sign-ins those users actually have — it is Google-only today — telling them
// to "reconnect and sign in" would send them at a button they cannot use, so they get
// the neutral line instead. Flip this with the consent-page work; nothing else changes.
const OAUTH_RECONNECT_ENABLED = process.env.OAUTH_RECONNECT_ENABLED === "true";

/**
 * The one sentence appended to `claim_message`, telling the user how to stop being
 * anonymous in the agent they are actually holding. Deliberately short: chat is not
 * the place for a config blob, and a config-file host needs an API key that only the
 * claim page can mint. The page does the rest.
 */
export function reconnectHint(host: ClientHost): string {
  switch (host) {
    case "claude-code":
      return (
        "After signing in, connect this account: " +
        `claude mcp add --transport http graffiticode ${MCP_ENDPOINT} ` +
        '--header "Authorization: Bearer <api-key>" — the sign-in page issues the key.'
      );
    case "editor":
      return (
        "After signing in, add an Authorization: Bearer <api-key> header to the " +
        "graffiticode entry in your MCP config — the sign-in page issues the key."
      );
    case "claude-app":
    case "openai":
      return OAUTH_RECONNECT_ENABLED
        ? "After signing in, reconnect the Graffiticode connector and sign in there too, " +
            "so new items save to your account automatically."
        : "New items will keep starting out anonymous, so save each one with the link above; " +
            "the sign-in page explains how to connect this connector to your account.";
    case "unknown":
      return "The sign-in page also shows how to connect your agent so new items save automatically.";
  }
}

// _meta keys that carry widget/UI descriptor data. Only these are host-gated; every
// other _meta key (notably `securitySchemes`) is kept for all clients.
function isWidgetMetaKey(key: string): boolean {
  return key === "ui" || key.startsWith("ui/") || key.startsWith("openai/");
}

function stripWidgetMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!isWidgetMetaKey(k)) out[k] = v;
  }
  return out;
}

// Per-host widget wiring. Only verified MCP Apps hosts (Claude) get the native
// widget; everyone else (incl. all ChatGPT/OpenAI surfaces) gets no widget/UI
// descriptor metadata and renders the tool result's text summary + "Open in
// Graffiticode" link. Non-widget `_meta` — `securitySchemes` — is preserved for ALL
// clients. The widget resource URI is content-hashed (the host caches by URI) and
// computed at runtime, so it's injected here rather than baked into the static _meta.
export function toolsForClient(clientName?: string, declaresUiExtension?: boolean): Tool[] {
  const route = widgetRouteFor(clientName, declaresUiExtension);
  const uiUri = widgetResourceUris().mcp;
  return tools.map((t) => {
    const rec = t as Record<string, unknown>;
    const meta = (rec._meta as Record<string, unknown>) ?? {};
    // Not widget-bearing (no openai marker): leave untouched — keeps securitySchemes.
    if (!("openai/resultCanProduceWidget" in meta)) return t;
    // stripWidgetMeta drops the openai marker + any ui.* keys, keeping securitySchemes.
    const base = stripWidgetMeta(meta);
    if (route === "none") {
      // Unknown client: no widget/UI descriptor metadata, securitySchemes kept.
      return { ...rec, _meta: base } as unknown as Tool;
    }
    // Both routes point at the SAME resource. `openai/outputTemplate` is documented
    // by the Apps SDK as a compatibility alias for `_meta.ui.resourceUri`, and the
    // widget's own host adapter picks its transport by feature-detecting
    // `window.openai`, so one build serves both. The keys differ; the artifact does
    // not. `ui/resourceUri` is the legacy flat spelling, kept for older MCP hosts.
    const ui: Record<string, unknown> = {
      ...base,
      ui: { resourceUri: uiUri },
      "ui/resourceUri": uiUri,
    };
    // Emitted for ANY OpenAI client, not only those routed to "openai". Codex
    // declares the MCP Apps extension AND `openai/form`, so it now takes the
    // mcp-apps route — but which key dialect it reads to find the widget is a
    // separate question from which protocol it speaks to mount it, and it costs
    // nothing to answer both. Both key sets point at the same resource; as the
    // note above says, the keys differ and the artifact does not.
    if (isOpenAIClient(clientName)) {
      ui["openai/outputTemplate"] = uiUri;
      // Shown in ChatGPT while the call runs and after it returns. Generation is
      // asynchronous and routinely outlives one render_item poll, so the invoking
      // string is what a user reads for most of the wait.
      ui["openai/toolInvocation/invoking"] = "Working in Graffiticode…";
      ui["openai/toolInvocation/invoked"] = "Opened in Graffiticode";
    }
    return { ...rec, _meta: ui } as unknown as Tool;
  });
}

// --- Tool Handlers ---

export interface ToolContext {
  auth: AuthContext;
  // MCP `clientInfo.name` for this call, when the client sent one. Picks the
  // reconnect wording and the `client=` bucket on the claim URL, and is
  // forwarded to the console's workspace registry.
  clientKind?: string;
  // Whether the client declared `capabilities.extensions["io.modelcontextprotocol/ui"]`
  // during initialize. With clientKind it answers "does this caller mount a
  // widget", which the name alone cannot: `claude-code` passes the Claude
  // whitelist and mounts nothing.
  declaresUi?: boolean;
  // Coarse country from the CDN edge (CF-IPCountry), never an IP. Forwarded to
  // the console because MCP→console is a server-to-server call with no edge in
  // front of it: only this hop knows where the agent actually connected from.
  geoCountry?: string;
}

// The app's view page for an item, opened in a full browser tab (where a
// signed-in user has a session). Surfaced as `view_url` for the widget's
// "Open in Graffiticode" link.
function buildViewUrl(itemId: string, claimToken?: string | null): string {
  const base = `${APP_URL}/form/${itemId}`;
  // Embed the claim token on free-plan view links so the render-host footer can
  // offer a one-click "Claim it in Graffiticode" link for this exact item. The
  // JWT is URL-safe (base64url), so no extra encoding is needed.
  return claimToken ? `${base}?claim=${claimToken}` : base;
}

// For trial-mode responses, wrap the console-issued claim token in the fields
// the console's /claim page consumes. Returns null when not a free-plan call or
// when the console issued no token (unconfigured salt — graceful degrade).
//
// The token comes from the console rather than being minted here. We used to
// derive it from our own transport session uuid, which addressed the wrong
// namespace for any client whose transport session isn't where its items live —
// a stateless client revising an item created in an earlier session produced a
// claim link over an empty namespace, so claiming transferred nothing at all.
// Only the console knows the effective workspace, so only the console can mint
// this. That also retires the copy of the HS256 signing parameters this repo was
// keeping in sync with the console's by hand.
export function buildClaimFields(
  auth: AuthContext,
  claimToken?: string | null,
  clientKind?: string
): { token: string; claim_url: string; claim_url_widget: string; claim_message: string } | null {
  if (auth.type !== "freePlan" || !claimToken) return null;
  // `src=chat` attributes the click to the link an agent prints, as distinct
  // from the render-host footer's Claim button (which carries src=footer). The
  // two convert very differently, so a blended rate wouldn't be actionable.
  //
  // `agent` is the coarse host bucket (never the raw client name): the claim page
  // opens on the right connect instructions instead of asking someone who just
  // signed in to identify their own agent. A host family is not an identifier —
  // `client_kind` is already carried on our funnel events.
  //
  // Named `agent`, NOT `client`: the console already reads `?client=` app-wide as
  // the item source surface (console|mcp|front, see its _app.tsx), and reusing that
  // name for a different taxonomy is a collision waiting to be discovered.
  const host = classifyClientHost(clientKind);
  const claimUrlFor = (src: "chat" | "widget") =>
    `${CONSOLE_URL}/claim?token=${claimToken}&src=${src}&agent=${host}`;
  const claim_url = claimUrlFor("chat");
  return {
    token: claimToken,
    claim_url,
    // The same claim, stamped for the widget's in-host footer button. Minted here
    // rather than rewritten in the browser: the widget used to open `claim_url`
    // verbatim, so its clicks arrived stamped `chat` and the two surfaces were
    // indistinguishable in the funnel — 35 claim views, all `chat`.
    //
    // `widget`, NOT `footer`: three surfaces can offer this claim, and each needs
    // its own value. `chat` is the link an agent prints, `widget` is this button
    // inside the host, and `footer` is the app's /form attribution bar (see the
    // app's FormFooter, reached via view_url's `?claim=`). Collapsing any two of
    // them re-creates the blind spot this exists to remove.
    claim_url_widget: claimUrlFor("widget"),
    // Markdown link rather than a bare URL — the token is a ~250-char JWT, and the
    // ready summary prints a second one right above this. The raw URL stays
    // available as the `claim_url` field.
    //
    // It does NOT re-open with "Your item is ready": the summary line this is
    // appended to has already said so. Standalone (as its own field) it still reads
    // as a complete instruction.
    //
    // The hint goes on its own line so the link ends one: a sentence butted up
    // against a link is where renderers start swallowing trailing words into the
    // href, and this link is the whole point of the message.
    claim_message:
      `To keep it permanently, [sign in to save it](${claim_url}).\n` +
      reconnectHint(host),
  };
}

// Set `view_url` (with the claim token embedded for free-plan items, so the
// render-host footer can offer a "Claim it" link for this exact item) plus the
// claim_url/claim_message fields. The raw token is intentionally not surfaced as
// its own response field.
function applyViewAndClaim(
  obj: Record<string, unknown>,
  auth: AuthContext,
  itemId: string,
  claimToken?: string | null,
  clientKind?: string
): void {
  const claimFields = buildClaimFields(auth, claimToken, clientKind);
  obj.view_url = buildViewUrl(itemId, claimFields?.token);
  if (claimFields) {
    obj.claim_url = claimFields.claim_url;
    obj.claim_message = claimFields.claim_message;
  }
}

// Shape returned by create_item / update_item and by the retrieval tools while a
// generation is still running. The model is expected to poll a retrieval tool
// until status flips to "ready".
//
// No view_url/claim_url here: those links are only meaningful once the item has
// content, and the MCP client renders the response JSON as chat text — emitting
// them now would surface (and repeat, on every poll) an "Open in Graffiticode"
// link before anything exists. They're added on the "ready" response.
export function buildGeneratingResponse(
  itemId: string,
  lang: string,
  name: string | null,
  operation: "create" | "update"
): Record<string, unknown> {
  const label = name ? `"${name}"` : `your L${lang} item`;
  // The id is INTERPOLATED into the prose, not left as a literal `item_id`
  // placeholder. Generation is async, so this response is the only record of the
  // handle — and there is no list_items tool, so a caller who cannot read the
  // structured `item_id` field can never reach the item again; it just expires.
  // Plenty of surfaces render only the text: the MCP Inspector shows the text
  // block and nothing else (verified — its copy button copies only that), and any
  // client that drops structuredContent behaves the same. Agents are unaffected,
  // they read the field.
  const call = `render_item("${itemId}")`;
  return {
    item_id: itemId,
    status: "generating",
    operation,
    language: `L${lang}`,
    name: name ?? null,
    // create_item/update_item render NO widget (they'd leave a "Generating…" card
    // that can never update — the ready result comes from render_item). So this is
    // the chat-facing line; the model calls render_item next to display the result.
    summary: `${operation === "update" ? "Updating" : "Creating"} ${label}… call ${call} to display it when ready.`,
    // Steer to render_item (compact result, renders the widget) — NOT raw get_item,
    // which would pull language-private src/data into the model transcript.
    message:
      `Generation started. Call ${call} to retrieve and display the result — it waits for completion and returns status 'ready' (or 'failed').`,
  };
}

// Human-readable, link-forward summary for the get_item "ready" response. Used
// as the tool result's text content for clients that render text instead of
// the widget iframe (e.g. Codex Desktop, whose inline MCP-Apps UI is still
// flag-gated). Widget hosts ignore it.
// The console defaults an omitted name to the literal string "unnamed"
// (its resolvers.ts, at item create). That made the `name ? … : …` fallback below
// unreachable and put our own placeholder in front of the user, in bold, as if it
// were the item's title. Treat it as the absence it represents.
const PLACEHOLDER_NAME = "unnamed";

function displayName(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.toLowerCase() === PLACEHOLDER_NAME) return null;
  return trimmed;
}

export function buildReadySummary(
  name: string | null,
  language: string,
  viewUrl: string,
  claimMessage?: string,
  // The merged payload, so the summary can show what the item CONTAINS. Optional
  // because the summary predates it, and a caller without `data` should still get
  // the title and the link rather than nothing.
  payload?: Record<string, unknown>
): string {
  const shown = displayName(name);
  const title = shown ? `**${shown}**` : "Your item";
  // Markdown link, not a bare URL: these carry a ~250-char claim JWT, and two of
  // them printed raw made the message almost entirely base64. The URL is still
  // addressable as the `view_url` field for clients that need it literally.
  const lines = [
    `${title} (${language}) is ready — [open the form view](${viewUrl})`,
  ];
  // The content itself, rendered from the same model the widget draws. Without it
  // a client that renders no widget saw only the line above — a name and a URL —
  // and could not tell a correct item from a broken one without opening a browser.
  // Placed before the claim message so the item leads and the account prompt follows.
  if (payload) {
    const body = contentToMarkdown(describeItem(normalizeLang(language), payload));
    if (body) lines.push(body);
  }
  if (claimMessage) lines.push(claimMessage);
  return lines.join("\n\n");
}

/**
 * Summaries for the states that are not "ready".
 *
 * These branches returned bare objects with no `summary` field, and
 * `formatToolResult` falls back to `JSON.stringify(structuredContent, null, 2)`
 * when `summary` is not a string — so every still-generating and every failed
 * render answered the user with a pretty-printed JSON blob. Four of an OpenAI
 * reviewer's renders hit the poll deadline on 2026-08-29 and got exactly that.
 */
/**
 * "(39s, ~2,040 tokens written)" — the one progress phrase, shared by the summary
 * and by the `message` that steers the model, so the two cannot drift.
 *
 * Empty when there is nothing honest to say, so a caller never renders "(0s)".
 */
export function progressFragment(elapsedS?: number, writtenChars?: number): string {
  const parts: string[] = [];
  if (elapsedS !== undefined && elapsedS > 0) parts.push(`${elapsedS}s`);
  if (writtenChars !== undefined && writtenChars > 0) {
    parts.push(`~${Math.round(writtenChars / 4).toLocaleString()} tokens written`);
  } else if (elapsedS !== undefined && elapsedS >= 15) {
    // Nothing written after a quarter minute is worth naming rather than reporting
    // as zero: the model is still planning, which is not the same as stuck.
    parts.push("still planning");
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function buildGeneratingSummary(
  name: string | null,
  retrievalTool: string,
  itemId: string,
  elapsedS?: number,
  writtenChars?: number
): string {
  const shown = displayName(name);
  const title = shown ? `**${shown}**` : "Your item";
  // Elapsed time goes in the TOOL RESULT, not only in the progress notification.
  //
  // The in-call heartbeat sends notifications/progress with a message, and every
  // observed client asks for one — but a user on 2026-09-09 reported their chat
  // showing only "rendering item…", i.e. the tool NAME. The notification is
  // delivered and not rendered, so anything put in it (a token counter included)
  // is invisible to them. The result text is the one thing the client displays.
  //
  // Without it, three identical "still generating" lines in a transcript cannot be
  // told from a hung call; with it they read as 12s, 24s, 36s, which is the actual
  // question a person is asking when they watch this cycle.
  // Elapsed says the job is ALIVE; written says it is PRODUCING. Both are needed,
  // because the three states that actually occur here look identical without them:
  // writing steadily, thinking with nothing emitted (an L0179 run spent 5.5 minutes
  // that way), and hung.
  //
  // Reported as tokens at ~4 chars each because that is the unit anyone asks in,
  // and marked "~" because the console can only publish characters — Anthropic
  // reports output_tokens once, at the end of a turn.
  const took = progressFragment(elapsedS, writtenChars);
  return `${title} is still generating${took} — call \`${retrievalTool}("${itemId}")\` again to keep waiting.`;
}

/**
 * What `message` asks the model to do with a ready item.
 *
 * Exported and separate so the copy is pinned by a test. It was rewritten once and
 * the edit was lost before it reached a commit — the header fix beside it shipped,
 * this did not, and production kept telling models to hand over a bare link for
 * three more days. A test would have caught that; a description of the change did
 * not.
 */
export function buildLinkDirective(viewUrl: string, mountsWidget = false): string {
  // A client that MOUNTED the item has already shown it. Asking the model to
  // "show the contents from summary" then produces the item twice: once as the
  // live widget and once as a markdown transcription of it underneath. Observed
  // on 2026-09-11 — a 5x5 sheet rendered as an interactive grid with a second,
  // static copy of the same numbers printed below it.
  //
  // The clause that prevents the ORIGINAL failure is kept either way, as the last
  // word: a model that decides prose is enough must still hand over the link.
  // …but whether a component ACTUALLY draws cannot be known from here, so this
  // half no longer asserts that it did. Both signals we have were measured wrong
  // on 2026-09-17, in opposite directions:
  //
  //   name-only  — a ChatGPT workspace plugin matched the OpenAI allow-list,
  //                mounted nothing, and told the user "The interactive
  //                Graffiticode quiz is rendered above". Nothing was there.
  //   declared   — codex-mcp-client declares io.modelcontextprotocol/ui and is a
  //                TERMINAL: it received "do NOT reproduce its contents" and
  //                printed a bare link, which is the failure this whole directive
  //                was written to prevent.
  //
  // So the model is told what to do in each case and left to see which it is,
  // rather than being handed a false premise. A host that did mount and prints
  // the contents anyway shows the item twice, which is recoverable; a host that
  // did not mount and was told to stay quiet leaves the user with nothing.
  // …and as of 2026-09-17 that is the ONLY directive, for every client.
  //
  // Suppression was tried three ways and each cost more than it saved. Keyed on
  // NAME, a ChatGPT plugin announced "the interactive quiz is rendered above"
  // with nothing on screen. Keyed on the UI-EXTENSION DECLARATION, it reached a
  // terminal and produced a bare link. Made CONDITIONAL, the model still chose
  // the quiet branch and a chart arrived as one sentence and a URL.
  //
  // What decided it: on a FRESHLY connected ChatGPT client against the current
  // build, the host read the widget HTML and fetched the language bundle (HTTP
  // 200) and still painted nothing. Suppression protects a render that has never
  // been observed on these hosts, and it charges for that protection on every
  // single call. If a widget does start mounting, the failure becomes the item
  // appearing twice — visible, and fixable by a deploy without a resubmission,
  // which is the opposite of a silent empty answer.
  void mountsWidget;
  return (
    "Show the user this item's contents from `summary` below, then give them this " +
    `link so they can open and use it: ${viewUrl}` +
    " — show both; a description alone is not a substitute for the link."
  );
}

/**
 * Does this caller mount a widget, and therefore already show the item?
 *
 * Both halves are needed. The name alone over-matches — `claude-code` passes the
 * Claude whitelist and mounts nothing — and the declaration alone over-matches
 * too, since `web-sandbox`-style clients declare the extension and are
 * deliberately given text. This is `widgetRouteFor` asked as a yes/no, so the two
 * cannot drift apart.
 */
export function clientMountsWidget(clientKind?: string, declaresUi?: boolean): boolean {
  // Only a DECLARED mount counts as "already shown".
  //
  // This used to be `route !== "none"`, which let the name-only `openai` route
  // claim a render it never performed — the same over-match this function's own
  // docstring warns about for `claude-code`, reintroduced for OpenAI clients.
  // Observed 2026-09-17 in a ChatGPT workspace plugin: the quiz was created, no
  // widget appeared, and the assistant said "The interactive Graffiticode quiz
  // is rendered above" because this message told it to. The user got neither the
  // widget nor the contents.
  //
  // A host that mounts and ALSO prints the contents shows the item twice, which
  // is the 2026-09-11 bug this suppression was written for. That is the better
  // failure: duplication is recoverable by reading past it, while a phantom
  // render leaves nothing on screen and tells the user it is there. So the
  // suppression now needs the extension declaration, and the name-only route
  // keeps the contents.
  return widgetRouteFor(clientKind, declaresUi) === "mcp-apps";
}

/**
 * A failure, and what to do about it.
 *
 * The generating summary names the exact tool to call and gets that call
 * essentially every time; this one named nothing, and left the model to invent a
 * recovery. On 2026-09-06 a Codex session guessed `update_item` — which is right,
 * and retries in place keeping the item and its workspace — but "guessed right" is
 * not a design, and giving up or starting a fresh item were equally available.
 *
 * The advice is CONDITIONAL because not every failure is retryable, and the caller
 * has only the error prose to tell them apart: an empty generation says trying
 * again usually succeeds, while an out-of-scope refusal says no language fits and
 * retrying it just loops. Rather than branch on that prose here — which the console
 * deliberately avoids, having given `out_of_scope` a machine-readable code for the
 * purpose — the sentence hands the model both branches and the error text it needs
 * to choose. Threading the console's error CODE through `generationError` would let
 * this decide instead of advise; that is the better fix and is not done here.
 */
export function buildFailedSummary(
  name: string | null,
  language: string,
  error: string,
  itemId?: string
): string {
  const shown = displayName(name);
  const title = shown ? `**${shown}**` : "Your item";
  const head = `${title} (${language}) could not be generated — ${error}`;
  if (!itemId) return head;
  return (
    `${head}\n\nIf that reads as a temporary failure, call ` +
    `\`update_item("${itemId}", "<the same request>")\` to try again on this same item. ` +
    `If it says the request is out of scope, tell the user what happened instead of retrying.`
  );
}

// Conservative guard against the over-reaching inputs get_spec exists to replace: passing an item
// id (a handle, not content) or a language-private artifact (a decompiled src / AST node pool) as
// the description. Returns a corrective message, or null when the description looks like a request.
// Deterministic validation — it rejects the same malformed input every time; it is not a second
// generation path.
function detectForwardedArtifact(description: string): string | null {
  const d = (description ?? "").trim();
  // A bare item-id token: one long alnum run, no spaces. A real request always has words.
  if (/^[A-Za-z0-9_-]{16,}$/.test(d)) {
    return "That looks like an item id, not content — item ids are opaque handles. Call get_spec(item_id) and pass its returned text (plus your intent framing) as the description.";
  }
  // A pasted AST node pool (get_item code/data), not a natural-language request.
  if (/"tag"\s*:/.test(d) && /"elts"\s*:/.test(d)) {
    return "That looks like a language-private artifact (an AST/data blob), not a request. Don't forward get_item output across languages — call get_spec(item_id) for a platform-neutral description and pass that instead.";
  }
  return null;
}

export async function handleCreateItem(
  ctx: ToolContext,
  args: {
    language: string;
    description: string;
    name?: string;
    continue_from_item_id?: string;
  }
): Promise<unknown> {
  const { language, description, name, continue_from_item_id } = args;

  const misuse = detectForwardedArtifact(description);
  if (misuse) {
    throw new Error(misuse);
  }

  // Normalize language ID (remove "L" prefix if present)
  const langId = language.replace(/^L/i, "");

  // Start async generation (creates the item shell + enqueues the work) and
  // return immediately. No long-running tool call.
  const job = await startCodeGeneration({
    auth: ctx.auth,
    lang: langId,
    name,
    // Keeps a stateless client's items in ONE anonymous workspace, so a single
    // claim link saves the whole conversation. Passed straight through without
    // validation: only the console can say whether the id is reachable, and it
    // silently declines rather than failing the create if it isn't.
    siblingOf: continue_from_item_id,
    client: "mcp",
    clientKind: normalizeClientKind(ctx.clientKind),
    geoCountry: ctx.geoCountry,
    prompt: description,
    modification: description,
  });

  return buildGeneratingResponse(job.itemId, langId, name ?? null, "create");
}

/**
 * How much of an item's compiled record travels with an update.
 *
 * The console renders at most 6KB of it into the prompt, so a cap a little above
 * that loses nothing it would have used, while keeping a large compiled item (a
 * Learnosity record runs to tens of KB) out of every edit request. The context
 * worth carrying is the kind the SOURCE cannot express, and that kind is small.
 */
const MAX_CURRENT_DATA_CHARS = 8000;

/** Time budget for the extra fetch. An edit must not wait long on a decoration. */
const CURRENT_DATA_TIMEOUT_MS = 5_000;

/**
 * The item's compiled record, serialized, or null — never a throw.
 *
 * Every failure mode lands on null and the update proceeds exactly as it did
 * before this existed: no task to read, a slow or failed fetch, an error
 * envelope (the same 404-during-generation blob isErrorDataPayload guards
 * elsewhere), or a record too large to be worth sending.
 */
async function currentDataFor(ctx: ToolContext, taskId: string | undefined | null): Promise<string | null> {
  if (!taskId) return null;
  try {
    const data = await getData({ auth: ctx.auth, taskId, timeoutMs: CURRENT_DATA_TIMEOUT_MS });
    if (data == null || isErrorDataPayload(data)) return null;
    const serialized = JSON.stringify(data);
    if (!serialized || serialized.length > MAX_CURRENT_DATA_CHARS) return null;
    return serialized;
  } catch {
    return null;
  }
}

export async function handleUpdateItem(
  ctx: ToolContext,
  args: { item_id: string; modification: string }
): Promise<unknown> {
  const { item_id, modification } = args;

  // Fetch existing item + task src to build the contextual prompt.
  const existingItem = await apiGetItemWithTask({
    auth: ctx.auth,
    id: item_id,
  });

  if (!existingItem) {
    throw new Error(`Item not found: ${item_id}`);
  }

  const currentSrc = existingItem.task?.src ?? null;
  const existingHelp = parseHelp(existingItem.help);
  const contextualPrompt = buildContextualPrompt(existingHelp, modification);

  // WHAT THE ITEM COMPILES TO, sent alongside its source.
  //
  // The source is not always enough to edit against. A dialect may keep the
  // values an edit acts on outside the program: L0182 names a survey and nothing
  // else, its ideas being fetched by the compiler, so a generator editing that
  // program has never seen an idea. Asking it to record three of them by name
  // then has nothing anchoring the strings, and it invents near-misses that fail
  // to compile ("address climate change" for "mitigate climate change") or, worse,
  // drops one and compiles — a real record of an answer nobody gave. Measured
  // 2026-09-11 over 12 answers with the data model absent: 1 correct, 7 refused
  // by the compiler, 3 silently short.
  //
  // Best-effort in every direction. It decorates the prompt, so nothing here may
  // cost the generation: a failed fetch, an error envelope or an oversized record
  // simply means generating the way this path always did.
  const currentData = await currentDataFor(ctx, existingItem.taskId);

  // Start async generation against the existing item and return immediately.
  // The worker appends the help entry and persists the new taskId on completion.
  const job = await startCodeGeneration({
    auth: ctx.auth,
    itemId: item_id,
    lang: existingItem.lang,
    // `client: "mcp"` was missing here while create_item has always sent it.
    // The console carries it through the queued job into item_updated /
    // item_generation_failed as `app`, and the MCP funnel report admits those
    // only when app === "mcp" — so every MCP update was invisible to it.
    client: "mcp",
    clientKind: normalizeClientKind(ctx.clientKind),
    geoCountry: ctx.geoCountry,
    prompt: contextualPrompt,
    modification,
    currentSrc,
    currentData,
  });

  return buildGeneratingResponse(job.itemId, existingItem.lang, existingItem.name, "update");
}

const GET_ITEM_POLL_DEADLINE_MS = 45_000; // under codex's ~60s tool-call cap
/**
 * render_item stops waiting much earlier than get_item, because its callers have
 * different tolerances and only one of them is a UI.
 *
 * A widget host abandons a slow tool call and paints its own error where the
 * widget belongs. Observed 2026-09-01, same item and same session minutes apart:
 *
 *   render_item  ms=33159  upstream_n=13  -> host showed "Unable to reach Graffiticode"
 *   render_item  ms= 3356  upstream_n= 2  -> rendered correctly
 *
 * The server logged `outcome=ok` for BOTH — it finished the 33s call and never saw
 * a failure, which is why this looked like a widget bug for a while. The 10s
 * in-call heartbeat did not prevent it either: that call carried a progressToken
 * and was sending notifications/progress the whole time.
 *
 * So the deadline is the lever, and it is set well under the observed failure
 * rather than just under it — the host's actual threshold is somewhere below 33s
 * and is not something we can read. Returning `status: "generating"` early is
 * cheap and self-correcting: the response tells the model to call again, and the
 * next call returns a ready item in a couple of seconds. Blocking is not cheap —
 * it spends the host's entire patience budget and then loses the render.
 *
 * get_item keeps the long deadline: it is the programmatic path, its callers are
 * scripts and Codex rather than a UI, and nothing paints an error box on it.
 *
 * NOTE this constant is nearly the ceiling, but not exactly. It USED to be far
 * from it: the loop tested the deadline and then slept a full interval, so the
 * last wait could start just under the deadline and end well past it — worst
 * case this value + a whole poll interval + one upstream round-trip, measured at
 * 17.1s when this was 15s. `napBeforeRetry` now clamps every sleep to the
 * remaining budget, so the overshoot is at most the last upstream round-trip
 * (~500ms) rather than a whole interval.
 *
 * It is 8s because the host's error was later reported appearing in UNDER 30s,
 * which only bounds the threshold from above — it could be well under 15s. The
 * budget now covers the WHOLE call (see the getData deadline below), not just
 * the generating wait: a render that found the item ready at 12s then spent 9s
 * fetching data still took 21.1s and still lost the render.
 */
const RENDER_ITEM_POLL_DEADLINE_MS = 8_000;
/**
 * The leash for a client that mounts NO widget, and therefore cannot abandon a slow
 * call and paint an error over one.
 *
 * Longer than a widget host's 8s because nothing is at risk, and far shorter than
 * get_item's 45s because for this caller a return is the only chance to say
 * anything: the progress line only reaches a person when the call comes back.
 */
const TERMINAL_POLL_DEADLINE_MS = 15_000;
/**
 * How long to wait between polls, per mode — and it is per mode for the same reason
 * the deadline is.
 *
 * get_item keeps 2.5s: it has a 45s budget, so a slow interval costs it nothing but
 * upstream calls it does not need to make.
 *
 * render_item has 8s TOTAL, and every sleep is budget it cannot spend on noticing the
 * item is ready. Profiled 2026-09-04 on the simplest possible generation (L0000,
 * "multiply 10 and 21", ELEVEN characters of code): the loop made 4 upstream checks
 * of ~483ms separated by three 2.5s sleeps, and spent 7.5s of a 9.4s call asleep.
 * At 1s it fits roughly twice as many checks in the same window, so readiness is
 * seen within ~1s of happening instead of up to ~3s.
 *
 * Not lower than 1s: a check costs ~480ms upstream, so the loop's duty cycle is
 * already ~1/3 at this interval. Below 1s it stops being a poll and becomes a
 * spin against the console for the whole 8s.
 */
const RENDER_ITEM_POLL_INTERVAL_MS = 1_000;
const GET_ITEM_POLL_INTERVAL_MS = 2_500;

/**
 * Below this much remaining budget, another check cannot pay for itself: an upstream
 * poll costs ~480ms, and a check that lands after the deadline has its answer thrown
 * away by the `remainingMs <= 0` branch — which is exactly what happened in the
 * profiled run. It saw a READY item and reported "still generating" because it had
 * no budget left to fetch data with. Stopping early instead returns the same answer
 * without spending the call.
 */
const POLL_MIN_REMAINING_MS = 600;

/**
 * How long to sleep before the next poll — or null when another check cannot pay
 * for itself before the deadline.
 *
 * Exported and pure because this is the arithmetic that was wrong: the old code
 * tested `now < deadline` and then slept a FULL interval, which put the next check
 * past the deadline, where the `remainingMs <= 0` branch throws its answer away.
 * A ready item was reported as "still generating" that way. See the poll-budget
 * tests.
 */
export function pollNapMs(
  remainingMs: number,
  intervalMs: number,
  minRemainingMs: number = POLL_MIN_REMAINING_MS
): number | null {
  if (remainingMs < minRemainingMs) return null;
  return Math.min(intervalMs, remainingMs);
}
/**
 * Worker-died guard. MUST stay above the console's generation ceiling, or it
 * reports a RUNNING generation as a failed one.
 *
 * The console gives a generation 900s on both sides of the queue — Cloud Run's
 * `timeoutSeconds` and the Cloud Tasks `dispatchDeadline` (console commit
 * e7b9dd0, `src/lib/generation-queue.ts`). This constant was 4 minutes, so every
 * generation that ran between 240s and 900s was told to the agent as
 * `status:"failed", error:"Generation timed out"` while the worker was still
 * working — and the item then flipped to `ready` behind the user's back. Saying
 * "it failed" about work that succeeds is worse than waiting: the agent stops
 * polling and the user is told to start over.
 *
 * 960s = the console's 900s ceiling plus a minute for the queue hop and the
 * item write. Lower this only in lockstep with that ceiling; the two numbers are
 * a pair and neither is meaningful alone.
 */
const GENERATION_STALE_MS = 16 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The Graffiticode API's data(id) resolver returns this envelope when a task's
// rendered data isn't available: { status: "error", error: { code, message } }.
// Match it specifically (status:"error" + numeric error.code) so we don't
// mistake a real item's data for an error.
function isErrorEnvelope(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.status !== "error") return false;
  const err = o.error as Record<string, unknown> | undefined;
  return !!err && typeof err === "object" && typeof err.code === "number";
}

// During the brief window after create/update the item can transiently point at
// a template/old task whose data hasn't been computed yet, so a too-eager
// "ready" classification would surface a 404 blob. The envelope can arrive
// either at the top level of the getData payload or nested under `.data` (the
// real content lives at `.data` for a successful render, e.g. L0158/L0166), so
// check both levels.
function isErrorDataPayload(data: unknown): boolean {
  if (isErrorEnvelope(data)) return true;
  if (data && typeof data === "object") {
    return isErrorEnvelope((data as Record<string, unknown>).data);
  }
  return false;
}

// get_item long-polls: while the item is still generating it waits (up to ~45s,
// under the client tool-call timeout; the server.ts heartbeat keeps the stream
// warm) and returns the moment the item is ready/failed. A single create_item
// followed by get_item therefore completes without ever holding a 60-110s call.
async function handleItemResult(
  ctx: ToolContext,
  args: { item_id: string },
  mode: "raw" | "render"
): Promise<unknown> {
  const { item_id } = args;
  // Poll messages name the SAME retrieval tool the caller used, so the model
  // keeps calling the right one (render_item stays compact; get_item stays raw).
  const retrievalTool = mode === "render" ? "render_item" : "get_item";
  // render_item's short deadline is protection against a WIDGET HOST abandoning the
  // call and painting its own error where the widget belongs. A client that mounts
  // nothing cannot do that, and for it the short deadline is pure cost: it returns
  // "still generating" every 8s, so a 30s generation costs the model four tool calls
  // and a 165s one costs twenty. In a chat transcript that reads as thrashing, which
  // is what a user reported on 2026-09-09.
  //
  // So the leash is chosen by whether the caller can actually mount a widget, not by
  // which tool was called.
  //
  // A non-mounting client got get_item's 45s at first, on the reasoning that one
  // call should cover a whole generation. That was right while a return said nothing
  // useful — but it is now the opposite of what the caller wants. Every return
  // carries real progress ("39s, ~2,040 tokens written") and asks for it to be
  // shown, so a RETURN is the only moment anything can appear on screen. At 45s the
  // user watches an in-flight spinner for three quarters of a minute between words;
  // they described it as "a bouncing dots animation".
  //
  // 15s is the compromise: a 60s generation reports four times instead of once,
  // where the original 8s reported eight times and said nothing each time. The churn
  // that started this was never the call COUNT — it was calls that carried no
  // information.
  //
  // Still well under Codex's ~60s tool-call cap, and get_item keeps 45s: its callers
  // are scripts, which want the answer rather than a narration of the wait.
  // How long the GENERATION has been running — not how long this call has waited.
  // `generationStartedAt` is stamped by the console when the job is queued and
  // cleared on any terminal status, so it survives across the several render_item
  // calls a slow generation costs, which is exactly the span a user is watching.
  let pendingStartedAt = 0;
  let pendingChars = 0;
  const elapsedS = (): number | undefined => {
    if (!pendingStartedAt) return undefined;
    return Math.round((Date.now() - pendingStartedAt) / 1000);
  };

  // The 8s leash is for the host that was actually SEEN abandoning a call: a Claude
  // widget host, at 33.2s, painting "Unable to reach Graffiticode" where the widget
  // belonged. It stays on that client.
  //
  // ChatGPT also mounts a widget, but nothing has ever been observed abandoning
  // there, and the short leash has a cost that IS observed: every render_item call
  // mounts its own widget section, so an 8s leash stacks ~8 "Render item" cards down
  // a chat for a 60s generation. A user reported exactly that on 2026-09-09.
  //
  // So ChatGPT takes the terminal's 15s: half the observed Claude threshold, and
  // half as many stacked cards. Fewer, each now carrying a live progress line.
  const bounded = mode === "render" && isWidgetHost(ctx.clientKind);
  const deadline =
    Date.now() +
    (bounded
      ? RENDER_ITEM_POLL_DEADLINE_MS
      : mode === "render"
        ? TERMINAL_POLL_DEADLINE_MS
        : GET_ITEM_POLL_DEADLINE_MS);
  // The interval follows the deadline, not the mode: 1s over a 45s budget would be
  // ~30 upstream checks for one call, where the tight interval exists to notice
  // readiness inside a budget that is nearly over.
  const pollIntervalMs = bounded
    ? RENDER_ITEM_POLL_INTERVAL_MS
    : GET_ITEM_POLL_INTERVAL_MS;

  /**
   * Wait before the next check, and say whether one is still worth making.
   *
   * The sleep is CLAMPED to the deadline. Every retry site used to test
   * `Date.now() < deadline` and then sleep a full interval, which routinely
   * overshoots: in the profiled run the third check ended 1.55s before the
   * deadline, slept the full 2.5s, and made a fourth check 950ms PAST it — whose
   * ready verdict the deadline branch then discarded. Sleeping only as long as
   * the budget allows keeps the last check inside the window where its answer can
   * still be used.
   */
  const napBeforeRetry = async (): Promise<boolean> => {
    const nap = pollNapMs(deadline - Date.now(), pollIntervalMs);
    if (nap === null) return false;
    await sleep(nap);
    return true;
  };

  for (;;) {
    const item = await apiGetItemWithTask({ auth: ctx.auth, id: item_id });
    if (!item) {
      throw new Error(`Item not found: ${item_id}`);
    }

    const status = item.generationStatus;

    if (status === "failed") {
      // No view_url/claim_url: a failed item has nothing to open or claim.
      const error = item.generationError || "Generation failed";
      return {
        item_id: item.id,
        status: "failed",
        error,
        language: `L${item.lang}`,
        name: item.name,
        summary: buildFailedSummary(item.name, `L${item.lang}`, error, item.id),
      };
    }

    if (status === "generating") {
      const startedAt = item.generationStartedAt ? Number(item.generationStartedAt) : 0;
      pendingStartedAt = startedAt;
      pendingChars = typeof item.generationChars === "number" ? item.generationChars : 0;
      const stale = startedAt > 0 && Date.now() - startedAt > GENERATION_STALE_MS;
      if (stale) {
        return {
          item_id: item.id,
          status: "failed",
          error: "Generation timed out",
          language: `L${item.lang}`,
          name: item.name,
          summary: buildFailedSummary(item.name, `L${item.lang}`, "Generation timed out", item.id),
        };
      }
      if (await napBeforeRetry()) {
        continue;
      }
      // Deadline reached but still generating — return so the model polls again.
      // No view_url/claim_url until the item is ready (see buildGeneratingResponse).
      return {
        item_id: item.id,
        status: "generating",
        language: `L${item.lang}`,
        name: item.name,
        message:
          `Still generating${progressFragment(elapsedS(), pendingChars)}. ` +
          // Ask for the progress to be SHOWN. Without this the model receives the
          // line and silently calls the tool again, so the user sees only their
          // client's in-flight spinner — reported on 2026-09-09 as "a bouncing dots
          // animation" with no sign of movement. The ready path already works this
          // way ("Show the user this item's contents…"), and it works because it asks.
          `Tell the user that progress, then call ${retrievalTool}(item_id) again to keep waiting.`,
        summary: buildGeneratingSummary(item.name, retrievalTool, item.id, elapsedS(), pendingChars),
        // Without the leading space the fragment carries: the widget places it
        // itself, and an empty string means "nothing honest to say yet".
        progress: progressFragment(elapsedS(), pendingChars).replace(/^ \(|\)$/g, ""),
      };
    }

    // Ready (status "ready" or legacy/sync item with no status). Needs a task.
    if (!item.task || !item.taskId) {
      // Status says ready/absent but the task isn't visible yet — brief lag.
      if (await napBeforeRetry()) {
        continue;
      }
      throw new Error(`Task not found for item: ${item_id}`);
    }

    // The deadline has to cover this too. A poll loop that finishes inside budget
    // and then spends 9s in getData has still blown the caller's budget — observed
    // at 21.1s on a call whose generating-wait was correctly capped. Past the
    // deadline we return "generating" rather than start an unbounded fetch: the
    // item IS ready, so the model's next call skips the wait entirely and spends
    // its whole budget here.
    const remainingMs = deadline - Date.now();
    if (bounded && remainingMs <= 0) {
      return {
        item_id: item.id,
        status: "generating",
        language: `L${item.lang}`,
        name: item.name,
        message:
          `Still generating${progressFragment(elapsedS(), pendingChars)}. ` +
          // Ask for the progress to be SHOWN. Without this the model receives the
          // line and silently calls the tool again, so the user sees only their
          // client's in-flight spinner — reported on 2026-09-09 as "a bouncing dots
          // animation" with no sign of movement. The ready path already works this
          // way ("Show the user this item's contents…"), and it works because it asks.
          `Tell the user that progress, then call ${retrievalTool}(item_id) again to keep waiting.`,
        summary: buildGeneratingSummary(item.name, retrievalTool, item.id, elapsedS(), pendingChars),
        // Without the leading space the fragment carries: the widget places it
        // itself, and an empty string means "nothing honest to say yet".
        progress: progressFragment(elapsedS(), pendingChars).replace(/^ \(|\)$/g, ""),
      };
    }
    const data = await getData({
      auth: ctx.auth,
      taskId: item.taskId,
      ...(bounded ? { timeoutMs: remainingMs } : {}),
    });

    // The item reports ready and its task is visible, but the rendered data
    // isn't available yet (data(id) returned a 404 envelope) — a transient
    // intermediate during create/update. Keep polling rather than returning a
    // "ready" item carrying a broken data blob; resolves once real data lands.
    if (isErrorDataPayload(data)) {
      if (await napBeforeRetry()) {
        continue;
      }
      return {
        item_id: item.id,
        status: "generating",
        language: `L${item.lang}`,
        name: item.name,
        message:
          `Still generating${progressFragment(elapsedS(), pendingChars)}. ` +
          // Ask for the progress to be SHOWN. Without this the model receives the
          // line and silently calls the tool again, so the user sees only their
          // client's in-flight spinner — reported on 2026-09-09 as "a bouncing dots
          // animation" with no sign of movement. The ready path already works this
          // way ("Show the user this item's contents…"), and it works because it asks.
          `Tell the user that progress, then call ${retrievalTool}(item_id) again to keep waiting.`,
        summary: buildGeneratingSummary(item.name, retrievalTool, item.id, elapsedS(), pendingChars),
        // Without the leading space the fragment carries: the widget places it
        // itself, and an empty string means "nothing honest to say yet".
        progress: progressFragment(elapsedS(), pendingChars).replace(/^ \(|\)$/g, ""),
      };
    }

    const compact: Record<string, unknown> = {
      item_id: item.id,
      status: "ready",
      language: `L${item.lang}`,
      name: item.name,
    };
    const hydration: Record<string, unknown> = {
      task_id: item.taskId,
      src: item.task.src,
      data,
      created: item.created,
      updated: item.updated,
    };
    applyViewAndClaim(hydration, ctx.auth, item.id, item.claimToken, ctx.clientKind);
    // Chat-facing summary. It now carries the item's CONTENT — rendered from the
    // same model the widget draws (item-content.ts) — not just a link. `data` is
    // already in hand here, so this costs no upstream call.
    //
    // What it still does not do is dump `src` or the raw `data` blob: the summary
    // is a description OF the item, so a model reading the transcript learns what
    // was made without being handed a language-private artifact it might try to
    // edit or forward. Widget hosts render from hydration and additionally get
    // this as their fallback if the widget never mounts.
    const summary = buildReadySummary(
      item.name,
      `L${item.lang}`,
      hydration.view_url as string,
      hydration.claim_message as string | undefined,
      { ...compact, ...hydration }
    );
    // The link is the deliverable, and saying so is load-bearing.
    //
    // `view_url` has always been a field and the summary has always led with a
    // markdown link, yet a Cowork transcript answered "Made a single-item MCQ on
    // frog metamorphosis…" and gave the user nothing to click. Nothing in the
    // result said the URL was for showing rather than for holding, so the model
    // treated it as metadata and wrote prose. The one thing already proven to
    // steer a model here is `message`: the generating path uses it to ask for a
    // render_item call and gets one essentially every time.
    //
    // It worked too well in one direction. On 2026-09-06 a user built a retirement
    // calculator through Codex and saw a bare URL; the summary in that same result
    // held the whole sheet as a markdown table, and the model dropped it, because
    // "a description is no substitute for the link" reads — to something choosing
    // what to show — as "the link is the deliverable and the description is not".
    // For a TERMINAL client, which can mount no widget, that summary is not a
    // preview of the product, it IS the product.
    //
    // So it asks for both and says what each is for, and the clause that prevents
    // the original prose-instead-of-link failure is kept as the LAST word, where it
    // forbids replacing the link rather than replacing the content.
    const linkDirective = buildLinkDirective(
      hydration.view_url as string,
      clientMountsWidget(ctx.clientKind, ctx.declaresUi),
    );
    const message = hydration.claim_message
      ? `${linkDirective}\n\n${hydration.claim_message as string}`
      : linkDirective;
    if (mode === "render") {
      // Widget-only, and deliberately not written by applyViewAndClaim: it must
      // not reach the chat-facing fields or get_item's raw output, or a model
      // could print the footer-attributed link and invert the attribution it
      // exists to measure. `_meta.graffiticode` is stripped for non-widget
      // clients, so this reaches exactly the surface it describes.
      const claimWidget = buildClaimFields(ctx.auth, item.claimToken, ctx.clientKind)?.claim_url_widget;
      if (claimWidget) hydration.claim_url_widget = claimWidget;
      return {
        ...compact,
        // Links are echoed as real fields, not only inside `summary`. Non-widget
        // clients get `_meta.graffiticode` stripped, so this is their only
        // addressable copy of the item's URL.
        view_url: hydration.view_url,
        ...(hydration.claim_url ? { claim_url: hydration.claim_url } : {}),
        ...(hydration.claim_message ? { claim_message: hydration.claim_message } : {}),
        message,
        summary,
        _meta: { graffiticode: hydration },
      };
    }
    return { ...compact, ...hydration, message, summary };
  }
}

/** Backward-compatible programmatic retrieval, including raw src/data. */
export async function handleGetItem(
  ctx: ToolContext,
  args: { item_id: string }
): Promise<unknown> {
  return handleItemResult(ctx, args, "raw");
}

/** Preferred user-facing retrieval with widget hydration isolated in `_meta`. */
export async function handleRenderItem(
  ctx: ToolContext,
  args: { item_id: string }
): Promise<unknown> {
  return handleItemResult(ctx, args, "render");
}

export async function handleGetSpec(
  ctx: ToolContext,
  args: { item_id: string }
): Promise<unknown> {
  const { item_id } = args;
  const result = await apiGetSpec({ auth: ctx.auth, id: item_id });
  // The spec leads with a blank line, and that is load-bearing rather than
  // cosmetic.
  //
  // This text exists to be pasted into create_item under one line of intent
  // ("Make a flashcard deck from this:"), and the console's scope gate splits
  // the ASK from pasted SOURCE at the first blank line — everything after it is
  // subject matter, not a request. A model that concatenates inline, which the
  // create_item description invites by saying to add "only your intent/target
  // framing", leaves no blank line at all, so the split lands inside the spec
  // and the ask inherits the other language's content. Measured 2026-09-17: a
  // flashcard request carrying a quiz spec rerouted L0181 -> L0180, and the
  // classifier's reason cited the pasted questions.
  //
  // Leading with the separator makes the boundary a property of the text rather
  // than of how carefully the caller assembled it: `"intent: " + spec` splits
  // correctly, and so does `"intent:\n\n" + spec`.
  const response: Record<string, unknown> = {
    item_id: result.itemId,
    language: `L${result.lang}`,
    spec: `\n\n${result.spec.replace(/^\s+/, "")}`,
  };
  // Surface (non-gating) fidelity telemetry so callers can see if the spec may
  // have elided authored content. Empty missing[] ⇒ full coverage.
  if (result.coverage && result.coverage.missing.length > 0) {
    response._meta = {
      coverage_missing: result.coverage.missing,
      coverage_checked: result.coverage.checked,
    };
  }
  return response;
}

/**
 * The oldest language `list_languages` will show. Everything below it is either
 * not a content-authoring target at all — `L0000` (root), `L0003` (primitives
 * demo), `L0010`/`L0013` (internal composition-planning and thumbnail dialects)
 * — or superseded: `L0158` is Learnosity's own catalog entry marking it legacy
 * in favour of `L0176`.
 *
 * The low ids sort first, so an agent asking what Graffiticode does met them
 * before the real catalog, and the funnel logs show real ChatGPT users doing
 * exactly that: `list_languages` → `get_language_info(L0000)` →
 * `get_language_info(L0010)` → gone, without ever creating anything.
 *
 * A FLOOR rather than a deny-list because ids are issued in order, so the next
 * language is discoverable the day it ships without an edit here. The cost is
 * that it is coarse — it cuts by age, not by whether a language still earns its
 * place — so it takes exceptions.
 */
const MIN_DISCOVERABLE_LANGUAGE = 166;

/**
 * Working languages below the floor that stay discoverable anyway.
 *
 * `L0159` (flashcards, match and memory) is one the product actively sells:
 * `SERVER_INSTRUCTIONS` names flashcards, and the live ChatGPT listing indexes
 * on the word. Hiding it would have left the directory recruiting people for a
 * capability discovery couldn't reach.
 *
 * L0152 (map questions), L0153 (area model) and L0154 (magic square) are also
 * working languages and are deliberately NOT here — they are below the floor
 * and stay hidden.
 */
const BELOW_FLOOR_KEEP = new Set(["0159"]);

/**
 * Languages above the floor that are hidden anyway — the floor's other exception.
 *
 * `L0172` (FigJam boards) generates real output, but landing it in FigJam takes a
 * human wiring up the Figma side; an agent that picks it hands the user something
 * they can't finish from chat. `L0174` (forms) is unfinished. `L0171` (Venn
 * diagrams) was withdrawn from discovery on 2026-08-25.
 *
 * All are hidden from discovery only. `get_language_info` and `create_item` still
 * answer for them, the same way they do for the sub-floor ids, so anything that
 * already holds the id keeps working.
 */
const ABOVE_FLOOR_HIDE = new Set(["0171", "0172", "0174"]);

/** Catalog ids are bare, zero-padded and numeric ("0166"); anything else can't be compared to the floor. */
function isDiscoverable(id: string): boolean {
  if (ABOVE_FLOOR_HIDE.has(id)) return false;
  if (BELOW_FLOOR_KEEP.has(id)) return true;
  const n = Number(id);
  return Number.isFinite(n) && n >= MIN_DISCOVERABLE_LANGUAGE;
}

export async function handleListLanguages(
  ctx: ToolContext,
  args: { domain?: string; search?: string }
): Promise<unknown> {
  const { domain, search } = args;
  // A search goes to the console, which ranks it: it splits the query into words, scores
  // names above keywords above prose, applies the vendor gate, and caps the list. Filtering
  // the cached catalog here instead matched the WHOLE search string as one substring, so
  // any phrase ("fetch csv data and summarize") returned nothing — the first list_languages
  // call of every ChatGPT session observed on 2026-10-04 came back empty and had to be
  // retried. (Searches were moved client-side when the console's search fanned out to every
  // language server and timed out; it no longer does — it scores static catalog data.)
  // listLanguages caches each search and, past its deadline, answers with the last full
  // catalog, so a slow console degrades to "everything" rather than to an error.
  const trimmed = search?.trim();
  const languages = trimmed
    ? await apiListLanguages({ auth: ctx.auth, search: trimmed })
    : await apiListLanguages({ auth: ctx.auth });

  return {
    languages: languages
      .filter(lang => isDiscoverable(lang.id))
      .filter(lang => !domain || lang.domains?.includes(domain))
      .map(lang => ({
        id: `L${lang.id}`,
        name: lang.name,
        description: lang.description,
        ...(lang.routingHint ? { when_to_use: lang.routingHint } : {}),
        domains: lang.domains,
      })),
  };
}

export async function handleGetLanguageInfo(
  ctx: ToolContext,
  args: { language: string }
): Promise<unknown> {
  const info = await apiGetLanguageInfo({
    auth: ctx.auth,
    language: args.language,
  });

  if (!info) {
    throw new Error(`Language not found: ${args.language}`);
  }

  return {
    id: `L${info.id}`,
    name: info.name,
    description: info.description,
    ...(info.routingHint ? { when_to_use: info.routingHint } : {}),
    domains: info.domains,
    authoring_guide: info.authoringGuide ?? null,
    supported_item_types: info.supportedItemTypes ?? [],
    // The scope's negative half is the strongest anti-signal the catalog has —
    // it is the only text that tells an agent when NOT to pick this language.
    not_for: info.scope?.outOfScope ?? [],
    example_prompts: info.examplePrompts ?? [],
    user_guide_resource: `graffiticode://language/L${info.id}/user-guide`,
    spec_url: info.specUrl,
  };
}

// Tool handler router
export async function handleToolCall(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case "create_item":
      return handleCreateItem(ctx, args as { language: string; description: string; name?: string });
    case "update_item":
      return handleUpdateItem(ctx, args as { item_id: string; modification: string });
    case "render_item":
      return handleRenderItem(ctx, args as { item_id: string });
    case "get_item":
      return handleGetItem(ctx, args as { item_id: string });
    case "get_spec":
      return handleGetSpec(ctx, args as { item_id: string });
    case "list_languages":
      return handleListLanguages(ctx, args as { domain?: string; search?: string });
    case "get_language_info":
      return handleGetLanguageInfo(ctx, args as { language: string });
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

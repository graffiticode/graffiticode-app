// The operations the MCP server exposes, one tool each, and what each may do.
//
// OpenAI's app review requires every model-callable operation to be its own
// tool, and forbids a generic executor that selects operations the reviewer
// can't see. So the MCP server no longer has `create_item(language, …)`: each
// content type has its own create tool, and the operations that used to hide
// inside `update_item` (recording a survey response, saving to a Learnosity
// item bank) are tools of their own.
//
// This table is the single source for that boundary. The MCP server builds its
// tool list from it, and core enforces it, in the reservation transaction,
// against the same item snapshot the job is reserved from, so a check made
// earlier by a caller can never be raced past.
//
// An operation reaches core only from the in-process MCP backend
// (mcp-server/src/core-backend.ts), as a separate `trusted` argument that no
// GraphQL or REST caller passes. A job reserved with one is RESTRICTED:
//   - it never writes to an external system (the envelope's externalWrites is
//     false, so the worker records no connection write);
//   - its language is pinned (the scope gate refuses a wrong-tool request
//     rather than switching languages);
//   - its composition is limited to the operation's own upstreams, with no
//     exception for upstreams an existing item already uses.
import { ConflictError } from "./errors.js";

/** Create tools: one per content language. */
export const CREATE_OPERATIONS = {
  create_ela_assessment: "0175",
  create_learnosity_item: "0176",
  plan_learnosity_author_integration: "0177",
  plan_learnosity_data_job: "0178",
  create_spreadsheet: "0179",
  create_quiz: "0180",
  create_flashcards: "0181",
  create_survey: "0182",
  create_concept_web: "0183",
  create_chart: "0184",
  fetch_data: "0185",
  create_figjam_board: "0186",
} as const;

export type CreateOperation = keyof typeof CREATE_OPERATIONS;
export type Operation = CreateOperation | "update_item" | "respond_to_survey" | "save_to_learnosity_item_bank";

const SURVEY_LANG = "0182";

/**
 * The head languages each operation may act on. A POSITIVE list everywhere:
 * `update_item` takes the content languages the create tools make, minus the
 * survey (an L0182 item is a response record, so revising it IS recording a
 * response). Internal, hidden and deprecated languages are on no list, so no
 * tool edits them.
 */
export const OPERATION_LANGS: Record<Operation, readonly string[]> = {
  ...(Object.fromEntries(Object.entries(CREATE_OPERATIONS).map(([op, lang]) => [op, [lang]])) as Record<CreateOperation, string[]>),
  update_item: Object.values(CREATE_OPERATIONS).filter((lang) => lang !== SURVEY_LANG),
  respond_to_survey: [SURVEY_LANG],
  save_to_learnosity_item_bank: ["0176"],
};

/**
 * The upstream languages a restricted job may compose with, by head language.
 * Mirrors the declared `composesWith` edges the tools describe (L0176 embeds
 * spreadsheets and concept webs; a chart may chart fetched data). Everything
 * else is atomic. Saving to Learnosity is narrower still: a fetch would be a
 * public network read under a tool that declares none.
 */
const UPSTREAMS_BY_HEAD: Record<string, readonly string[]> = {
  "0176": ["0179", "0183"],
  "0184": ["0185"],
};

export function permittedUpstreams(operation: Operation, headLang: string): readonly string[] {
  if (operation === "save_to_learnosity_item_bank") return ["0179", "0183"];
  if (operation === "respond_to_survey") return [];
  return UPSTREAMS_BY_HEAD[bare(headLang)] ?? [];
}

const bare = (lang: string) => String(lang ?? "").replace(/^L/i, "");

export const isOperation = (value: unknown): value is Operation =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(OPERATION_LANGS, value);

/** The create tool that makes `lang`, or null. */
export function createOperationFor(lang: string): CreateOperation | null {
  const id = bare(lang);
  const entry = Object.entries(CREATE_OPERATIONS).find(([, l]) => l === id);
  return entry ? (entry[0] as CreateOperation) : null;
}

/** Refuses an operation on a language it doesn't cover, naming the right tool. */
export function assertOperationPermits(operation: Operation, lang: string): void {
  const id = bare(lang);
  if (OPERATION_LANGS[operation].includes(id)) return;
  let hint: string;
  if (operation === "update_item" && id === SURVEY_LANG) {
    hint = "Use respond_to_survey to record a survey response.";
  } else if (operation === "update_item") {
    hint = "This item's language isn't editable from here.";
  } else {
    const right = createOperationFor(id);
    hint = right ? `This is an L${id} item; use ${right} for this content.` : `This tool doesn't apply to L${id} items.`;
  }
  throw new ConflictError("operation_not_permitted", `${operation} can't act on this item. ${hint}`);
}

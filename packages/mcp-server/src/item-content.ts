/**
 * What an item actually contains, extracted once and rendered twice.
 *
 * This logic used to live only in the widget (`cardBody` in
 * `widget/browser/renderer.ts`), which meant it reached Claude and nobody else. A
 * ChatGPT user's whole experience of a finished item was one line — a name, a
 * language, and a link — because the hydration payload carrying `data` is stripped
 * for hosts that render no widget. An OpenAI reviewer could not check a single
 * documented outcome without leaving the conversation, and said so.
 *
 * So the extraction is separated from the presentation. `describeItem` turns an
 * item's compiled `data` into a small content model; the widget renders that model
 * as DOM, and `contentToMarkdown` renders the same model into the tool result's
 * text, where every client can see it. One extraction, two emitters — a shape that
 * renders in the widget but reads as a blank line in the transcript is now a thing
 * that cannot happen.
 *
 * Deliberately DOM-free and dependency-free: it is compiled by `tsc` for the server
 * (whose `lib` is ES2022, with no DOM types at all) and bundled by esbuild for the
 * browser. Keep it that way — the moment this file touches `document`, the server
 * half stops compiling.
 */

/** The two halves of a tool result the widget sees. Structural, so the browser's
 *  `ToolResult` satisfies it without importing anything from this module's side. */
export interface ToolPayload {
  structuredContent: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface QuestionSummary {
  stimulus: string;
  /**
   * The sentence of a fill-in-the-blank item, each blank shown as `_____`.
   *
   * A cloze has no options: its content IS this sentence, and its answer key is
   * what goes in the blanks. Without it the item rendered as its instruction alone
   * ("Complete the sentence about the water cycle.") — no sentence, no blank, no
   * answer — on a card whose whole job is to show the answer key.
   */
  template?: string;
  options: { label: string; correct: boolean }[];
}

export interface TableContent {
  kind: "table";
  sheetName?: string;
  headers: string[];
  rows: string[][];
  /** Data rows in the sheet, before the display cap. */
  totalRows: number;
  /** Sheets in the workbook; >1 means the table below is only the first. */
  totalSheets: number;
}

export interface ChartContent {
  kind: "chart";
  chartType?: string;
  title?: string;
  categories: string[];
  series: { name?: string; values: string[] }[];
}

export interface ConceptWebContent {
  kind: "conceptweb";
  topic?: string;
  instructions?: string;
  concepts: string[];
  links: { from: string; to: string; label?: string }[];
  /**
   * The draggable options, when the web is an ASSESSMENT rather than a finished
   * diagram. These are what the learner sees in the tray, so they are safe to
   * describe; which one belongs in which node is the answer key and is not.
   */
  tray?: string[];
  /** How many nodes the learner has to fill. Only set alongside `tray`. */
  blanks?: number;
}

export type ItemContent =
  | { kind: "questions"; count: number; shown: QuestionSummary[] }
  | TableContent
  | ChartContent
  | ConceptWebContent
  | { kind: "prose"; text: string }
  | { kind: "preview"; json: string }
  | { kind: "empty" };

/** How many questions to show before saying "and N more". The rest is one line. */
const QUESTIONS_SHOWN = 8;
/** Options listed per question. Bounds a hottext passage's unit list. */
const OPTIONS_SHOWN = 12;
/** A spec document is the item; show enough to judge it, not the whole thing. */
const PROSE_CAP = 4000;
/** The generic JSON preview. Widget-only — see contentToMarkdown. */
const PREVIEW_CAP = 2000;
/** Table display caps. Enough to show the shape and judge the content. */
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLS = 8;
/** Chart categories and concept-web edges: enough to read the thing, not all of it. */
const MAX_SERIES_POINTS = 12;
const MAX_LINKS = 12;

/**
 * Whether a result status is the LAST word on an item.
 *
 * Only "generating" is non-terminal. This exists as its own exported predicate
 * because getting it wrong is invisible and expensive: the widget used to latch
 * on the first result of any kind, and `render_item` returns
 * `{ status: "generating" }` whenever its own poll deadline expires — so a slow
 * item rendered "Generating…" and then ignored the `ready` that followed, with no
 * error and no way out but a reload.
 *
 * An ABSENT status counts as terminal. A ready result carries `status: "ready"`
 * today, but older payloads and the raw get_item shape omit it, and treating
 * "no status" as non-terminal would leave those waiting forever for a second
 * delivery that never comes. Erring toward terminal costs at most a missed
 * re-render; erring the other way is the bug this replaced.
 */
export function isTerminalStatus(status?: string): boolean {
  return status !== "generating";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeLang(lang: unknown): string {
  return `L${String(lang ?? "").replace(/^[lL]/, "")}`;
}

/** Merge the model-visible result with the namespaced widget hydration payload. */
export function mergeToolPayload(r: ToolPayload): Record<string, unknown> {
  const namespaced = isRecord(r.meta.graffiticode) ? r.meta.graffiticode : r.meta;
  return { ...r.structuredContent, ...namespaced };
}

/** Compiled data arrives wrapped in a `{ data, errors }` envelope for some langs. */
export function unwrapData(raw: unknown): unknown {
  if (isRecord(raw) && ("data" in raw || "errors" in raw)) return raw.data;
  return raw;
}

/** "B12" -> { col: "B", row: 12 }. Anything else is not a cell address. */
function parseCellRef(ref: string): { col: string; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return m ? { col: m[1], row: Number(m[2]) } : null;
}

/** Spreadsheet column order: A..Z, then AA.. — length first, then alphabetical. */
function compareCols(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

/**
 * Find the cell map in a compiled spreadsheet, wherever the dialect puts it.
 *
 * Written this way because the first attempt guessed `data.sheets[].cells` from a
 * log excerpt and shipped: L0179 actually compiles a single table to
 * `data.interaction.cells`, so the branch never fired against a real item and
 * spreadsheets went out with no content at all. Rather than swap one guess for
 * another, this probes the known containers and VERIFIES the result really is
 * cell-address-keyed before accepting it — a container that doesn't hold cells is
 * not a match, so a wrong guess degrades to the next candidate instead of to
 * nonsense.
 */
function findCellMap(data: Record<string, unknown>): {
  cells: Record<string, unknown>;
  name?: string;
  totalSheets: number;
} | null {
  const looksLikeCells = (v: unknown): v is Record<string, unknown> =>
    isRecord(v) && Object.keys(v).some((k) => parseCellRef(k) !== null);

  const interaction = isRecord(data.interaction) ? data.interaction : undefined;
  if (looksLikeCells(interaction?.cells)) {
    return { cells: interaction!.cells as Record<string, unknown>, totalSheets: 1 };
  }
  if (looksLikeCells(data.cells)) {
    return { cells: data.cells as Record<string, unknown>, totalSheets: 1 };
  }
  if (Array.isArray(data.sheets)) {
    const sheets = data.sheets.filter(isRecord);
    const first = sheets.find((sh) => looksLikeCells(sh.cells));
    if (first) {
      return {
        cells: first.cells as Record<string, unknown>,
        name: typeof first.name === "string" ? first.name : undefined,
        totalSheets: sheets.length,
      };
    }
  }
  return null;
}

/**
 * Turn a compiled cell map into a table.
 *
 * Cells are keyed by address (`{ A1: { text }, … }`), which is a rendering detail
 * and not something a reader should ever be shown. Row 1 is treated as the header
 * — the convention these languages generate — and when that doesn't hold the first
 * row merely reads as a header, a far smaller error than printing the raw object.
 */
function cellsToTable(
  cells: Record<string, unknown>,
  sheetName: string | undefined,
  totalSheets: number
): TableContent | null {

  const byRow = new Map<number, Map<string, string>>();
  const cols = new Set<string>();
  for (const [ref, cell] of Object.entries(cells)) {
    const at = parseCellRef(ref);
    if (!at) continue;
    const text = isRecord(cell) ? String(cell.text ?? "") : String(cell ?? "");
    if (!byRow.has(at.row)) byRow.set(at.row, new Map());
    byRow.get(at.row)!.set(at.col, text);
    cols.add(at.col);
  }
  if (!byRow.size) return null;

  const orderedCols = [...cols].sort(compareCols).slice(0, MAX_TABLE_COLS);
  const orderedRows = [...byRow.keys()].sort((a, b) => a - b);
  const readRow = (r: number) => orderedCols.map((c) => byRow.get(r)?.get(c) ?? "");

  // Row 1 is the header ONLY when it reads like one.
  //
  // Taking it unconditionally is right for a sheet laid out as a table with column
  // captions, and wrong for the other common spreadsheet shape: a label/value form,
  // where the rows are `Current Savings | 100000`. A user's retirement calculator
  // came back with "Current Savings" as a column heading and its first input row
  // silently promoted out of the data — the numbers were all there, one row short
  // and captioned by an input name.
  //
  // The test is deliberately weak in the safe direction: a header is a row with
  // some text in it and NO cell that is a number, a currency/percent figure, or a
  // formula. Captions are words; values are not. A row of words that is really data
  // still reads as a header, which is the status quo, while any row carrying a
  // figure now keeps its place.
  const first = readRow(orderedRows[0]);
  const hasHeader = looksLikeHeaderRow(first);
  const dataRowKeys = hasHeader ? orderedRows.slice(1) : orderedRows;
  return {
    kind: "table",
    sheetName,
    // Markdown needs a header row to render a table at all, so a headerless sheet
    // gets an empty one rather than a caption invented from its own data.
    headers: hasHeader ? first : orderedCols.map(() => ""),
    rows: dataRowKeys.slice(0, MAX_TABLE_ROWS).map(readRow),
    totalRows: dataRowKeys.length,
    totalSheets,
  };
}

/** A number, currency amount, percentage, or formula — i.e. a value, not a caption. */
function looksLikeValue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("=")) return true;
  return /^[-+(]?\s*[$£€]?\s*[\d,]+(\.\d+)?\s*%?\)?$/.test(t);
}

/** Does this row read as column captions rather than data? */
function looksLikeHeaderRow(cells: string[]): boolean {
  const filled = cells.filter((c) => c.trim() !== "");
  if (!filled.length) return false;
  return !filled.some(looksLikeValue);
}

/**
 * Describe an item from its compiled `data`.
 *
 * `sc` is the merged payload (structuredContent + hydration), so this reads `data`
 * and, for the spec language, falls back to `spec`/`src`. Shapes were verified
 * against the language compilers; the fallback chains inside each branch are load
 * bearing (a question's text is `stimulus` OR `prompt`, an option's is `label` OR
 * `value`, and Learnosity spells its answer key both `valid-response` and
 * `validResponse` depending on vintage).
 */
/**
 * The correct option ids for one compiled L0180 interaction.
 *
 * Mirrors `correctIds` in `@graffiticode/l0180-view` deliberately: a
 * `match_correct` key carries `correctResponse`, a `map_response` key carries
 * `mapping`, and neither carries the other. Reading only one of the two would
 * silently mark every option wrong for half of all items.
 */
function l0180CorrectIds(validation: unknown): Set<string> {
  if (!isRecord(validation)) return new Set();
  if (Array.isArray(validation.correctResponse)) {
    return new Set(validation.correctResponse.map(String));
  }
  const mapping = isRecord(validation.mapping) ? validation.mapping : {};
  return new Set(
    Object.keys(mapping).filter((id) => {
      const entry = mapping[id];
      return isRecord(entry) && entry.correct === true;
    })
  );
}

/**
 * One interaction → one question line. A choice carries `options`; a hottext
 * carries `units`, one per selectable word or sentence — which is why the list is
 * capped: a passage's worth of units is a wall of text in a chat message, and the
 * ✓ marks that matter are near the top of it either way.
 */
function l0180Question(
  interaction: Record<string, unknown>,
  validation: unknown
): QuestionSummary {
  const correct = l0180CorrectIds(validation);
  const raw = Array.isArray(interaction.options)
    ? interaction.options
    : Array.isArray(interaction.units)
      ? interaction.units
      : [];
  const options = raw
    .filter(isRecord)
    .map((o) => ({
      label: String(o.text ?? o.label ?? "").trim(),
      correct: correct.has(String(o.id)),
    }))
    .filter((o) => o.label)
    .slice(0, OPTIONS_SHOWN);
  return {
    stimulus: String(interaction.prompt ?? "").trim() || "(question)",
    options,
  };
}

/**
 * An L0180 item as a question list, or null when it carries nothing to show.
 *
 * `type: "item"` is the multi-part wrapper: its `parts` are interactions in their
 * own right and its answer key is keyed by part id, so each part reads as one
 * question. Anything else is a single interaction scored by the key directly.
 */
function l0180Questions(
  interaction: Record<string, unknown>,
  validation: unknown
): ItemContent | null {
  if (interaction.type === "item") {
    const parts = Array.isArray(interaction.parts) ? interaction.parts.filter(isRecord) : [];
    if (!parts.length) return null;
    const keys = isRecord(validation) && isRecord(validation.parts) ? validation.parts : {};
    return {
      kind: "questions",
      count: parts.length,
      shown: parts
        .slice(0, QUESTIONS_SHOWN)
        .map((part) => l0180Question(part, keys[String(part.id)])),
    };
  }
  const question = l0180Question(interaction, validation);
  // A shape we recognised but that says nothing is worse than falling through to
  // the branches below, which may still find something.
  if (!question.options.length && question.stimulus === "(question)") return null;
  return { kind: "questions", count: 1, shown: [question] };
}

/**
 * L0182 surveys: `data = { survey: { name, title?, ideas, minChoices, maxChoices }, response? }`.
 *
 * Matched on SHAPE rather than language id, like the branches around it, so a future dialect
 * compiling to the same form reads correctly with no entry here.
 *
 * Rendered as prose rather than a new ItemContent kind: a survey is not a set of questions, so
 * what is worth saying is what there is to choose between and what was chosen — a sentence,
 * plus the ideas themselves, which unlike every earlier version of this language ARE in the
 * item. (They used to be drawn from a live pool at delivery, which is why this branch once had
 * nothing but item kinds to report.)
 */
function l0182Survey(survey: Record<string, unknown>, response: unknown): ItemContent | null {
  const ideas = survey.ideas;
  if (!Array.isArray(ideas) || !ideas.length) return null;

  const texts = ideas.map((i) => (isRecord(i) && typeof i.text === "string" ? i.text : ""));
  if (!texts.some(Boolean)) return null;
  const byId = new Map(
    ideas
      .filter(isRecord)
      .map((i) => [String(i.id ?? ""), typeof i.text === "string" ? i.text : ""] as const),
  );

  const title = typeof survey.title === "string" ? survey.title : null;
  const name = typeof survey.name === "string" ? survey.name : null;
  const label = title ? `"${title}"` : name ? `"${name}"` : null;

  const lines: string[] = [
    label
      ? `Survey: ${label} — ${ideas.length} ideas to choose between.`
      : `Survey: ${ideas.length} ideas to choose between.`,
  ];

  const min = typeof survey.minChoices === "number" ? survey.minChoices : null;
  const max = typeof survey.maxChoices === "number" ? survey.maxChoices : null;
  if (min !== null && max !== null) {
    lines.push(
      min === max
        ? `Choose ${min} of ${ideas.length}, in priority order.`
        : `Choose ${min}–${max} of ${ideas.length}, in priority order.`,
    );
  }

  // The ideas themselves. The cap is generous rather than tidy: an agent is instructed to TAKE
  // a survey it is given, and it chooses by naming an idea's exact text — so an idea elided here
  // is one it cannot pick. Bounded all the same, because PROSE_CAP truncates from the end and
  // would otherwise eat the response below.
  const shown = texts.filter(Boolean).slice(0, 30);
  lines.push(...shown.map((t) => `- ${t}`));
  if (texts.length > shown.length) lines.push(`…and ${texts.length - shown.length} more.`);

  if (!isRecord(response)) {
    lines.push("No response yet.");
    return { kind: "prose", text: lines.join("\n").slice(0, PROSE_CAP) };
  }

  const selection = Array.isArray(response.selection) ? response.selection.map(String) : [];
  lines.push(
    selection.length
      ? `Chosen, most important first: ${selection.map((id) => byId.get(id) ?? id).join("; ")}.`
      : "Nothing chosen.",
  );
  if (typeof response.idea === "string" && response.idea) {
    lines.push(`Contributed a new idea: ${response.idea}`);
  }

  return { kind: "prose", text: lines.join("\n").slice(0, PROSE_CAP) };
}

/**
 * L0181 flashcard decks: `data = { title?, instructions?, cards: [{ id, front, back }] }`.
 *
 * Matched on SHAPE, like the branches around it. Without this a deck fell through to `preview`,
 * so the widget card showed its JSON and chat showed nothing but a title and a link.
 */
function flashcardDeck(data: Record<string, unknown>): ItemContent | null {
  const cards = Array.isArray(data.cards) ? data.cards.filter(isRecord) : [];
  const pairs = cards
    .map((c) => [typeof c.front === "string" ? c.front : "", typeof c.back === "string" ? c.back : ""])
    .filter(([front, back]) => front || back);
  if (!pairs.length) return null;

  const title = typeof data.title === "string" && data.title ? `"${data.title}"` : null;
  const lines: string[] = [
    title ? `Flashcards: ${title} — ${pairs.length} cards.` : `Flashcards: ${pairs.length} cards.`,
  ];
  if (typeof data.instructions === "string" && data.instructions) lines.push(data.instructions);
  lines.push(...pairs.map(([front, back]) => `- ${front} → ${back}`));
  return { kind: "prose", text: lines.join("\n").slice(0, PROSE_CAP) };
}

/**
 * L0183 concept webs: `data = { title?, instructions?, interaction: { type: "concept-web", hub,
 * nodes, edges, cells }, validation: { cells: { <id>: { assess: { expected } } } } }`.
 *
 * Matched on `interaction.type`, and checked BEFORE the L0180 single-item branch, which also
 * reads `data.interaction` and would otherwise claim a web as a question with no options. A
 * blank's answer is shown in brackets, the way a ✓ marks the answer key elsewhere.
 */
function conceptWeb(data: Record<string, unknown>): ItemContent | null {
  const web = isRecord(data.interaction) ? data.interaction : undefined;
  if (!web || web.type !== "concept-web") return null;
  const key = isRecord(data.validation) && isRecord(data.validation.cells) ? data.validation.cells : {};
  const expected = (id: string): string => {
    const cell = key[id];
    const assess = isRecord(cell) && isRecord(cell.assess) ? cell.assess : undefined;
    return typeof assess?.expected === "string" ? assess.expected : "?";
  };
  const node = (n: unknown): string => {
    if (!isRecord(n)) return "?";
    if (n.blank) return `[blank: ${expected(String(n.id))}]`;
    return typeof n.text === "string" ? n.text : String(n.id ?? "?");
  };
  const nodes = Array.isArray(web.nodes) ? web.nodes : [];
  const names = new Map<string, string>([[ "hub", node(web.hub) ], ...nodes.filter(isRecord).map((n) => [String(n.id), node(n)] as [string, string])]);
  const edges = (Array.isArray(web.edges) ? web.edges : []).filter(isRecord);
  const labelled = edges.filter((e) => e.blank || typeof e.label === "string");
  const blanks = Object.keys(key).length;

  const title = typeof data.title === "string" && data.title ? `"${data.title}"` : null;
  const lines: string[] = [
    `Concept web${title ? `: ${title}` : ""} — ${node(web.hub)} with ${nodes.length} nodes around it` +
      (blanks ? `, ${blanks} blanks to fill.` : "."),
  ];
  if (typeof data.instructions === "string" && data.instructions) lines.push(data.instructions);
  lines.push(...nodes.map((n) => `- ${node(n)}`));
  for (const e of labelled) {
    const label = e.blank ? `[blank: ${expected(String(e.id))}]` : String(e.label);
    lines.push(`- ${names.get(String(e.from)) ?? e.from} —${label}→ ${names.get(String(e.to)) ?? e.to}`);
  }
  return { kind: "prose", text: lines.join("\n").slice(0, PROSE_CAP) };
}

export function describeItem(lang: string, sc: Record<string, unknown>): ItemContent {
  const unwrapped = unwrapData(sc.data);
  const data = isRecord(unwrapped) ? unwrapped : undefined;

  // Learnosity assessments: data = { type, request: { questions: [...] } }.
  if ((lang === "L0158" || lang === "L0176") && data) {
    const request = data.request as { questions?: unknown[] } | undefined;
    const questions = Array.isArray(request?.questions) ? request!.questions : [];
    if (questions.length) {
      const shown = questions.slice(0, QUESTIONS_SHOWN).map((q): QuestionSummary => {
        const qq = q as Record<string, unknown>;
        // Stimulus is authored as HTML; the tags are markup, not content, and
        // survive into neither a card nor a chat message intelligibly.
        const stimulus = String(qq.stimulus ?? qq.prompt ?? "")
          .replace(/<[^>]+>/g, "")
          .trim();
        // The answer key has moved: current L0176 payloads nest it as
        // `validation.valid_response`, while this looked only at the top level. So
        // nothing was ever marked correct and the ✓ — the whole point of the
        // summary for anyone checking the item — never appeared. Starter prompt 3
        // in the ChatGPT listing says "answers marked"; it was not true.
        const validation = isRecord(qq.validation) ? qq.validation : undefined;
        const valid = (qq["valid-response"] ??
          qq.validResponse ??
          validation?.["valid_response"] ??
          validation?.validResponse) as Record<string, unknown> | undefined;
        const correct = new Set(
          Array.isArray(valid?.value) ? (valid!.value as unknown[]).map(String) : []
        );
        const opts = qq.options as Array<Record<string, unknown>> | undefined;
        // A cloze (`clozetext`, `clozedropdown`, …) carries its content in a
        // `template` with a `{{response}}` per blank, and its answer key in
        // `valid_response.value` — one accepted answer per blank, in order. It has
        // no `options`, so the branch below produced an item that was all
        // instruction and no substance. The accepted answers are listed as
        // correct options so every renderer marks them ✓ with no new code path.
        const template =
          typeof qq.template === "string"
            ? qq.template.replace(/<[^>]+>/g, "").replace(/\{\{response\}\}/g, "_____").trim()
            : undefined;
        const answers = Array.isArray(valid?.value) ? (valid!.value as unknown[]).map(String) : [];
        return {
          stimulus: stimulus || "(question)",
          ...(template ? { template } : {}),
          options: Array.isArray(opts)
            ? opts.map((o) => ({
                label: String(o.label ?? o.value ?? ""),
                correct: correct.has(String(o.value)),
              }))
            : template
              ? answers.map((a) => ({ label: a, correct: true }))
              : [],
        };
      });
      return { kind: "questions", count: questions.length, shown };
    }
  }

  // L0182 surveys: `data = { survey: { ideas, … }, response? }`.
  if (data && isRecord(data.survey)) {
    const survey = l0182Survey(data.survey, data.response);
    if (survey) return survey;
  }

  // L0183 concept webs — before any branch that reads `data.interaction` as a question.
  if (data && isRecord(data.interaction) && data.interaction.type === "concept-web") {
    const web = conceptWeb(data);
    if (web) return web;
  }

  // L0181 flashcard decks: `data = { cards: [{ front, back }], … }`.
  if (data && Array.isArray(data.cards)) {
    const deck = flashcardDeck(data);
    if (deck) return deck;
  }

  // A multi-item L0180 ACTIVITY: `data = { activity: { items: [{ interaction, validation }] } }`.
  //
  // This is what "make me a 5-question quiz" compiles to, and it was falling through
  // every branch to `preview` — which chat suppresses — so the catalog's general
  // assessment language, the one the whole generic-quiz gap was closed to reach,
  // answered a five-question quiz with a title and a link. The single-item branch
  // below has existed for a while and hid it: a one-item payload read correctly, so
  // the language looked covered.
  //
  // Each entry carries its own interaction and validation, exactly like the single
  // item, so the per-question extractor is reused rather than reimplemented and a
  // quiz reads the way one item does.
  if (data && isRecord(data.activity)) {
    const items = Array.isArray(data.activity.items)
      ? data.activity.items.filter(isRecord)
      : [];
    const shown = items
      .slice(0, QUESTIONS_SHOWN)
      .map((it) =>
        isRecord(it.interaction) ? l0180Question(it.interaction, it.validation) : null
      )
      .filter((q): q is QuestionSummary => q !== null);
    if (shown.length) return { kind: "questions", count: items.length, shown };
  }

  // L0180 assessment items: `data = { interaction, validation }`.
  //
  // Matched on SHAPE rather than language id, like the spreadsheet branch below,
  // so a future dialect compiling to the same form reads correctly with no entry
  // here. Without this branch L0180 fell through to `preview`, and `preview` is
  // deliberately empty in chat — so the single most-used assessment language
  // produced a summary consisting of a title and a link, and a model relaying it
  // could say nothing more specific than "I made a thing".
  if (data && isRecord(data.interaction)) {
    const questions = l0180Questions(data.interaction, data.validation);
    if (questions) return questions;
  }

  // Spec doc: the item IS prose.
  if (lang === "L0177") {
    const text = String((data?.print ?? sc.spec ?? sc.src ?? "") || "");
    if (text) return { kind: "prose", text: text.slice(0, PROSE_CAP) };
  }

  // Charts compile to an ECharts `option`. A category axis plus one or more series
  // IS a table — the same numbers the picture draws — so it is presented as one
  // rather than described in the abstract ("a bar chart with 4 points" tells a
  // reader nothing they can check).
  if (data && data.type === "chart" && isRecord(data.option)) {
    const option = data.option;
    const xAxis = isRecord(option.xAxis) ? option.xAxis : undefined;
    const categories = Array.isArray(xAxis?.data) ? xAxis!.data.map(String) : [];
    const rawSeries = Array.isArray(option.series) ? option.series : [];
    const series = rawSeries.filter(isRecord).map((sr) => ({
      name: typeof sr.name === "string" ? sr.name : undefined,
      values: Array.isArray(sr.data) ? sr.data.map((v) => (v == null ? "" : String(v))) : [],
    }));
    if (series.some((sr) => sr.values.length)) {
      const title = isRecord(option.title) && typeof option.title.text === "string"
        ? option.title.text
        : undefined;
      const chartType = series.find((_, i) => isRecord(rawSeries[i]))
        ? (rawSeries.find(isRecord) as Record<string, unknown>).type
        : undefined;
      return {
        kind: "chart",
        chartType: typeof chartType === "string" ? chartType : undefined,
        title,
        categories: categories.slice(0, MAX_SERIES_POINTS),
        series: series.map((sr) => ({ ...sr, values: sr.values.slice(0, MAX_SERIES_POINTS) })),
      };
    }
  }

  // Concept webs: an anchor, its connected concepts, and labelled edges between
  // them. The labels carry the actual teaching content, so they are the point.
  if (data && isRecord(data.conceptWeb)) {
    const web = data.conceptWeb;
    const anchor = isRecord(web.anchor) ? String(web.anchor.text ?? web.anchor.value ?? "") : "";
    const connections = Array.isArray(web.connections)
      ? web.connections.filter(isRecord).map((c) => String(c.text ?? c.value ?? "")).filter(Boolean)
      : [];
    const edges = Array.isArray(web.edges) ? web.edges.filter(isRecord) : [];
    const links = edges
      // `to: "*"` is the anchor's radial fan-out — layout, not content.
      .filter((e) => e.to !== "*")
      .slice(0, MAX_LINKS)
      .map((e) => ({
        from: String(e.from ?? ""),
        to: String(e.to ?? ""),
        label: typeof e.text === "string" && e.text ? e.text : undefined,
      }));
    const topic = (typeof web.topic === "string" && web.topic) || anchor || undefined;
    const instructions = typeof web.instructions === "string" ? web.instructions : undefined;
    if (connections.length || links.length) {
      return { kind: "conceptweb", topic, instructions, concepts: connections, links };
    }

    // An ASSESSMENT web describes itself entirely differently, and the code above
    // reads it as empty. Its node `text` fields are blank ON PURPOSE — that is the
    // blank the learner fills — the expected answers live in `assess.expected`, and
    // the draggable options live in `concepts`. So every string the extractor looked
    // at was "", the early return never fired, and `render_item` returned a title and
    // a link and nothing else. The widget hides that (it mounts the real component),
    // which is why it survived: it only shows on a client that has nothing but text.
    //
    // The tray is described and the mapping is not. The tray is what the learner is
    // shown; which concept belongs in which node is the answer key, and summaries of
    // other assessment languages don't print those either.
    const tray = Array.isArray(web.concepts)
      ? web.concepts
          .map((c) => (isRecord(c) ? String(c.value ?? c.text ?? "") : String(c ?? "")))
          .filter(Boolean)
      : [];
    const assessed = Array.isArray(web.connections)
      ? web.connections.filter((c) => isRecord(c) && isRecord(c.assess)).length
      : 0;
    const anchorAssessed = isRecord(web.anchor) && isRecord(web.anchor.assess) ? 1 : 0;
    const blanks = assessed + anchorAssessed;
    if (tray.length || blanks) {
      return {
        kind: "conceptweb",
        topic,
        instructions,
        concepts: [],
        links,
        tray: tray.length ? tray : undefined,
        blanks: blanks || undefined,
      };
    }
  }

  // Spreadsheets. Matched on SHAPE rather than language id, so L0166, its
  // successor L0179, and any future cell-addressed dialect all read correctly
  // without an entry here.
  if (data) {
    const found = findCellMap(data);
    if (found) {
      const table = cellsToTable(found.cells, found.name, found.totalSheets);
      if (table) return table;
    }
  }

  // Everything else. `preview` is a WIDGET-only shape — contentToMarkdown refuses
  // to put it in chat. See the note there.
  if (data) return { kind: "preview", json: JSON.stringify(data, null, 2).slice(0, PREVIEW_CAP) };
  return { kind: "empty" };
}

/** Markdown table cells are pipe-delimited, so a pipe in the data ends the cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/**
 * Render the content model as Markdown, for the tool result's text block.
 *
 * Every client renders this — it is the one representation guaranteed to arrive,
 * so it is also the fallback when a widget fails to mount.
 *
 * `preview` returns "" ON PURPOSE. It is a raw `JSON.stringify` of the compiled
 * data, which is a fine last resort inside a scrollable panel in the widget and is
 * never acceptable in a chat message: a real spreadsheet's compiled form is mostly
 * hex fills and column widths, and it would reach the user as a wall of machine
 * output. A title and a link say less but do not insult the reader. So chat gets
 * content only where we can present it as content — questions, a table, prose —
 * and the dump stays behind in the widget where the shape came from.
 *
 * `empty` returns "" for the same reason: the caller already prints a title and a
 * link, and "no content" is better said by absence than by a line of apology.
 */
export function contentToMarkdown(content: ItemContent): string {
  switch (content.kind) {
    case "questions": {
      const { count, shown } = content;
      const lines = [`**${count} question${count === 1 ? "" : "s"}**`, ""];
      shown.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.stimulus}`);
        if (q.template) lines.push(`   ${q.template}`);
        for (const o of q.options) {
          // The check mark is the answer key. It is the single most useful thing
          // in the summary for anyone verifying that the item is correct.
          lines.push(`   - ${o.correct ? "✓ " : ""}${o.label}`);
        }
      });
      const remaining = count - shown.length;
      if (remaining > 0) lines.push("", `…and ${remaining} more.`);
      return lines.join("\n");
    }
    case "table": {
      const { headers, rows, totalRows, totalSheets, sheetName } = content;
      const width = headers.length;
      const pad = (cells: string[]) =>
        Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? ""));
      const lines: string[] = [];
      // The sheet's own name earns its place only when there is more than one, to
      // say WHICH sheet this is. On a single-sheet workbook it just repeats the
      // item title the caller printed a line above.
      if (sheetName && totalSheets > 1) lines.push(`**${sheetName}**`, "");
      lines.push(`| ${pad(headers).join(" | ")} |`);
      lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
      for (const r of rows) lines.push(`| ${pad(r).join(" | ")} |`);
      const notes: string[] = [];
      const hiddenRows = totalRows - rows.length;
      if (hiddenRows > 0) notes.push(`${hiddenRows} more row${hiddenRows === 1 ? "" : "s"}`);
      if (totalSheets > 1) {
        notes.push(`${totalSheets - 1} more sheet${totalSheets === 2 ? "" : "s"}`);
      }
      if (notes.length) lines.push("", `…and ${notes.join(", ")}.`);
      return lines.join("\n");
    }
    case "chart": {
      const { title, chartType, categories, series } = content;
      const lines: string[] = [];
      const heading = [title && `**${title}**`, chartType && `${chartType} chart`]
        .filter(Boolean)
        .join(" — ");
      if (heading) lines.push(heading, "");
      const named = series.map((sr, i) => sr.name ?? (series.length > 1 ? `Series ${i + 1}` : "Value"));
      lines.push(`| | ${named.map(escapeCell).join(" | ")} |`);
      lines.push(`| --- | ${named.map(() => "---").join(" | ")} |`);
      const rowCount = Math.max(categories.length, ...series.map((sr) => sr.values.length));
      for (let i = 0; i < rowCount; i++) {
        const label = escapeCell(categories[i] ?? String(i + 1));
        lines.push(`| ${label} | ${series.map((sr) => escapeCell(sr.values[i] ?? "")).join(" | ")} |`);
      }
      return lines.join("\n");
    }
    case "conceptweb": {
      const { topic, instructions, concepts, links, tray, blanks } = content;
      const lines: string[] = [];
      if (topic) lines.push(`**${topic}** — concept web`, "");
      if (instructions) lines.push(instructions, "");
      if (concepts.length) lines.push(`Concepts: ${concepts.join(", ")}`, "");
      if (blanks) {
        lines.push(
          `${blanks} ${blanks === 1 ? "node" : "nodes"} to fill` +
            (tray ? `, from a tray of ${tray.length}: ${tray.join(", ")}` : ""),
          "",
        );
      } else if (tray) {
        lines.push(`Concepts to place: ${tray.join(", ")}`, "");
      }
      for (const l of links) {
        lines.push(`- ${l.from} → ${l.to}${l.label ? ` — ${l.label}` : ""}`);
      }
      return lines.join("\n").trim();
    }
    case "prose":
      return content.text;
    case "preview":
      return "";
    case "empty":
      return "";
  }
}

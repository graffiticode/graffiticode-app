import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  contentToMarkdown,
  describeItem,
  isTerminalStatus,
  mergeToolPayload,
  normalizeLang,
  unwrapData,
} from "../src/item-content.js";
import {
  buildReadySummary,
  buildGeneratingSummary,
  buildFailedSummary,
  buildLinkDirective,
  clientMountsWidget,
  buildGeneratingSummary,
  progressFragment,
} from "../src/tools.js";

// A Learnosity-shaped payload, spelled the way the compiler emits it: questions
// under data.request, the answer key under the hyphenated `valid-response`.
const LEARNOSITY = {
  language: "L0176",
  data: {
    request: {
      questions: [
        {
          stimulus: "<p>Which stage turns vapor into droplets?</p>",
          options: [
            { value: "0", label: "Evaporation" },
            { value: "1", label: "Condensation" },
          ],
          "valid-response": { value: ["1"] },
        },
      ],
    },
  },
};

test("describeItem extracts questions and marks the correct option", () => {
  const c = describeItem("L0176", LEARNOSITY);
  assert.equal(c.kind, "questions");
  if (c.kind !== "questions") return;
  assert.equal(c.count, 1);
  // HTML tags are markup, not content — they must not survive into a chat message.
  assert.equal(c.shown[0].stimulus, "Which stage turns vapor into droplets?");
  assert.deepEqual(
    c.shown[0].options.map((o) => [o.label, o.correct]),
    [["Evaporation", false], ["Condensation", true]]
  );
});

test("the answer key survives into the Markdown", () => {
  const md = contentToMarkdown(describeItem("L0176", LEARNOSITY));
  assert.match(md, /\*\*1 question\*\*/);
  assert.match(md, /- ✓ Condensation/);
  // The wrong answer is listed, but unmarked.
  assert.match(md, /- Evaporation/);
});

test("camelCase validResponse is honoured too", () => {
  const c = describeItem("L0176", {
    language: "L0176",
    data: { request: { questions: [{ prompt: "Q", options: [{ value: "a", label: "A" }], validResponse: { value: ["a"] } }] } },
  });
  assert.equal(c.kind === "questions" && c.shown[0].options[0].correct, true);
});

test("more than eight questions reports the remainder rather than dropping it", () => {
  const questions = Array.from({ length: 11 }, (_, i) => ({ stimulus: `Q${i}`, options: [] }));
  const c = describeItem("L0176", { language: "L0176", data: { request: { questions } } });
  assert.equal(c.kind === "questions" && c.count, 11);
  assert.equal(c.kind === "questions" && c.shown.length, 8);
  assert.match(contentToMarkdown(c), /…and 3 more\./);
});

test("a spec language renders as prose, not JSON", () => {
  const c = describeItem("L0177", { language: "L0177", data: { print: "# Recipe\nStep one." } });
  assert.equal(c.kind, "prose");
  assert.equal(contentToMarkdown(c), "# Recipe\nStep one.");
});

test("a sheet with no cells falls back to preview, which chat suppresses", () => {
  // sheets[] present but no `cells` — sheetToTable declines, so this lands on the
  // widget-only preview shape and contributes nothing to the chat text.
  const c = describeItem("L0179", { language: "L0179", data: { sheets: [{ id: "s1" }] } });
  assert.equal(c.kind, "preview");
  assert.equal(contentToMarkdown(c), "");
});

test("no data yields empty content, and empty renders as nothing", () => {
  const c = describeItem("L0179", { language: "L0179" });
  assert.equal(c.kind, "empty");
  assert.equal(contentToMarkdown(c), "");
});

test("unwrapData unwraps the { data, errors } envelope", () => {
  assert.deepEqual(unwrapData({ data: { a: 1 }, errors: [] }), { a: 1 });
  assert.deepEqual(unwrapData({ a: 1 }), { a: 1 });
});

test("normalizeLang accepts both spellings", () => {
  assert.equal(normalizeLang("0179"), "L0179");
  assert.equal(normalizeLang("L0179"), "L0179");
});

test("hydration overrides structuredContent when merging", () => {
  const merged = mergeToolPayload({
    structuredContent: { item_id: "x", status: "ready" },
    meta: { graffiticode: { data: { a: 1 } } },
  });
  assert.equal(merged.item_id, "x");
  assert.deepEqual(merged.data, { a: 1 });
});

// --- The summaries clients actually read ------------------------------------

test("the ready summary carries the content, not just a link", () => {
  const s = buildReadySummary("Water Cycle", "L0176", "https://app.example/form/x", undefined, LEARNOSITY);
  assert.match(s, /\*\*Water Cycle\*\* \(L0176\) is ready/);
  assert.match(s, /✓ Condensation/);
});

test("the ready summary still works without a payload", () => {
  const s = buildReadySummary("Budget", "L0179", "https://app.example/form/x");
  assert.match(s, /\*\*Budget\*\* \(L0179\) is ready/);
});

test("the console's 'unnamed' placeholder is never shown as a title", () => {
  for (const s of [
    buildReadySummary("unnamed", "L0179", "https://app.example/form/x"),
    buildGeneratingSummary("unnamed", "render_item", "abc"),
    buildFailedSummary("unnamed", "L0179", "boom"),
  ]) {
    assert.doesNotMatch(s, /unnamed/);
    assert.match(s, /Your item/);
  }
});

// The regression that motivated this file: these two states carried no `summary`,
// so formatToolResult fell back to JSON.stringify and answered the user with a
// pretty-printed blob.
test("generating and failed produce prose, and never look like JSON", () => {
  const gen = buildGeneratingSummary("Quiz", "render_item", "abc123");
  assert.match(gen, /still generating/);
  assert.match(gen, /render_item\("abc123"\)/);

  const failed = buildFailedSummary("Quiz", "L0176", "Generation timed out");
  assert.match(failed, /could not be generated — Generation timed out/);

  for (const s of [gen, failed]) assert.doesNotMatch(s, /^\s*[{[]/);
});

// --- Spreadsheets: a table, never a dump ------------------------------------

const SHEET = {
  language: "L0179",
  data: {
    sheets: [
      {
        id: "s1",
        name: "Water Cycle Stages",
        columns: { A: { width: 160 }, B: { width: 420 } },
        cells: {
          A1: { text: "Stage", "font-weight": "bold" },
          B1: { text: "Short Description", "font-weight": "bold" },
          A2: { text: "Evaporation" },
          B2: { text: "Liquid water warms and changes into water vapor." },
          A3: { text: "Condensation" },
          B3: { text: "Water vapor cools into droplets." },
        },
      },
      { id: "s2", name: "Notes", cells: { A1: { text: "x" } } },
    ],
  },
};

test("a spreadsheet becomes a table, keyed off shape not language id", () => {
  const c = describeItem("L0179", SHEET);
  assert.equal(c.kind, "table");
  if (c.kind !== "table") return;
  assert.deepEqual(c.headers, ["Stage", "Short Description"]);
  assert.equal(c.rows.length, 2);
  assert.deepEqual(c.rows[0], ["Evaporation", "Liquid water warms and changes into water vapor."]);
  assert.equal(c.totalSheets, 2);
  // Same compiled form, so the deprecated predecessor reads identically.
  assert.equal(describeItem("L0166", SHEET).kind, "table");
});

test("the table renders as Markdown with the other sheet noted", () => {
  const md = contentToMarkdown(describeItem("L0179", SHEET));
  assert.match(md, /\| Stage \| Short Description \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| Evaporation \|/);
  assert.match(md, /…and 1 more sheet\./);
  assert.doesNotMatch(md, /font-weight/);
  // Two sheets, so naming this one is informative.
  assert.match(md, /\*\*Water Cycle Stages\*\*/);
});

test("cells are ordered by column and row, not by object key order", () => {
  const c = describeItem("L0179", {
    language: "L0179",
    data: { sheets: [{ cells: { B2: { text: "b2" }, A1: { text: "h1" }, A2: { text: "a2" }, B1: { text: "h2" } } }] },
  });
  assert.equal(c.kind === "table" && c.headers.join(","), "h1,h2");
  assert.equal(c.kind === "table" && c.rows[0].join(","), "a2,b2");
});

test("a pipe in a cell cannot break out of the table", () => {
  const md = contentToMarkdown(
    describeItem("L0179", { language: "L0179", data: { sheets: [{ cells: { A1: { text: "a|b" }, A2: { text: "c|d" } } }] } })
  );
  assert.match(md, /a\\\|b/);
  assert.match(md, /c\\\|d/);
});

// The whole point of the exercise: chat never receives machine output.
test("an unrecognised shape yields NO chat content, and never JSON", () => {
  const c = describeItem("L0170", { language: "L0170", data: { some: { nested: ["thing"] } } });
  assert.equal(c.kind, "preview"); // the widget may still show it
  assert.equal(contentToMarkdown(c), ""); // chat gets nothing
});

test("no describeItem output ever puts a JSON fence in chat", () => {
  const payloads = [
    { language: "L0179", data: { sheets: [{ cells: { A1: { text: "x" } } }] } },
    { language: "L0170", data: { anything: 1 } },
    { language: "L0176", data: { request: { questions: [{ stimulus: "q", options: [] }] } } },
    { language: "L0177", data: { print: "text" } },
    { language: "L0173", data: { chart: { series: [1, 2] } } },
  ];
  for (const p of payloads) {
    const md = contentToMarkdown(describeItem(normalizeLang(p.language), p));
    assert.doesNotMatch(md, /```json/);
    assert.doesNotMatch(md, /"font-weight"|\{\s*\n\s*"/);
  }
});

test("a single-sheet workbook does not repeat its name as a heading", () => {
  const md = contentToMarkdown(
    describeItem("L0179", { language: "L0179", data: { sheets: [{ name: "Budget", cells: { A1: { text: "H" }, A2: { text: "v" } } }] } })
  );
  assert.doesNotMatch(md, /\*\*Budget\*\*/);
  assert.match(md, /\| H \|/);
});

// --- Charts and concept webs, from real compiled output ---------------------

// Captured from item DUjFu0StLUJPRpT1T8b9 (L0173): ECharts option format.
const CHART = {
  language: "L0173",
  data: {
    data: {
      type: "chart",
      option: {
        title: { text: "Monthly Sales" },
        xAxis: { type: "category", data: ["January", "February", "March", "April"] },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: [42000, 38000, 51000, 47000] }],
      },
    },
    errors: [],
  },
};

// Captured from item Wy4dOYQqcXMY35Gh4toK (L0169).
const WEB = {
  language: "L0169",
  data: {
    data: {
      conceptWeb: {
        topic: "Water Cycle",
        instructions: "Follow the arrows to explore each stage.",
        anchor: { text: "Water Cycle", value: "Water Cycle" },
        connections: [
          { text: "Evaporation", value: "Evaporation" },
          { text: "Condensation", value: "Condensation" },
        ],
        edges: [
          { type: "dashed", to: "*", from: "Water Cycle" },
          { type: "solid-arrow", from: "Evaporation", to: "Condensation", text: "Liquid water warms into vapor." },
        ],
      },
    },
    errors: [],
  },
};

test("a chart becomes the numbers it draws", () => {
  const c = describeItem("L0173", CHART);
  assert.equal(c.kind, "chart");
  if (c.kind !== "chart") return;
  assert.equal(c.title, "Monthly Sales");
  assert.equal(c.chartType, "bar");
  assert.deepEqual(c.categories, ["January", "February", "March", "April"]);
  assert.deepEqual(c.series[0].values, ["42000", "38000", "51000", "47000"]);

  const md = contentToMarkdown(c);
  assert.match(md, /\*\*Monthly Sales\*\* — bar chart/);
  assert.match(md, /\| January \| 42000 \|/);
});

test("a concept web keeps its edge labels, and drops the layout edge", () => {
  const c = describeItem("L0169", WEB);
  assert.equal(c.kind, "conceptweb");
  if (c.kind !== "conceptweb") return;
  assert.equal(c.topic, "Water Cycle");
  assert.deepEqual(c.concepts, ["Evaporation", "Condensation"]);
  // The `to: "*"` radial fan-out is layout, not content.
  assert.equal(c.links.length, 1);
  assert.deepEqual(c.links[0], {
    from: "Evaporation",
    to: "Condensation",
    label: "Liquid water warms into vapor.",
  });

  const md = contentToMarkdown(c);
  assert.match(md, /\*\*Water Cycle\*\* — concept web/);
  assert.match(md, /- Evaporation → Condensation — Liquid water warms into vapor\./);
});

test("charts and concept webs reach chat, and still never as JSON", () => {
  for (const p of [CHART, WEB]) {
    const md = contentToMarkdown(describeItem(normalizeLang(p.language), p));
    assert.notEqual(md, "");
    assert.doesNotMatch(md, /```json|"type":/);
  }
});

// Captured VERBATIM from item f4eWUhBhHKnONtgERcZ0 (L0179) against production.
// The first version of the table branch guessed `data.sheets[].cells` from a log
// excerpt and shipped: the real single-table shape puts cells under
// `data.interaction.cells`, so it never fired and spreadsheets went out empty.
// This fixture is why the extraction now probes and verifies rather than assumes.
const REAL_L0179 = {
  language: "L0179",
  data: {
    data: {
      title: "",
      instructions: "",
      validation: { points: 0, regions: { "*": { primaryColumn: null, order: "expected", rows: [] } } },
      interaction: {
        type: "table",
        cells: {
          A1: { text: "Category", "font-weight": "bold" },
          B1: { text: "Amount", "font-weight": "bold" },
          A2: { text: "Rent" },
          B2: { text: "2000" },
          A3: { text: "Food" },
          B3: { text: "600" },
        },
      },
    },
    errors: [],
  },
};

test("the REAL L0179 shape renders as a table", () => {
  const c = describeItem("L0179", REAL_L0179);
  assert.equal(c.kind, "table");
  if (c.kind !== "table") return;
  assert.deepEqual(c.headers, ["Category", "Amount"]);
  assert.deepEqual(c.rows, [["Rent", "2000"], ["Food", "600"]]);

  const md = contentToMarkdown(c);
  assert.match(md, /\| Category \| Amount \|/);
  assert.match(md, /\| Rent \| 2000 \|/);
  assert.doesNotMatch(md, /font-weight/);
});

test("a container that holds no cell addresses is not mistaken for a sheet", () => {
  // `interaction` present but keyed by something else entirely — must fall
  // through rather than produce a table of nonsense.
  const c = describeItem("L0179", {
    language: "L0179",
    data: { interaction: { type: "table", cells: { foo: { text: "x" } } } },
  });
  assert.notEqual(c.kind, "table");
});

// --- The latch that made a slow item unrecoverable --------------------------

test("only 'generating' is non-terminal", () => {
  assert.equal(isTerminalStatus("generating"), false);
  for (const s of ["ready", "failed", "error", undefined]) {
    assert.equal(isTerminalStatus(s), true, `${s} should be terminal`);
  }
});

test("render_item's poll-deadline shape is exactly the non-terminal case", () => {
  // This is the payload handleItemResult returns when its 45s poll expires. The
  // widget latched on it and ignored the ready result that followed.
  const deadline = { item_id: "x", status: "generating", language: "L0179", name: "n" };
  assert.equal(isTerminalStatus(deadline.status), false);
  const ready = { item_id: "x", status: "ready", language: "L0179", name: "n" };
  assert.equal(isTerminalStatus(ready.status), true);
});


/**
 * L0180 fell through every branch to `preview`, and `preview` is deliberately empty
 * in chat — so the most-used assessment language summarised as a title and a link,
 * and a model relaying that could only say it had made something. Both fixtures are
 * real compiled payloads.
 */
test("L0180 choice items summarise as questions with the answer key marked", () => {
  const content = describeItem("L0180", {
    data: {
      data: {
        interaction: {
          type: "choice",
          prompt: "Which gas do plants absorb from the air during photosynthesis?",
          maxChoices: 1,
          options: [
            { id: "A", text: "Oxygen" },
            { id: "B", text: "Carbon dioxide" },
            { id: "C", text: "Nitrogen" },
          ],
        },
        validation: {
          responseProcessing: "map_response",
          points: 1,
          mapping: { B: { correct: true, points: 1 } },
        },
      },
      errors: [],
    },
  });

  assert.equal(content.kind, "questions");
  const md = contentToMarkdown(content);
  assert.match(md, /Which gas do plants absorb/);
  assert.match(md, /✓ Carbon dioxide/);
  // Only the key is marked — a summary that ticks everything is worse than none.
  assert.doesNotMatch(md, /✓ Oxygen/);
  assert.doesNotMatch(md, /✓ Nitrogen/);
});

test("L0180 reads a match_correct key, not just a mapping", () => {
  // The two response-processing templates are alternatives and never both present;
  // reading only `mapping` would mark every option in this item wrong.
  const content = describeItem("L0180", {
    data: {
      interaction: {
        type: "choice",
        prompt: "Select both amphibians.",
        maxChoices: 2,
        options: [
          { id: "A", text: "Frog" },
          { id: "B", text: "Lizard" },
          { id: "C", text: "Salamander" },
        ],
      },
      validation: { responseProcessing: "match_correct", points: 1, correctResponse: ["A", "C"] },
    },
  });

  const md = contentToMarkdown(content);
  assert.match(md, /✓ Frog/);
  assert.match(md, /✓ Salamander/);
  assert.doesNotMatch(md, /✓ Lizard/);
});

test("L0180 multi-part items count and key each part", () => {
  const content = describeItem("L0180", {
    data: {
      interaction: {
        type: "item",
        stimulus: { title: "A short passage" },
        parts: [
          { id: "p1", type: "choice", prompt: "What is the claim?", options: [{ id: "A", text: "Frogs breathe through skin" }] },
          { id: "p2", type: "choice", prompt: "Which line supports it?", options: [{ id: "X", text: "Line 4" }, { id: "Y", text: "Line 9" }] },
        ],
      },
      validation: {
        points: 1,
        scoring: "conjunctive",
        parts: {
          p1: { points: 1, mapping: { A: { correct: true, points: 1 } } },
          p2: { points: 1, correctResponse: ["Y"] },
        },
      },
    },
  });

  assert.equal(content.kind, "questions");
  assert.equal((content as { count: number }).count, 2);
  const md = contentToMarkdown(content);
  assert.match(md, /2 questions/);
  assert.match(md, /✓ Frogs breathe through skin/);
  assert.match(md, /✓ Line 9/);
  assert.doesNotMatch(md, /✓ Line 4/);
});

// A label/value sheet — the shape a calculator takes. Row 1 is data, not captions.
// Taken from a real L0179 item ("Simple Retirement Calculator", 2026-09-06) whose
// first input row was silently promoted into the header.
const CALCULATOR = {
  language: "L0179",
  data: {
    title: "Simple Retirement Calculator",
    interaction: {
      type: "table",
      cells: {
        A1: { text: "Current Savings" }, B1: { text: "100000", format: "$#,##0" },
        A2: { text: "Years Until Retirement" }, B2: { text: "30" },
        A3: { text: "Annual Return" }, B3: { text: "0.07", format: "0%" },
        A4: { text: "Projected Savings" }, B4: { text: "=B1*(1+B3)^B2" },
      },
    },
  },
};

// A captioned sheet — row 1 IS the header, and must stay one.
const CAPTIONED = {
  language: "L0179",
  data: {
    interaction: {
      type: "table",
      cells: {
        A1: { text: "Region" }, B1: { text: "Revenue" },
        A2: { text: "North" }, B2: { text: "1200" },
        A3: { text: "South" }, B3: { text: "900" },
      },
    },
  },
};

test("a label/value sheet keeps its first row as data", () => {
  const content = describeItem("L0179", CALCULATOR);
  assert.equal(content.kind, "table");
  const table = content as { headers: string[]; rows: string[][]; totalRows: number };
  assert.deepEqual(table.headers, ["", ""], "no caption is invented from the data");
  assert.equal(table.totalRows, 4, "all four rows survive");
  assert.deepEqual(table.rows[0], ["Current Savings", "100000"]);
  const md = contentToMarkdown(content);
  assert.match(md, /Current Savings \| 100000/);
  assert.match(md, /Projected Savings \| =B1/);
});

test("a captioned sheet still gets its header", () => {
  const content = describeItem("L0179", CAPTIONED);
  const table = content as { headers: string[]; rows: string[][]; totalRows: number };
  assert.deepEqual(table.headers, ["Region", "Revenue"]);
  assert.equal(table.totalRows, 2);
  assert.deepEqual(table.rows[0], ["North", "1200"]);
});

test("the ready summary tells the model to show the contents AND the link", () => {
  const summary = buildReadySummary("Simple Retirement Calculator", "L0179",
    "https://app.graffiticode.org/form/abc", undefined, CALCULATOR);
  // The sheet itself reaches a client that can render no widget.
  assert.match(summary, /Current Savings \| 100000/);
  assert.match(summary, /form\/abc/);
});

test("a failed item names how to retry, and when not to", () => {
  const retryable = buildFailedSummary("Retirement Calculator", "L0179",
    "The generator produced no code for this request.", "abc123");
  assert.match(retryable, /update_item\("abc123"/, "names the tool and the item");
  assert.match(retryable, /out of scope/, "and the case where retrying is wrong");
  // Callers that have no item id still get the plain sentence, unchanged.
  assert.equal(
    buildFailedSummary("Quiz", "L0176", "boom"),
    "**Quiz** (L0176) could not be generated — boom"
  );
});

test("the ready directive asks for the contents AND the link", () => {
  const d = buildLinkDirective("https://app.graffiticode.org/form/abc");
  // The content must be asked for FIRST — a terminal client can mount no widget,
  // so the summary is the product, not a preview of it.
  assert.match(d, /Show the user this item's contents/);
  assert.ok(d.indexOf("contents") < d.indexOf("form/abc"), "contents before the link");
  assert.match(d, /form\/abc/);
  // And the clause that stops prose REPLACING the link survives, as the last word.
  assert.match(d, /not a substitute for the link\.$/);
  // The original wording steered models to drop the content. It must not come back.
  assert.doesNotMatch(d, /a description of the item is not a substitute/);
});



test("a still-generating result says how long, and how much is written", () => {
  // Writing: elapsed AND volume, so a big program is legible as progress.
  const writing = buildGeneratingSummary("Retirement Calculator", "render_item", "abc", 34, 13600);
  assert.match(writing, /still generating \(34s, ~3,400 tokens written\)/);
  assert.match(writing, /render_item\("abc"\)/, "and still names the retry");

  // Thinking: nothing written after a quarter minute is named, not reported as 0.
  // An L0179 run really did spend 5.5 minutes emitting zero characters.
  assert.match(
    buildGeneratingSummary("X", "render_item", "abc", 34),
    /still generating \(34s, still planning\)/
  );

  // Early: too soon to call it planning, so just the clock.
  assert.match(buildGeneratingSummary("X", "render_item", "abc", 5), /still generating \(5s\)/);

  // Unknown start time must not print "(0s)" or "(NaNs)".
  assert.match(buildGeneratingSummary("X", "render_item", "abc"), /still generating —/);
  assert.match(buildGeneratingSummary("X", "render_item", "abc", 0), /still generating —/);
});

test("the progress phrase is shared, and empty when there is nothing to say", () => {
  assert.equal(progressFragment(39, 8160), " (39s, ~2,040 tokens written)");
  assert.equal(progressFragment(34), " (34s, still planning)");
  assert.equal(progressFragment(5), " (5s)");
  // Nothing honest to say → nothing rendered, so no "(0s)" or "(NaNs)".
  assert.equal(progressFragment(), "");
  assert.equal(progressFragment(0), "");
  // The summary is built from this same phrase, so the two cannot drift.
  assert.match(
    buildGeneratingSummary("X", "render_item", "abc", 39, 8160),
    /still generating \(39s, ~2,040 tokens written\)/
  );
});

test("every client is told to show the contents, whatever it claims to render", () => {
  // Suppression was tried three ways in one day and each cost more than it saved.
  // Keyed on NAME, a ChatGPT plugin announced "the interactive quiz is rendered
  // above" with nothing on screen. Keyed on the UI-EXTENSION DECLARATION, it
  // reached codex-mcp-client — a terminal — and produced a bare link. Made
  // CONDITIONAL, the model still took the quiet branch and a chart arrived as one
  // sentence and a URL.
  //
  // The deciding measurement: a FRESHLY connected ChatGPT client on the current
  // build read the widget HTML, fetched the language bundle (HTTP 200) and
  // painted nothing. Suppression protects a render not yet observed on these
  // hosts and charges for it on every call; duplication, if a mount ever starts
  // working, is visible and fixable by a deploy.
  for (const mounts of [true, false]) {
    const d = buildLinkDirective("https://app.graffiticode.org/form/abc", mounts);
    assert.match(d, /Show the user this item's contents/, `mountsWidget=${mounts}`);
    assert.doesNotMatch(d, /already rendered/i);
    assert.doesNotMatch(d, /do NOT reproduce/i);
    assert.match(d, /https:\/\/app\.graffiticode\.org\/form\/abc/);
    assert.match(d, /not a substitute/i);
  }
});

test("a client that mounts nothing is still told to show the contents", () => {
  // For a terminal client the summary is not a preview of the product, it IS the
  // product. Suppressing it there is the regression this pairing exists to avoid.
  const d = buildLinkDirective("https://app.graffiticode.org/form/abc", false);
  assert.match(d, /Show the user this item's contents/);
  assert.doesNotMatch(d, /already rendered/i);
});

test("clientMountsWidget answers for the hosts actually seen in production", () => {
  // Both halves of the test are load-bearing, and each over-matches alone:
  // claude-code passes the name whitelist and mounts nothing; web-sandbox
  // declares the extension and is deliberately given text.
  assert.equal(clientMountsWidget("Anthropic/ClaudeAI", true), true);
  assert.equal(clientMountsWidget("openai-mcp", true), true);
  assert.equal(clientMountsWidget("codex-mcp-client", true), true);
  // Was `true` ("openai mounts without declaring"), on the strength of a chart
  // that drew in ChatGPT mobile on 2026-09-11. Flipped 2026-09-17 after the
  // opposite case appeared: a ChatGPT workspace plugin created a quiz, mounted
  // nothing, and told the user "The interactive Graffiticode quiz is rendered
  // above" — because this predicate said it had been.
  //
  // Both observations are real, so an undeclared OpenAI client CANNOT be
  // answered confidently either way. The tie goes to the recoverable failure:
  // printing the contents next to a widget that did mount is redundant, while
  // suppressing them when nothing mounted leaves the user with a claim and an
  // empty screen.
  assert.equal(clientMountsWidget("codex-mcp-client", false), false, "undeclared: cannot assume a mount");
  assert.equal(clientMountsWidget("claude-code", false), false, "terminal: summary IS the product");
  assert.equal(clientMountsWidget("web-sandbox", true), false, "declares but is not given a widget");
  assert.equal(clientMountsWidget(undefined, undefined), false);
});

test("the call site actually passes the mount flag", () => {
  // A source-level check, and deliberately so. The helpers above are pure and
  // well covered, but removing the ARGUMENT at the one call site leaves all of
  // them green — verified — so nothing else here would notice the feature being
  // silently disabled.
  //
  // That is not a hypothetical: buildLinkDirective's own comment records being
  // "rewritten once and the edit was lost before it reached a commit", with
  // production handing models a bare link for three more days. There is no
  // handler-level harness to assert the behaviour end to end (it would need the
  // auth and API layers mocked), so this pins the wiring until there is one.
  const src = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf-8");
  const call = /buildLinkDirective\(\s*hydration\.view_url as string,\s*clientMountsWidget\(/;
  assert.match(
    src,
    call,
    "handleItemResult must pass clientMountsWidget(...) to buildLinkDirective",
  );
});

/**
 * A concept web has two shapes, and only one of them was understood.
 *
 * A FINISHED diagram carries its content in each node's `text`. An ASSESSMENT
 * carries blank node text on purpose — the blank IS the exercise — with the
 * expected answers in `assess.expected` and the draggable options in `concepts`.
 * The extractor read `text ?? value` off every node, got "" from all of them,
 * and returned no content at all: `render_item` answered with a title and a link
 * and nothing else.
 *
 * It survived because the widget hides it. A widget host mounts the real
 * component and never reads the summary, so the failure was only visible to a
 * client that has nothing BUT text — which is every terminal, and ChatGPT
 * whenever the widget does not mount.
 *
 * The tray is described and the mapping is not, deliberately: the tray is what
 * the learner is shown, while which concept belongs in which node is the answer
 * key. The Learnosity and choice summaries don't print their keys either.
 */
const RAIN_WEB = {
  data: {
    conceptWeb: {
      topic: "How Rain Forms",
      instructions: "Drag the correct concepts onto the nodes to complete the water cycle diagram.",
      anchor: { assess: { method: "value", expected: "Rain" }, text: "" },
      connections: [
        { assess: { method: "value", expected: "Evaporation" }, text: "" },
        { assess: { method: "value", expected: "Water Vapor Rises" }, text: "" },
        { assess: { method: "value", expected: "Condensation" }, text: "" },
        { assess: { method: "value", expected: "Cloud Formation" }, text: "" },
        { assess: { method: "value", expected: "Precipitation" }, text: "" },
      ],
      concepts: [
        { value: "Evaporation" },
        { value: "Water Vapor Rises" },
        { value: "Condensation" },
        { value: "Cloud Formation" },
        { value: "Precipitation" },
        { value: "Rain" },
      ],
      trayAlign: "right",
      relations: [],
    },
  },
  errors: [],
};

test("an assessment concept web describes itself, blank nodes and all", () => {
  const md = contentToMarkdown(describeItem("L0169", { data: RAIN_WEB }));
  assert.notEqual(md, "", "a terminal client would see a link and nothing else");
  assert.match(md, /How Rain Forms/);
  assert.match(md, /Drag the correct concepts/);
  // Six assessed nodes: five connections plus the anchor.
  assert.match(md, /6 nodes to fill, from a tray of 6/);
  assert.match(md, /Evaporation, Water Vapor Rises, Condensation/);
});

test("the node-to-answer mapping stays out of the summary", () => {
  const md = contentToMarkdown(describeItem("L0169", { data: RAIN_WEB }));
  // The tray names every concept, so presence proves nothing; what must not
  // appear is the pairing of a node with its expected answer.
  assert.doesNotMatch(md, /expected/i);
  assert.doesNotMatch(md, /→/, "an arrow here would be a node-to-answer pairing");
});

test("a finished concept web still reads as one, with its labelled edges", () => {
  const md = contentToMarkdown(
    describeItem("L0169", {
      data: {
        data: {
          conceptWeb: {
            topic: "Photosynthesis",
            anchor: { text: "Photosynthesis" },
            connections: [{ text: "Sunlight" }, { text: "Chlorophyll" }],
            edges: [{ from: "Sunlight", to: "Photosynthesis", text: "provides energy" }],
          },
        },
        errors: [],
      },
    })
  );
  assert.match(md, /Concepts: Sunlight, Chlorophyll/);
  assert.match(md, /Sunlight → Photosynthesis — provides energy/);
  assert.doesNotMatch(md, /nodes to fill/, "nothing here is blank");
});

/**
 * L0181 decks fell through to `preview`: the widget card showed raw JSON and chat showed a
 * title and a link. The fixture is the real compiled payload from a ChatGPT render.
 */
test("L0181 flashcard decks summarise as front → back pairs, never JSON", () => {
  const content = describeItem("L0181", {
    data: {
      data: {
        theme: "light",
        instructions: "Flip each card to check your answer before the quiz.",
        title: "Water Cycle Quiz Review",
        cards: [
          { id: 0, front: "What happens during evaporation?", back: "Liquid water changes into water vapor." },
          { id: 1, front: "What happens during condensation?", back: "Water vapor cools and forms droplets." },
        ],
      },
      errors: [],
    },
  });

  assert.equal(content.kind, "prose");
  const md = contentToMarkdown(content);
  assert.match(md, /"Water Cycle Quiz Review" — 2 cards/);
  assert.match(md, /What happens during evaporation\? → Liquid water changes into water vapor\./);
  assert.doesNotMatch(md, /"cards"/);
});

/**
 * A multi-question quiz is an ACTIVITY, and nothing read that shape.
 *
 * "Make a 5-question quiz" compiles to `data.activity.items[]`, each entry carrying
 * its own interaction and validation. Only the SINGLE-item shape (`data.interaction`)
 * was handled, so a quiz fell through every branch to `preview` — which chat
 * suppresses — and the catalog's general assessment language answered with a title
 * and a link. The single-item branch is what hid it: a one-question item read fine,
 * so the language looked covered.
 *
 * This is the same failure as the concept web above and as the Learnosity answer key
 * below: the extractor knew one shape of a thing that has two, and the miss is
 * silent — an empty summary looks like a language that has nothing to say.
 */
const WATER_CYCLE_QUIZ = {
  data: {
    activity: {
      navigation: "nonlinear",
      submission: "simultaneous",
      items: [
        {
          id: 0,
          interaction: {
            type: "choice",
            prompt: "What is the water cycle primarily powered by?",
            options: [
              { id: "A", text: "The Sun" },
              { id: "B", text: "The Moon" },
              { id: "C", text: "Wind" },
              { id: "D", text: "Ocean currents" },
            ],
          },
          validation: { responseProcessing: "map_response", points: 1, mapping: { A: { correct: true, points: 1 } } },
        },
        {
          id: 1,
          interaction: {
            type: "choice",
            prompt: "What is the process by which water changes from a liquid to a gas called?",
            options: [
              { id: "A", text: "Condensation" },
              { id: "B", text: "Evaporation" },
              { id: "C", text: "Precipitation" },
              { id: "D", text: "Collection" },
            ],
          },
          validation: { responseProcessing: "map_response", points: 1, mapping: { B: { correct: true, points: 1 } } },
        },
      ],
    },
  },
  errors: [],
};

test("a multi-question quiz reports every question, not a title and a link", () => {
  const md = contentToMarkdown(describeItem("L0180", { data: WATER_CYCLE_QUIZ }));
  assert.notEqual(md, "", "a terminal client, and ChatGPT without a widget, would see nothing");
  assert.match(md, /\*\*2 questions\*\*/);
  assert.match(md, /What is the water cycle primarily powered by\?/);
  assert.match(md, /What is the process by which water changes/);
});

test("the quiz summary marks the correct option", () => {
  const md = contentToMarkdown(describeItem("L0180", { data: WATER_CYCLE_QUIZ }));
  assert.match(md, /- ✓ The Sun/);
  assert.match(md, /- ✓ Evaporation/);
  assert.doesNotMatch(md, /✓ The Moon/);
});

/**
 * The Learnosity answer key moved and nothing noticed.
 *
 * `describeItem` looked for `valid-response` / `validResponse` at the top of each
 * question. Current payloads nest it as `validation.valid_response`, so `correct`
 * was false for every option and the ✓ never appeared — while the code that renders
 * it calls the mark "the single most useful thing in the summary for anyone
 * verifying that the item is correct", and starter prompt 3 of the ChatGPT listing
 * literally promises "answers marked".
 *
 * A missing ✓ is indistinguishable from a question with no right answer, which is
 * why this went unseen through a submission and a rejection.
 */
test("a Learnosity item marks its correct option from nested validation", () => {
  const md = contentToMarkdown(
    describeItem("L0176", {
      data: {
        data: {
          type: "questions",
          request: {
            questions: [
              {
                type: "mcq",
                stimulus: "What is the primary process by which water moves from the ocean to the atmosphere?",
                options: [
                  { label: "Evaporation", value: "0" },
                  { label: "Condensation", value: "1" },
                ],
                validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["0"] } },
              },
            ],
          },
        },
        errors: [],
      },
    })
  );
  assert.match(md, /- ✓ Evaporation/);
  assert.doesNotMatch(md, /✓ Condensation/);
});

// A cloze has no options: its content is the sentence, its key the blanks.
// Verbatim from a real L0176 item (Q58dZSOqoSAOBsRJ2frl), where the card showed
// "Complete the sentence about the water cycle." and nothing else — no sentence,
// no blank, no answer — on a card whose job is to show the answer key.
const CLOZE = {
  language: "L0176",
  data: {
    data: {
      request: {
        questions: [
          {
            type: "clozetext",
            template:
              "Water vapor in the atmosphere cools and forms liquid water droplets through a process called {{response}}.",
            validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["condensation"] } },
            stimulus: "Complete the sentence about the water cycle.",
          },
        ],
      },
    },
    errors: [],
  },
};

test("a cloze shows its sentence with the blank and the accepted answer marked", () => {
  const c = describeItem("L0176", CLOZE);
  assert.equal(c.kind, "questions");
  if (c.kind !== "questions") return;
  const q = c.shown[0];
  assert.equal(q.stimulus, "Complete the sentence about the water cycle.");
  assert.equal(
    q.template,
    "Water vapor in the atmosphere cools and forms liquid water droplets through a process called _____.",
  );
  assert.deepEqual(q.options, [{ label: "condensation", correct: true }]);

  const md = contentToMarkdown(c);
  assert.match(md, /through a process called _____\./);
  assert.match(md, /- ✓ condensation/);
});

test("a multiple-choice item carries no template", () => {
  const c = describeItem("L0176", LEARNOSITY);
  assert.equal(c.kind === "questions" && c.shown[0].template, undefined);
});

/**
 * L0183 concept webs read `data.interaction` like an L0180 item does, so without their own
 * branch — checked first — a web would be summarised as a question with no options. The
 * fixture is compiled L0183 output (the starter template plus one labelled blank edge).
 */
const L0183_WEB = {
  data: {
    data: {
      title: "Parts of a cell",
      instructions: "Drag each part onto an empty node.",
      interaction: {
        type: "concept-web",
        hub: { id: "hub", text: "The Cell" },
        nodes: [
          { id: "n1", text: "Nucleus" },
          { id: "n2", blank: true },
          { id: "n3", blank: true },
        ],
        edges: [
          { id: "e1", from: "hub", to: "n1", style: "solid", label: "contains" },
          { id: "e2", from: "hub", to: "n2", style: "solid" },
          { id: "e3", from: "hub", to: "n3", style: "solid-arrow", blank: true },
        ],
        trays: {
          nodes: { items: [{ id: "c1", text: "Mitochondria" }, { id: "c2", text: "Ribosome" }], align: "right" },
          edges: { items: [{ id: "r1", text: "makes" }], align: "bottom" },
        },
        cells: { n2: {}, n3: {}, e3: {} },
      },
      validation: {
        points: 3,
        cells: {
          n2: { assess: { expected: "Mitochondria", points: 1 }, pool: "p1" },
          n3: { assess: { expected: "Ribosome", points: 1 }, pool: "p2" },
          e3: { assess: { expected: "makes", points: 1 }, pool: "p3" },
        },
      },
    },
    errors: [],
  },
};

test("L0183 concept webs summarise as the hub, its nodes and the blanks' answers", () => {
  const content = describeItem("L0183", L0183_WEB);
  assert.equal(content.kind, "prose");
  const md = contentToMarkdown(content);
  assert.match(md, /Concept web: "Parts of a cell" — The Cell with 3 nodes around it, 3 blanks to fill\./);
  assert.match(md, /- Nucleus/);
  assert.match(md, /- \[blank: Mitochondria\]/);
  assert.match(md, /The Cell —contains→ Nucleus/);
  assert.match(md, /The Cell —\[blank: makes\]→ \[blank: Ribosome\]/);
  assert.doesNotMatch(md, /"interaction"/);
});

// describeItem's L0182 branch.
//
// This file replaces tests/survey-tools.test.ts, which covered `open_survey` and `answer_survey`.
// Those tools called a proxy that no longer exists: L0182 stopped being an activity a
// participant is walked through, and became a record — a named set of ideas and at most one
// response to it, both written as code. An agent uses create_item/update_item like every other
// language, so there is no survey-specific tool surface left to test.
//
// What remains worth pinning is that an L0182 item still DESCRIBES. It is not in the widget
// language map (@graffiticode/l0182-view is unpublished), so render_item falls back to the
// content card, and this branch is the whole of what a caller sees.
import test from "node:test";
import assert from "node:assert/strict";
import { describeItem } from "../src/item-content.js";

const SURVEY = {
  name: "you-can-choose",
  title: "You Can Choose",
  ideas: [
    { id: "a3", text: "protect voting rights" },
    { id: "b7", text: "universal healthcare system" },
    { id: "c1", text: "affordable housing" },
  ],
  minChoices: 1,
  maxChoices: 2,
};

const prose = (data: unknown) => {
  const out = describeItem("L0182", { data } as any);
  assert.equal(out?.kind, "prose", "expected a prose summary");
  return (out as { kind: "prose"; text: string }).text;
};

test("summarizes a survey awaiting a response", () => {
  const text = prose({ survey: SURVEY });
  assert.match(text, /"You Can Choose" — 3 ideas to choose between/);
  assert.match(text, /Choose 1–2 of 3, in priority order/);
  assert.match(text, /- protect voting rights/);
  assert.match(text, /No response yet/);
});

test("reads through the { data, errors } compile envelope", () => {
  // Stored compiled data is the envelope the language server returns, not the model that went
  // in. Reading `.survey` off the envelope is undefined for every item ever authored.
  const text = prose({ data: { survey: SURVEY }, errors: [] });
  assert.match(text, /3 ideas to choose between/);
});

test("names the chosen ideas by their text, in the order the response put them", () => {
  const text = prose({ survey: SURVEY, response: { selection: ["c1", "a3"] } });
  assert.match(text, /Chosen, most important first: affordable housing; protect voting rights\./);
});

test("reports a contributed idea", () => {
  const text = prose({
    survey: SURVEY,
    response: { selection: ["a3"], idea: "ranked-choice voting" },
  });
  assert.match(text, /Contributed a new idea: ranked-choice voting/);
});

test("reports a response that chose nothing", () => {
  const text = prose({ survey: SURVEY, response: { selection: [], idea: "something new" } });
  assert.match(text, /Nothing chosen/);
  assert.match(text, /Contributed a new idea: something new/);
});

test("falls back to the survey's name when it has no title", () => {
  const { title: _title, ...untitled } = SURVEY;
  assert.match(prose({ survey: untitled }), /"you-can-choose" — 3 ideas/);
});

test("lists a set of 25 in full, because an agent picks by naming an idea's text", () => {
  const ideas = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, text: `idea ${i}` }));
  const text = prose({ survey: { ...SURVEY, ideas, maxChoices: 5 } });
  assert.ok(!text.includes("more."), "elided an idea the agent is expected to choose from");
  assert.match(text, /- idea 24/);
});

test("caps a set large enough to crowd out the response", () => {
  const ideas = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, text: `idea ${i}` }));
  const text = prose({ survey: { ...SURVEY, ideas, maxChoices: 5 } });
  assert.match(text, /…and 10 more\./);
  assert.ok(!text.includes("idea 30"), "listed past the cap");
});

test("an id the set does not contain is shown rather than dropped", () => {
  // The compiler refuses these, so one only arrives on a record assembled outside it — but a
  // shorter list than the response recorded is the kind of wrong that looks right.
  const text = prose({ survey: SURVEY, response: { selection: ["a3", "gone"] } });
  assert.match(text, /protect voting rights; gone/);
});

test("declines a survey with no ideas, rather than emitting an empty summary", () => {
  assert.notEqual(describeItem("L0182", { data: { survey: { ...SURVEY, ideas: [] } } } as any)?.kind, "prose");
  assert.notEqual(describeItem("L0182", { data: { survey: {} } } as any)?.kind, "prose");
});

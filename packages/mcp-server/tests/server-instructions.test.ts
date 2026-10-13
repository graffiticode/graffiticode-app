import assert from "node:assert/strict";
import test from "node:test";
import { INSTRUCTIONS_HEAD_BUDGET, SERVER_INSTRUCTIONS, buildServerInstructions } from "../src/tools.js";
import type { Language } from "../src/api.js";

// Shaped like the live catalog on 2026-10-01 (descriptions verbatim, hints trimmed
// to their limit sentences). Claude Code keeps the first 2048 chars of server
// instructions; everything that decides whether we get called must be inside them.
const CATALOG = [
  ["0170", "Fetch & transform data", "Authors a standalone transformed dataset; it produces data, it does not render it."],
  ["0175", "Grade 5 ELA assessments (SBAC Claim 1, Reasoning & Evidence): Target 4 literary texts and Target 11 informational texts", ""],
  ["0176", "Learnosity assessment items — Learnosity-shaped JSON for a Learnosity Item Bank, Items API, or Learnosity-integrated LMS. Use ONLY when the user names Learnosity; not a general quiz language.", "Do NOT use for generic quizzes."],
  ["0177", "Learnosity Author API integration — recipes for embedding/configuring an item/activity authoring UX. The UX view of a Learnosity Item bank; for programmatic access to the same data, see L0178.", "Does NOT author item content."],
  ["0178", "Learnosity Data API cookbook — the DATA plane: recipes for reading and writing a Learnosity Item bank and its assessment results, server-to-server. Use ONLY when the user names Learnosity.", ""],
  ["0179", "Spreadsheets", ""],
  ["0180", "Quizzes and assessment items", "EARLY: choice, hot text, fill-in-the-blank, dropdown cloze, word-bank cloze, sequencing, matching, classification and written responses ONLY."],
  ["0181", "Flashcard study decks", ""],
  ["0182", "Surveys — ranked choice and rating scales (Likert, NPS, stars, semantic differentials)", "It does NOT implement a survey-taking flow."],
  ["0183", "Concept webs", "Does NOT do flowcharts, timelines, trees or Venn diagrams (Venn is L0171)."],
  ["0184", "Charts", "Reference and trend lines are not built yet."],
].map(([id, description, routingHint]) => ({ id, name: `L${id}`, description, routingHint, domains: [] })) as unknown as Language[];

test("the head — lead plus whole catalog — fits a 2048-char host", () => {
  const visible = buildServerInstructions(CATALOG).slice(0, 2048);
  for (const l of CATALOG) assert.ok(visible.includes(`L${l.id} — ${l.description}`), `L${l.id} cut off`);
  assert.match(visible, /create_item/);
  const head = buildServerInstructions(CATALOG).split("\n\nFAST-PATH")[0];
  assert.ok(head.length <= INSTRUCTIONS_HEAD_BUDGET, `head is ${head.length} chars`);
});

test("limits survive for hosts that read the whole text", () => {
  const s = buildServerInstructions(CATALOG);
  const tail = s.slice(s.indexOf("Language limits"));
  assert.ok(s.indexOf("Language limits") > 2048);
  assert.match(tail, /L0180 — EARLY: .*ONLY\./);
  assert.match(tail, /L0183 — Does NOT do flowcharts/);
});

test("no catalog still leads with what Graffiticode is for", () => {
  assert.equal(buildServerInstructions(null), SERVER_INSTRUCTIONS);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 600), /rather than writing it out in chat/);
  assert.match(SERVER_INSTRUCTIONS.slice(0, 600), /list_languages/);
});

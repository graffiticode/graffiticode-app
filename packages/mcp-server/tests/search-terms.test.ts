import assert from "node:assert/strict";
import test from "node:test";
import { searchTermsOf } from "../src/events.js";

// A catalog search is the user's phrasing, so the log carries only which of OUR words
// it used plus a count of the rest. Nothing the user typed outside that vocabulary
// may come back out.

test("recognised vocabulary is returned, singularised, deduplicated and sorted", () => {
  assert.deepEqual(searchTermsOf("Make a quiz and some flashcards, quizzes too"), { terms: ["flashcard", "quiz"], unknown: 1 });
  assert.deepEqual(searchTermsOf("fetch csv data into a bar chart"), { terms: ["bar", "chart", "csv", "data", "fetch"], unknown: 0 });
});

test("language ids and published domains count as vocabulary", () => {
  assert.deepEqual(searchTermsOf("L0187 or 0179 for diagrams"), { terms: ["L0179", "L0187", "diagrams"], unknown: 0 });
});

test("words outside the vocabulary are only counted, never returned", () => {
  const r = searchTermsOf("Jane Doe's photosynthesis homework for Springfield Elementary")!;
  assert.deepEqual(r.terms, []);
  assert.equal(r.unknown, 6);
  const text = JSON.stringify(r);
  for (const w of ["jane", "doe", "photosynthesis", "springfield", "elementary", "homework"]) assert.ok(!text.toLowerCase().includes(w), w);
});

test("stopwords are ignored; empty input logs nothing", () => {
  assert.deepEqual(searchTermsOf("create a new survey for me"), { terms: ["survey"], unknown: 0 });
  assert.equal(searchTermsOf("   "), undefined);
  assert.equal(searchTermsOf(undefined), undefined);
});

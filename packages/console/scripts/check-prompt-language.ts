#!/usr/bin/env node
/**
 * check-prompt-language.ts — exercise the non-English request detector.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 *   There is no unit-test runner in this repo, and `tsconfig` excludes
 *   `scripts/**` from typecheck — so BOTH gates are blind here. This file only
 *   means anything if it is actually RUN, and it exits non-zero on a miss so it
 *   can't pass by being ignored.
 *
 * The load-bearing case is `allow` on an ENGLISH prompt carrying Cyrillic
 * content. That is the regression the whole two-rule design exists to avoid; a
 * naive "contains non-Latin" regex fails it, and would delete a feature that
 * works today.
 *
 * Usage:
 *   npx tsx scripts/check-prompt-language.ts
 *   npx tsx scripts/check-prompt-language.ts "your prompt here"   # ad hoc
 */

import { classifyPromptLanguage, promptLanguageKey } from "../src/lib/prompt-language";

type Expect = "english" | "non_english" | "pass";

// "pass" means english OR uncertain — both proceed, and which one it lands on
// is not a promise the gate makes.
const CASES: Array<{ want: Expect; text: string; note?: string }> = [
  // --- must be refused -----------------------------------------------------
  { want: "non_english", text: "Создай тест по математике для 5 класса про дроби", note: "ru" },
  { want: "non_english", text: "Создай интерактивную таблицу расходов по месяцам", note: "ru" },
  { want: "non_english", text: "Créez un quiz de mathématiques pour la cinquième année", note: "fr, Latin script" },
  { want: "non_english", text: "Erstelle eine Tabelle mit den Ausgaben für das Jahr", note: "de, Latin script" },
  { want: "non_english", text: "Crea una hoja de cálculo para los gastos del mes", note: "es, Latin script" },
  { want: "non_english", text: "创建一个关于分数的五年级数学测验", note: "zh" },
  { want: "non_english", text: "分数に関する5年生の数学クイズを作成してください", note: "ja" },
  { want: "non_english", text: "أنشئ اختبارًا في الرياضيات للصف الخامس عن الكسور", note: "ar" },

  // --- must be allowed -----------------------------------------------------
  {
    want: "pass",
    text: "Create flashcards for Russian vocabulary: кот = cat, дом = house",
    note: "THE case — English instruction, Cyrillic content",
  },
  {
    want: "pass",
    text: "Make a quiz about Chinese characters: 水 means water, 火 means fire",
    note: "English instruction, Han content",
  },
  { want: "pass", text: "Bar chart, quarterly revenue 2024", note: "terse English, no function words" },
  { want: "pass", text: "Create a minimal starting template", note: "the template short-circuit string" },
  { want: "pass", text: "Create a spreadsheet tracking monthly expenses by category" },
  { want: "pass", text: "Add a column for the running total and format it as currency" },
  { want: "pass", text: "Build a 5th grade reading comprehension item with four answer choices" },
  { want: "pass", text: "Change the café name to Müller's and update the sign", note: "Latin diacritics, English" },
  { want: "pass", text: "quiz", note: "too short to judge" },
];

const adhoc = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (adhoc.length > 0) {
  for (const text of adhoc) {
    const r = classifyPromptLanguage(text);
    console.log(JSON.stringify({ text, ...r, key: promptLanguageKey(r) }, null, 2));
  }
  process.exit(0);
}

let failed = 0;
for (const c of CASES) {
  const r = classifyPromptLanguage(c.text);
  const ok = c.want === "pass" ? r.verdict !== "non_english" : r.verdict === c.want;
  if (!ok) failed++;
  const mark = ok ? "ok  " : "FAIL";
  const key = r.verdict === "non_english" ? ` key=${promptLanguageKey(r)}` : "";
  const shown = c.text.length > 52 ? c.text.slice(0, 52) + "…" : c.text;
  console.log(
    `${mark} want=${c.want.padEnd(11)} got=${r.verdict.padEnd(11)}` +
      ` latin=${r.latinRatio.toFixed(2)} en=${r.englishMarkers} other=${r.otherMarkers}${key}\n` +
      `     ${shown}${c.note ? `   (${c.note})` : ""}`,
  );
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed === 0 ? 0 : 1);

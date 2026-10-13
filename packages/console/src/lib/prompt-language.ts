// Is this request written in English?
//
// Graffiticode's generation stack is English end to end, and a non-English
// prompt degrades it SILENTLY rather than failing. The sharpest case is
// retrieval: hybridSearch scores 0.7 vector + 0.3 keyword, and the keyword half
// is `docText.includes(keyword)` over an all-English corpus
// (embedding-service.ts), so a Cyrillic query scores 0 there and loses 30% of
// the ranking signal outright; what survives is then cut by MIN_COMBINED_SCORE.
// Empty retrieval is not an error — generation just proceeds with no examples.
// The scope gate judges the request against English scope.json text, and
// get_spec emits English regardless.
//
// WHAT THIS DELIBERATELY DOES NOT CATCH
//   An ENGLISH instruction carrying non-English CONTENT —
//   "Create flashcards for Russian vocabulary: кот = cat" — is legitimate and
//   works today: retrieval gets a good English query, and the parser accepts the
//   content (its string scanner consumes any code unit to the closing quote;
//   only identifiers are ASCII-only, and content lives in string literals).
//   That case is why this is a two-rule classifier and not a charset regex —
//   a regex on "contains Cyrillic" would delete working functionality, and
//   "please restate in English" is nonsense advice for a prompt already in it.
//
// No LLM call: deterministic, free, and therefore affordable on EVERY request
// including updates, where the LLM scope gate deliberately does not run.

export type PromptLanguageVerdict = "english" | "non_english" | "uncertain";

export interface PromptLanguageResult {
  verdict: PromptLanguageVerdict;
  /** Dominant script: "latin", or a non-Latin block name. Always set. */
  script: string;
  /**
   * Best-effort language tag, set ONLY when marker words identify one (Rule B).
   * Never inferred from a non-Latin script: Cyrillic here is overwhelmingly
   * Russian but could be uk/bg/sr, and reporting `cyrillic` is the honest
   * granularity. Consumers group on `plang ?? script`.
   */
  plang?: string;
  /** Latin letters / all letters, 2dp. 1 when there are no letters at all. */
  latinRatio: number;
  englishMarkers: number;
  otherMarkers: number;
}

/** Below this many letters there is not enough signal to judge. */
const MIN_LETTERS = 12;
/** Under this share of Latin letters, the request is not written in English. */
const LATIN_RATIO_FLOOR = 0.5;
/** Distinct non-English marker words needed to call a Latin-script prompt. */
const OTHER_MARKERS_REQUIRED = 2;

// Non-Latin blocks worth naming. Order matters only for reporting a single
// dominant script; the ratio test itself is Latin-vs-everything.
const NON_LATIN_SCRIPTS: Array<[string, RegExp]> = [
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["han", /\p{Script=Han}/u],
  ["kana", /\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["greek", /\p{Script=Greek}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
];

const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/**
 * English function words and the imperative verbs these prompts actually open
 * with. Presence of ANY ONE is enough to stop Rule B, so this list is the guard
 * protecting real English from being refused — err on the side of adding.
 */
const ENGLISH_MARKERS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "with", "to", "from",
  "that", "this", "these", "those", "is", "are", "be", "as", "at", "by", "it",
  "its", "into", "about", "then", "than", "but", "if", "not", "no", "each",
  "all", "some", "any", "new", "please", "should", "can", "when", "where",
  "which", "who", "what", "how", "my", "your", "our", "we", "i", "you",
  "create", "make", "add", "build", "generate", "show", "using", "use", "given",
  "write", "change", "update", "remove", "replace", "include", "based",
]);

/**
 * Marker words per non-English Latin-script language.
 *
 * Every entry must NOT be an English word — this list can only ever ACCUSE, so a
 * word that is also English is a false-positive generator. Deliberately absent
 * for that reason: "per", "con", "die", "com", "a", "no", "in", "me", "so",
 * "sur"-like homographs. Short, safe, and biased toward closed-class words
 * (articles, prepositions) plus the imperative "create" of each language.
 */
const OTHER_MARKERS: Record<string, string[]> = {
  es: ["el", "los", "las", "una", "para", "que", "del", "por", "más", "cómo",
       "crear", "crea", "haz", "hacer", "preguntas", "ejercicio", "español"],
  fr: ["le", "les", "une", "des", "avec", "pour", "dans", "créer", "créez",
       "faire", "français", "questionnaire", "élèves", "être"],
  de: ["der", "das", "und", "mit", "für", "ein", "eine", "einen", "erstelle",
       "erstellen", "erstelt", "mathematik", "aufgaben", "schüler", "nicht"],
  pt: ["um", "uma", "para", "criar", "fazer", "questões", "exercício",
       "português", "alunos", "não"],
  it: ["il", "lo", "gli", "una", "del", "che", "creare", "crea", "italiano",
       "domande", "esercizio", "studenti"],
};

/**
 * Classify the natural language a request is written in.
 *
 * Fail-open by construction: only a confident `non_english` is actionable, and
 * both `english` and `uncertain` mean "proceed". That matches classifyAndRoute's
 * documented stance (availability beats blocking a valid request on a
 * classifier's opinion) — but unlike that gate, the failure mode here is a
 * heuristic's, not an API's.
 */
export function classifyPromptLanguage(text: string): PromptLanguageResult {
  const input = (text || "").trim();

  // Count letters only. Digits, punctuation, emoji and whitespace are script-
  // neutral noise; counting them would let "📊📈 chart" or a long numeric table
  // move the ratio around for no reason.
  let letters = 0;
  let latin = 0;
  const scriptCounts: Record<string, number> = {};

  for (const ch of input) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (LATIN.test(ch)) {
      latin++;
      continue;
    }
    for (const [name, re] of NON_LATIN_SCRIPTS) {
      if (re.test(ch)) {
        scriptCounts[name] = (scriptCounts[name] || 0) + 1;
        break;
      }
    }
  }

  const latinRatio = letters === 0 ? 1 : round2(latin / letters);
  // The DOMINANT script, so a mostly-English prompt quoting a little Cyrillic
  // still reports "latin" — that request is English and is meant to pass.
  const dominantNonLatin = Object.entries(scriptCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const script = latinRatio < LATIN_RATIO_FLOOR && dominantNonLatin
    ? dominantNonLatin
    : "latin";

  // Word tokens for marker matching. Apostrophes are kept inside a token so
  // French elisions ("d'un") don't shatter into single letters.
  const words = input
    .toLowerCase()
    .split(/[^\p{L}'’]+/u)
    .filter((w) => w.length > 0);
  const distinct = new Set(words);

  let englishMarkers = 0;
  for (const w of distinct) {
    if (ENGLISH_MARKERS.has(w)) englishMarkers++;
  }

  let otherMarkers = 0;
  let bestLang: string | undefined;
  let bestHits = 0;
  for (const [lang, markers] of Object.entries(OTHER_MARKERS)) {
    let hits = 0;
    for (const m of markers) {
      if (distinct.has(m)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestLang = lang;
    }
    otherMarkers = Math.max(otherMarkers, hits);
  }

  const base = { script, latinRatio, englishMarkers, otherMarkers };

  if (letters < MIN_LETTERS) {
    return { ...base, verdict: "uncertain" };
  }

  // RULE A — the script itself settles it. Catches ru/zh/ja/ko/ar/he/el/hi/th.
  if (latinRatio < LATIN_RATIO_FLOOR) {
    return { ...base, verdict: "non_english" };
  }

  // RULE B — Latin script, but another language. es/fr/de/pt/it are invisible to
  // Rule A because they ARE Latin script.
  //
  // Requires POSITIVE evidence of another language, never mere absence of
  // English: absence alone would refuse terse but perfectly good English like
  // "Bar chart, quarterly revenue 2024", which matches no function word at all.
  if (otherMarkers >= OTHER_MARKERS_REQUIRED && englishMarkers === 0) {
    return { ...base, verdict: "non_english", plang: bestLang };
  }

  if (englishMarkers >= 1) return { ...base, verdict: "english" };
  return { ...base, verdict: "uncertain" };
}

/** Group key for reporting. See `plang` on why the granularity is mixed. */
export function promptLanguageKey(r: PromptLanguageResult): string {
  return r.plang ?? r.script;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

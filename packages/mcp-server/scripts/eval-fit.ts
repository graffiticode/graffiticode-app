// Language–agent fit: run the corpus through the real agent-facing surface and
// report where an agent found a language, where it asked, and where it walked.
//
//   ANTHROPIC_API_KEY=… GRAFFITICODE_API_KEY=… npx tsx scripts/eval-fit.ts
//   … npx tsx scripts/eval-fit.ts --runs 3 --bucket uncertain
//   npx tsx scripts/eval-fit.ts --dry-run          # no API calls, prints the corpus
//
// Same harness as eval-routing.ts — SERVER_INSTRUCTIONS plus the live
// list_languages/get_language_info schemas and handlers, with create_item
// stubbed so nothing is generated — and a different question. eval-routing
// asserts a known-right answer and fails the build. This one has no right
// answer: it measures coverage and reports what it saw.
//
// It costs real API calls, one conversation per case per run. Start with
// --dry-run, then a --bucket, before the whole corpus.
//
// The output nobody else can give you is the SEARCH VOCABULARY: every term the
// model passed to list_languages, with how many languages came back. A term
// that returns zero is an agent asking for something by a name our catalog
// doesn't answer to — which in production is unmeasurable, because at three
// tool calls a fortnight the histogram would take months to fill.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  SERVER_INSTRUCTIONS,
  listLanguagesTool,
  getLanguageInfoTool,
  handleListLanguages,
  handleGetLanguageInfo,
  type ToolContext,
} from "../src/tools.js";
import type { AuthContext } from "../src/api.js";
import { CORPUS, BUCKETS, type Bucket, type FitCase } from "./fit-corpus.js";

// --- Arguments ---------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const MODEL = flag("model") ?? process.env.EVAL_MODEL ?? "claude-opus-4-8";
const RUNS = Number(flag("runs") ?? process.env.EVAL_RUNS ?? 2);
const CONCURRENCY = Number(flag("concurrency") ?? 4);
const DRY_RUN = has("dry-run");
const SKILLS_REPO = process.env.GRAFFITICODE_SKILLS_PATH ?? "../graffiticode-skills";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = flag("out") ?? `eval-out/fit-${stamp}.html`;

let cases = CORPUS;
const bucketArg = flag("bucket");
if (bucketArg) cases = cases.filter((c) => c.bucket === bucketArg);
const areaArg = flag("area");
if (areaArg) cases = cases.filter((c) => c.area === areaArg);
const limitArg = flag("limit");
// A cap is a silent lie unless it says so — the report prints what was dropped.
const dropped = limitArg ? Math.max(0, cases.length - Number(limitArg)) : 0;
if (limitArg) cases = cases.slice(0, Number(limitArg));

// --- Observations ------------------------------------------------------------

type Outcome =
  | { kind: "create"; language: string }
  | { kind: "ask"; question: string }
  | { kind: "none"; text: string };

interface Search {
  caseId: string;
  search?: string;
  domain?: string;
  results: number;
}

interface Lookup {
  caseId: string;
  language: string;
  found: boolean;
}

interface RunResult {
  outcome: Outcome;
  searches: Search[];
  lookups: Lookup[];
  turns: number;
}

interface CaseResult {
  case: FitCase;
  runs: RunResult[];
}

const norm = (id: string) => `L${String(id).replace(/^L/i, "").padStart(4, "0")}`.toUpperCase();

// --- The surface under test --------------------------------------------------

const createItemStub: Anthropic.Tool = {
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

// The escape hatch. Without it, "no fit" has nowhere to go but the closest
// language, and the corpus would measure desperation instead of coverage.
const askUserStub: Anthropic.Tool = {
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

function loadSkill(name: string): string {
  const path = resolve(SKILLS_REPO, name, "SKILL.md");
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read ${path}. Set GRAFFITICODE_SKILLS_PATH to the skills repo.`);
    process.exit(2);
  }
}

async function runOnce(
  client: Anthropic,
  ctx: ToolContext,
  c: FitCase,
  system: string,
): Promise<RunResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.prompt }];
  const tools: Anthropic.Tool[] = [
    {
      name: listLanguagesTool.name,
      description: listLanguagesTool.description,
      input_schema: listLanguagesTool.inputSchema as Anthropic.Tool["input_schema"],
    },
    {
      name: getLanguageInfoTool.name,
      description: getLanguageInfoTool.description,
      input_schema: getLanguageInfoTool.inputSchema as Anthropic.Tool["input_schema"],
    },
    createItemStub,
    askUserStub,
  ];

  const searches: Search[] = [];
  const lookups: Lookup[] = [];

  for (let turn = 1; turn <= 8; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system,
      tools,
      messages,
    });

    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      return { outcome: { kind: "none", text }, searches, lookups, turns: turn };
    }

    for (const call of calls) {
      if (call.name === "create_item") {
        const language = norm(String((call.input as { language?: unknown }).language ?? ""));
        return { outcome: { kind: "create", language }, searches, lookups, turns: turn };
      }
      if (call.name === "ask_user") {
        const question = String((call.input as { question?: unknown }).question ?? "");
        return { outcome: { kind: "ask", question }, searches, lookups, turns: turn };
      }
    }

    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      let out: unknown;
      try {
        if (call.name === "list_languages") {
          const args = call.input as { search?: string; domain?: string };
          const r = (await handleListLanguages(ctx, args)) as { languages: unknown[] };
          // The measurement: what it asked for, and how much came back.
          searches.push({
            caseId: c.id,
            search: args.search,
            domain: args.domain,
            results: r.languages.length,
          });
          out = r;
        } else {
          const args = call.input as { language: string };
          try {
            out = await handleGetLanguageInfo(ctx, args);
            lookups.push({ caseId: c.id, language: norm(args.language), found: true });
          } catch (err) {
            lookups.push({ caseId: c.id, language: norm(args.language), found: false });
            throw err;
          }
        }
      } catch (err) {
        out = { error: String(err) };
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }

  // Exhausting the loop is a real outcome, not an error to swallow: an agent
  // that searched eight times and never decided did not find a fit.
  return { outcome: { kind: "none", text: "(tool-loop exhausted)" }, searches, lookups, turns: 8 };
}

/** Bounded parallelism — the corpus is ~40 cases and the API is the slow part. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// --- Reporting ---------------------------------------------------------------

const esc = (s: string) =>
  String(s).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

function summarize(r: CaseResult) {
  const creates = r.runs.filter((x) => x.outcome.kind === "create");
  const langs = creates.map((x) => (x.outcome as { language: string }).language);
  const asks = r.runs.filter((x) => x.outcome.kind === "ask").length;
  const nones = r.runs.filter((x) => x.outcome.kind === "none").length;
  const unexpected =
    r.case.plausible?.length
      ? langs.filter((l) => !r.case.plausible!.map(norm).includes(l))
      : [];
  return { creates: creates.length, langs, asks, nones, unexpected };
}

function renderHtml(results: CaseResult[], meta: Record<string, string | number>): string {
  const byBucket = (b: Bucket) => results.filter((r) => r.case.bucket === b);

  // Per bucket: how often did an agent land on a language at all.
  const bucketRows = BUCKETS.filter((b) => byBucket(b).length)
    .map((b) => {
      const rs = byBucket(b);
      const runs = rs.reduce((n, r) => n + r.runs.length, 0);
      const creates = rs.reduce((n, r) => n + summarize(r).creates, 0);
      const pct = runs ? Math.round((creates / runs) * 100) : 0;
      // For controls, creating is the failure — say so rather than printing a
      // number whose good direction the reader has to guess.
      const reading =
        b === "out-of-scope"
          ? creates === 0
            ? "clean"
            : `${creates} over-reach`
          : b === "covered"
            ? `${runs - creates} discovery misses`
            : `${runs - creates} unserved`;
      return `<tr><td class="k">${b}</td><td class="n">${rs.length}</td><td class="n">${creates}/${runs}</td><td class="n">${pct}%</td><td class="dim">${esc(reading)}</td></tr>`;
    })
    .join("");

  // The headline artifact: search terms and what they returned.
  const searches = results.flatMap((r) => r.runs.flatMap((x) => x.searches));
  const byTerm = new Map<string, { n: number; results: number[]; cases: Set<string> }>();
  for (const s of searches) {
    const key = `${s.search ?? ""} ${s.domain ?? ""}`;
    const e = byTerm.get(key) ?? { n: 0, results: [], cases: new Set() };
    e.n++;
    e.results.push(s.results);
    e.cases.add(s.caseId);
    byTerm.set(key, e);
  }
  const termRows = [...byTerm.entries()]
    .map(([key, e]) => {
      const [search, domain] = key.split(" ");
      const min = Math.min(...e.results);
      const label =
        (search ? `"${search}"` : "(no search)") + (domain ? `  domain:${domain}` : "");
      return { label, n: e.n, min, cases: e.cases.size, zero: min === 0 };
    })
    .sort((a, b) => Number(b.zero) - Number(a.zero) || b.n - a.n)
    .map(
      (t) =>
        `<tr class="${t.zero ? "zero" : ""}"><td class="k">${esc(t.label)}</td><td class="n">${t.n}</td><td class="n">${t.min}</td><td class="n">${t.cases}</td></tr>`,
    )
    .join("");

  const caseRows = results
    .map((r) => {
      const s = summarize(r);
      const outcomes = r.runs
        .map((x) =>
          x.outcome.kind === "create"
            ? `<span class="pill ok">${esc((x.outcome as { language: string }).language)}</span>`
            : x.outcome.kind === "ask"
              ? `<span class="pill ask">asked</span>`
              : `<span class="pill no">no-call</span>`,
        )
        .join(" ");
      const plaus = r.case.plausible?.length ? r.case.plausible.join(", ") : "—";
      const flagText = s.unexpected.length ? `unexpected: ${[...new Set(s.unexpected)].join(", ")}` : "";
      return `<tr>
      <td class="k"><div class="prompt">${esc(r.case.prompt)}</div>
        <div class="dim">${esc(r.case.id)} · ${esc(r.case.area)}${r.case.note ? ` · ${esc(r.case.note)}` : ""}</div></td>
      <td class="b">${esc(r.case.bucket)}</td>
      <td>${outcomes}${flagText ? `<div class="dim">${esc(flagText)}</div>` : ""}</td>
      <td class="dim">${esc(plaus)}</td>
    </tr>`;
    })
    .join("");

  // What an agent reached for but could not use.
  const gaps = results
    .filter((r) => r.case.bucket !== "out-of-scope" && summarize(r).creates === 0)
    .map((r) => {
      const said = r.runs
        .map((x) =>
          x.outcome.kind === "ask"
            ? x.outcome.question
            : x.outcome.kind === "none"
              ? x.outcome.text
              : "",
        )
        .find((t) => t) ?? "";
      return `<li><b>${esc(r.case.area)}</b> — ${esc(r.case.prompt)}<div class="dim">${esc(said.slice(0, 300))}</div></li>`;
    })
    .join("");

  const langHist = new Map<string, number>();
  for (const r of results)
    for (const l of summarize(r).langs) langHist.set(l, (langHist.get(l) ?? 0) + 1);
  const langRows = [...langHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `<tr><td class="k">${esc(l)}</td><td class="n">${n}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Language–agent fit</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e5e5e5; --bg:#fff; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --dim:#999; --line:#2a2a2a; --bg:#141414; --accent:#60a5fa; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 20px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; max-width:1000px; }
  h1 { font-size:21px; margin:0 0 2px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
       margin:34px 0 8px; }
  .sub { color:var(--dim); font-size:13px; margin:0 0 8px; }
  .wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  td, th { padding:6px 8px 6px 0; vertical-align:top; font-size:14px; text-align:left;
           border-bottom:1px solid var(--line); }
  td.n { text-align:right; width:64px; font-variant-numeric:tabular-nums; }
  td.b { width:96px; color:var(--dim); font-size:12px; }
  td.k { max-width:52%; }
  .dim { color:var(--dim); font-size:12px; }
  .prompt { margin-bottom:2px; }
  tr.zero td { color:#dc2626; font-weight:600; }
  .pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:12px;
          border:1px solid var(--line); margin:1px 0; }
  .pill.ok { border-color:var(--accent); color:var(--accent); }
  .pill.no { color:#dc2626; border-color:#dc2626; }
  .pill.ask { color:var(--dim); }
  ul { padding-left:18px; } li { margin-bottom:8px; }
  footer { color:var(--dim); font-size:12px; margin-top:40px; }
</style></head><body>
<h1>Language–agent fit</h1>
<p class="sub">${Object.entries(meta).map(([k, v]) => `${esc(k)}: ${esc(String(v))}`).join(" · ")}</p>

<h2>Coverage by bucket</h2>
<div class="wrap"><table>
<tr><th>bucket</th><th class="n">cases</th><th class="n">created</th><th class="n">rate</th><th>reading</th></tr>
${bucketRows}</table></div>

<h2>Search vocabulary — what the agent asked the catalog for</h2>
<p class="sub">Red rows returned zero languages at least once: a name our catalog doesn't answer to.</p>
<div class="wrap"><table>
<tr><th>term</th><th class="n">times</th><th class="n">min hits</th><th class="n">cases</th></tr>
${termRows || `<tr><td class="dim">no searches recorded</td></tr>`}</table></div>

<h2>Gaps — reached for, nothing usable</h2>
${gaps ? `<ul>${gaps}</ul>` : `<p class="dim">none</p>`}

<h2>Languages chosen</h2>
<div class="wrap"><table>${langRows || `<tr><td class="dim">none</td></tr>`}</table></div>

<h2>Every case</h2>
<div class="wrap"><table>
<tr><th>prompt</th><th>bucket</th><th>outcomes</th><th>plausible</th></tr>
${caseRows}</table></div>

<footer>create_item is stubbed — nothing was generated. Outcomes are stochastic; a split
result across runs is data, not noise to average away.</footer>
</body></html>`;
}

// --- Main --------------------------------------------------------------------

async function main() {
  if (DRY_RUN) {
    console.log(`Corpus: ${cases.length} cases (${RUNS} runs each = ${cases.length * RUNS} conversations)`);
    for (const b of BUCKETS) {
      const rs = cases.filter((c) => c.bucket === b);
      if (!rs.length) continue;
      console.log(`\n${b} (${rs.length})`);
      for (const c of rs) console.log(`  ${c.id.padEnd(22)} ${c.prompt}`);
    }
    if (dropped) console.log(`\n--limit dropped ${dropped} case(s).`);
    return;
  }

  const gcKey = process.env.GRAFFITICODE_API_KEY;
  if (!gcKey) {
    console.error("Set GRAFFITICODE_API_KEY (the catalog handlers hit the live console).");
    process.exit(2);
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error("Set ANTHROPIC_API_KEY.");
    process.exit(2);
  }

  const auth: AuthContext = { type: "firebase", token: gcKey, source: "raw" };
  const ctx: ToolContext = { auth };
  const client = new Anthropic({ apiKey: anthropicKey });

  const system = [
    SERVER_INSTRUCTIONS,
    "\n\n--- Skill: assessments ---\n",
    loadSkill("assessments"),
    "\n\n--- Skill: learnosity ---\n",
    loadSkill("learnosity"),
  ].join("");

  console.log(`${cases.length} cases × ${RUNS} runs = ${cases.length * RUNS} conversations (${MODEL})`);
  if (dropped) console.log(`--limit dropped ${dropped} case(s) from the corpus.`);

  const results = await pool(cases, CONCURRENCY, async (c) => {
    const runs = await Promise.all(
      Array.from({ length: RUNS }, () =>
        runOnce(client, ctx, c, system).catch((err): RunResult => ({
          outcome: { kind: "none", text: `(error: ${String(err).slice(0, 200)})` },
          searches: [],
          lookups: [],
          turns: 0,
        })),
      ),
    );
    const s = summarize({ case: c, runs });
    console.log(
      `${c.bucket.padEnd(13)} ${c.id.padEnd(22)} ${s.creates}/${runs.length} create` +
        (s.langs.length ? ` [${[...new Set(s.langs)].join(",")}]` : "") +
        (s.asks ? ` ${s.asks} ask` : "") +
        (s.nones ? ` ${s.nones} no-call` : ""),
    );
    return { case: c, runs };
  });

  const meta = {
    model: MODEL,
    runs_per_case: RUNS,
    cases: cases.length,
    generated: new Date().toISOString(),
    ...(dropped ? { dropped_by_limit: dropped } : {}),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, renderHtml(results, meta));
  writeFileSync(OUT.replace(/\.html$/, ".json"), JSON.stringify({ meta, results }, null, 2));
  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

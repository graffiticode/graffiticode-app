// Turns one funnel window into a sentence about what MATTERS in it.
//
// The hourly SMS used to be raw facts — "15 anon calls / 2 workspaces · 3
// items". Every hour looked like every other hour, so reading it was work you
// had to do yourself: hold the last few messages in your head, notice that 3 is
// unusual, remember that codex-mcp-client had never appeared before. A number
// you have to diff by hand isn't a signal, it's a chore, and the reliable
// consequence of a chore arriving 13 times a day is that you stop reading it.
//
// So the counters still get computed exactly as before — aggregate() is
// untouched, the report page still renders every one of them — and this module
// sits between the digest and the phone, answering one question: is there
// anything here worth interrupting someone for, and if so, what.
//
// WHAT LEAVES THE MACHINE. The brief below is aggregate COUNTS plus client
// names, assembled from an already-aggregated Digest. It carries no prompt
// text, no session ids or namespaces, no tokens, no email, no IP — the digest
// pipeline never had those to begin with (see the privacy contract in the MCP
// server's src/events.ts), and buildBrief reads only counters. That is the
// property to preserve if this brief ever grows a field.
//
// FALLBACK IS THE POINT. narrate() returns null on every failure — no key, API
// down, timeout, truncated, empty, refusal — and the caller sends the
// deterministic formatSms() text instead. The send policy in funnel-digest.ts
// says every firing sends, so that silence means a broken cron; a narrator that
// could swallow a message would destroy that signal. It can degrade the message
// but it can never cost you one.

import axios from "axios";
import { ANTHROPIC_MODELS } from "./llm-models";
import type { Digest, SplitDigest, RecentWindow } from "./funnel-digest";
import { ptRange } from "./funnel-digest";

/**
 * Opus, not a cheaper tier. The whole job is the judgment call — "is 3 items a
 * lot?", "does a first-ever client kind outrank a gen failure?" — and the thing
 * being economized is attention, not tokens. Thirteen firings a day against a
 * ~1k-token brief is rounding error next to one SMS that buried the one fact
 * that mattered. FUNNEL_NARRATOR_MODEL overrides for an experiment.
 */
const MODEL = process.env.FUNNEL_NARRATOR_MODEL || ANTHROPIC_MODELS.QUALITY;

/**
 * Thinking is on by default on Opus 5 and shares this budget with the response
 * text, so this is deliberately far above what ~220 characters of output needs.
 * Effort `low` is what actually keeps the call cheap and quick; a small
 * max_tokens would just buy a truncation and a fallback.
 */
const MAX_TOKENS = 2000;

/** Never let a slow model delay the SMS. Past this we send the plain counts. */
const TIMEOUT_MS = 60_000;

/**
 * Narration budget, in characters. An SMS segment is 160 and the window+link
 * line spends ~60 of the second one, so this keeps the whole message inside two
 * segments. It is also a content constraint, not just a billing one: the point
 * of the rewrite is a message you read at a glance.
 */
const MAX_CHARS = 220;

const SYSTEM = `You write one SMS line for the founder of Graffiticode, a platform that AI agents (Claude, ChatGPT/Codex, editors) connect to over MCP to build interactive content — assessments, spreadsheets, flashcards, diagrams.

You are given the aggregated counters for ONE time window, plus the same counters for recent prior windows as a baseline. Report the SIGNAL in this window: the thing, if any, that a person would want to know now, and could act on.

Rank what counts as signal, most important first:
1. A stranger got something finished — an item built, a trial claimed into an account. Someone who has never met you used the product successfully.
2. A first-ever: a client kind or a country never seen before. These are marked NEW in the brief; they are never marked twice.
3. A failure a real user hit — a generation failure, an item that failed to build, a language attempted but never built.
4. Volume plainly outside the baseline, in either direction, on strangers' activity.
5. Agent hosts that connected, took the catalog, and called nothing — but only if that number is unusual for the baseline.

Explicitly NOT signal, and never worth a sentence:
- Counts that sit inside the recent baseline. Ordinary is not news.
- Crawler and probe traffic. It is in the brief only so you can recognize it as noise.
- Signed-in activity, which is mostly the founder's own console work. Mention it only to say that it explains what would otherwise look like demand.
- A quiet window. Quiet is a fine answer.

Rules:
- Plain SMS text. No markdown, no emoji, no bullet points, no greeting, no sign-off, no link.
- Aim for under 160 characters. ${MAX_CHARS} is a hard ceiling and anything past it is cut off mid-word, so a message that tries to fit everything in loses its own ending.
- Report AT MOST TWO things, and rank ruthlessly. Every counter is one tap away on the report page linked under your line, so leaving something out costs nothing and running long costs the whole message. A window with five notable things still gets two sentences.
- Use only numbers that appear in the brief. Never estimate, extrapolate, or infer a number that is not there.
- Every counter in the brief is an independent total over the window. Never assert that two of them describe the same people, the same session, or the same event — the brief does not say who did what, and joining two lines yourself invents a fact.
- Say what happened, not what it might mean. You cannot see why anyone did anything, so do not guess at motives, intent, or causes.
- If nothing in the window clears the bar, reply with the word "quiet" and at most a few words of qualifier, e.g. "quiet — 1 workspace, nothing built".`;

/** How many prior windows of baseline to keep and show. */
export const RECENT_KEEP = 12;

/**
 * Roll the recent-window list forward.
 *
 * The baseline lives in the digest's own Firestore state rather than being
 * re-derived from Cloud Logging: it must describe exactly the windows that were
 * REPORTED ON, which is what "since the last message" means and what a re-query
 * over fixed clock hours would not reproduce (windows stretch across a skipped
 * run and cover the whole overnight at 8am).
 */
export function pushRecent(prior: RecentWindow[] | undefined, next: RecentWindow): RecentWindow[] {
  return [...(prior ?? []), next].slice(-RECENT_KEEP);
}

function hoursOf(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 3_600_000);
}

function list(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

function sum(map: Record<string, number>): number {
  return Object.values(map).reduce((a, b) => a + b, 0);
}

/**
 * The model's entire view of the window: labelled counters, nothing raw.
 *
 * Written as prose-ish lines rather than JSON on purpose — the labels ARE the
 * definitions ("attempted but never built", "connected and never called a
 * tool"), and a bare JSON key would leave the model to invent what a field
 * means. Sections omit themselves when empty so a quiet window reads as quiet
 * rather than as a wall of zeroes the model feels obliged to narrate.
 */
export function buildBrief(
  split: SplitDigest,
  baseline: { recent?: RecentWindow[] },
): string {
  const a = split.anon;
  const s = split.authed;
  const hours = hoursOf(a.from, a.to);
  const out: string[] = [];

  out.push(`WINDOW ${ptRange(a.from, a.to)} — ${hours.toFixed(1)}h, everything since the last message.`);
  if (a.truncated) {
    out.push("NOTE: the log read hit its page cap, so every count below is a floor, not a total.");
  }

  out.push("");
  out.push("STRANGERS — anonymous, not signed in. This is the demand signal.");
  out.push(
    `workspaces ${a.workspaces.total}${
      Object.keys(a.workspaces.byClient).length ? ` (${list(a.workspaces.byClient)})` : ""
    }`,
  );
  // Novelty is one-way state owned by the total digest, so it is read off
  // split.all: the segments get throwaway seen-sets and their flags are cleared.
  if (split.all.workspaces.newClientKinds.length) {
    out.push(`NEW client kind, never seen before: ${split.all.workspaces.newClientKinds.join(", ")}`);
  }
  if (split.all.workspaces.newGeos.length) {
    out.push(`NEW country, never seen before: ${split.all.workspaces.newGeos.join(", ")}`);
  }
  out.push(`tool calls ${a.context.toolCalls}, edits ${a.context.edits}`);
  out.push(`items built ${a.items.ok}, items that failed to build ${a.items.failed}`);
  // A correct refusal, not a fault — kept off the failure count so the model
  // doesn't narrate a right "no" as the generator breaking.
  if (a.items.outOfScope) out.push(`requests refused as out of scope (no language fits) ${a.items.outOfScope}`);
  if (a.items.firstForAccount) out.push(`of those, ${a.items.firstForAccount} were that account's first item ever`);
  if (a.context.genFailures) out.push(`generation failures ${a.context.genFailures}`);
  if (Object.keys(a.languages.created).length) out.push(`languages built: ${list(a.languages.created)}`);

  // attempted - created, per language: a language someone reached for and got
  // nothing out of. The digest keeps the two apart precisely so this subtraction
  // is possible; handing the model both raw maps would invite it to sum them.
  const unbuilt: Record<string, number> = {};
  for (const [lang, n] of Object.entries(a.languages.attempted)) {
    const gap = n - (a.languages.created[lang] ?? 0);
    if (gap > 0) unbuilt[lang] = gap;
  }
  if (Object.keys(unbuilt).length) {
    // Scoped to the window, and said so: an unqualified "never built" invites
    // the claim that a language has never worked at all, which no counter here
    // can support.
    out.push(`languages attempted in this window that produced nothing in it: ${list(unbuilt)}`);
  }

  if (a.claims.count) {
    out.push(
      `trials claimed into a real account: ${a.claims.count}` +
        (a.claims.transferred ? ` (${a.claims.transferred} items carried over)` : ""),
    );
  }
  if (a.context.claimViews) {
    out.push(`claim page opened ${a.context.claimViews} times (by whom is not recorded)`);
  }
  if (a.reach.agentIdle) out.push(`agent hosts that connected and called nothing: ${a.reach.agentIdle}`);
  if (a.reach.crawlers.sessions) out.push(`crawler/scanner sessions (noise): ${a.reach.crawlers.sessions}`);

  const authedTotal = s.context.toolCalls + s.items.ok + s.workspaces.total;
  if (authedTotal > 0) {
    out.push("");
    out.push("SIGNED IN — mostly the founder's own console and dev work, not demand.");
    out.push(`workspaces ${s.workspaces.total}, tool calls ${s.context.toolCalls}, items built ${s.items.ok}`);
  }

  const recent = baseline.recent ?? [];
  if (recent.length) {
    out.push("");
    out.push("BASELINE — the previous reported windows, oldest first. Strangers only.");
    for (const r of recent) {
      out.push(
        `${r.hours.toFixed(1)}h window: ${r.calls} calls, ${r.workspaces} workspaces, ${r.items} items` +
          (r.claims ? `, ${r.claims} claims` : ""),
      );
    }
  } else {
    out.push("");
    out.push("BASELINE — none recorded yet, so do not describe anything as unusual or typical.");
  }

  const wallTotal = sum(a.walls);
  if (wallTotal) out.push(`\nlimits hit: ${list(a.walls)}`);

  return out.join("\n");
}

/**
 * Flatten whatever came back into one SMS-safe line.
 *
 * A model told "plain SMS text" still occasionally returns a leading dash, a
 * wrapped pair of asterisks, or its own "GC" prefix; none of those are worth
 * discarding an otherwise good sentence over, so they are stripped rather than
 * rejected. Returns null only for output that has nothing left in it.
 */
export function sanitize(raw: string): string | null {
  // Order matters. Every removal runs BEFORE the whitespace collapse, so a
  // deletion in the middle of a sentence closes up instead of leaving a gap.
  // Markdown is stripped by CHARACTER, never by block: a code-fenced answer must
  // lose its fence and keep its sentence, and an earlier version that matched
  // the whole fenced region deleted the narration along with it.
  let text = raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    // Our own prefix, if the model helpfully added it back.
    .replace(/^GC[:\s]+/i, "")
    .trim();

  if (!text) return null;

  if (text.length > MAX_CHARS) {
    const cut = text.slice(0, MAX_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    text = (space > MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
  }
  return text;
}

/**
 * Ask for the window's signal. Null means "use the deterministic text".
 *
 * Raw HTTP over axios rather than @anthropic-ai/sdk, matching every other
 * Anthropic call in this codebase: Next standalone output-tracing does not
 * bundle the runtime config those SDKs load, which 500s the route (see the
 * header on generation-queue.ts).
 */
export async function narrate(
  split: SplitDigest,
  baseline: { recent?: RecentWindow[] },
): Promise<{ text: string; brief: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const brief = buildBrief(split, baseline);

  if (!apiKey) {
    console.warn("[funnel-narrator] ANTHROPIC_API_KEY not set; sending plain counts");
    return null;
  }

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: MODEL,
        system: SYSTEM,
        messages: [{ role: "user", content: brief }],
        max_tokens: MAX_TOKENS,
        // Thinking stays at its default (adaptive on Opus 5) and effort carries
        // the cost control. Disabling thinking on Opus 5 is the documented way
        // to get stray <thinking> tags in the visible text, which here would go
        // straight to a phone.
        output_config: { effort: "low" },
        // No `temperature`: Opus 5 and Sonnet 5 reject sampling parameters.
      },
      {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
    );

    const stop = resp.data?.stop_reason;
    // A truncated or refused narration is not a partial message worth sending —
    // it is a message whose most important clause may be the missing one.
    if (stop === "max_tokens" || stop === "refusal") {
      console.warn(`[funnel-narrator] unusable stop_reason ${stop}; sending plain counts`);
      return null;
    }

    // Join the TEXT blocks. A thinking-capable model leads with a thinking
    // block, so content[0].text is undefined.
    const content = (resp.data?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");

    const text = sanitize(content);
    if (!text) {
      console.warn("[funnel-narrator] empty narration; sending plain counts");
      return null;
    }
    return { text, brief };
  } catch (err: any) {
    // Never throw: the digest job must still send.
    console.error("[funnel-narrator] failed; sending plain counts", err?.message ?? err);
    return null;
  }
}

/**
 * The narrated SMS body.
 *
 *   GC 2 strangers built 3 flashcard sets; first ever from codex-mcp-client.
 *   19:01–20:01 PT · https://console.graffiticode.org/r/<token>
 *
 * The narration is line 1 for the same reason the call count used to be: a
 * phone's unread list shows only the first line. That line now says what
 * happened instead of how many of it there were, which is the whole change.
 * The window and the link move to line 2 — they are what you read once you have
 * decided the first line was worth opening.
 */
export function formatNarratedSms(narration: string, d: Digest, url?: string): string {
  const lines = [`GC ${narration}`];
  const tail = [ptRange(d.from, d.to)];
  if (url) tail.push(url);
  lines.push(tail.join(" · "));
  return lines.join("\n");
}

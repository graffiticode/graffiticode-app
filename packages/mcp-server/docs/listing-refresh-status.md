# ChatGPT listing refresh — where we are

**Pick-up-here document.** Written 2026-09-16 at the end of a long working session. It records
state and decisions, not procedure: the runbook is [`openai-submission.md`](./openai-submission.md)
(§10 tracks the rejection findings, §11 the widget-caching trap) and the canonical copy is
[`openai-listing-copy.md`](./openai-listing-copy.md). **Update this file whenever the state
changes**; a status doc that has gone stale is worse than none, as §11 records at length.

---

## Pick up here — evening of 2026-09-19

**All 5+3 test cases passed in ChatGPT.** Ready for portal submission.

### What's done

1. ✅ **5+3 test cases passed** (2026-09-18):
   - Positive #1: L0180 quiz ✅
   - Positive #2: L0179 invoice (1ms `list_languages`!) ✅
   - Positive #3: L0176 Learnosity ✅
   - Positive #4: L0173 chart + `update_item` refine ✅
   - Positive #5: L0181 flashcards via `get_spec` ✅
   - Negative #1: "What's a bar chart?" — no tool call ✅
   - Negative #2: "Book me a flight" — declined ✅
   - Negative #3: Cross-language item_id — used `get_spec` correctly ✅

2. ✅ **Critical fix deployed** (`mcp-service-00205-dn2`): `list_languages` now fetches the full
   cached catalog and filters client-side, eliminating per-search-term cache misses that were
   causing timeouts in ChatGPT. Measured: 1ms vs 300-500ms+ before.

3. ✅ **Widget clarified** (`mcp-service-00206-rk6`): `get_item` no longer carries widget metadata.
   Widget is on `render_item` only — `get_item` returns raw src/data for programmatic clients.

4. ✅ **Scan Tools simulation** (2026-09-19):
   | Check | Result |
   |-------|--------|
   | Tool count | 7 ✅ |
   | Widget marker | `render_item` only ✅ |
   | `get_item` widget | none (just `securitySchemes`) ✅ |
   | Widget URI | `widget-mcp.fb346b4c.html` ✅ |

5. ✅ **ZIP verified:**
   ```
   graffiticode-skills/dist/graffiticode-plugin-2.1.0.zip
     ref    f2c3035 (2026-09-19)
     sha256 7c7ae8527b36c6edec9be7ecbcb8372fb518e4c18077b4662d2f2eac0dc4faa2
   ```
   Copy: subtitle `Assessments, diagrams and more` (30/30), 3-paragraph description with
   Learnosity Author/Data API, 3 starter prompts (invoice, concept web, Learnosity assessment).

### What's left — portal submission

Follow the checklist below.

**Live right now:** `mcp-service-00209-mf7` (commit `144f237`). **Reconnect before testing** —
clients cache connection metadata.

---

## Pre-submission checklist

Run through this before clicking Submit in the portal.

### 1. Verify infrastructure

```bash
# Health check
curl -s https://mcp.graffiticode.org/health | jq .
# Expected: {"status":"ok"}

# Confirm min/max instances (session state requires single instance)
gcloud run services describe mcp-service --project graffiticode-app --region us-central1 \
  --format="yaml(spec.template.metadata.annotations)" 2>/dev/null | grep -E "minScale|maxScale"
# Expected: minScale: '1', maxScale: '1'
```

### 2. Verify the ZIP

```bash
# Confirm SHA matches recorded artifact
shasum -a 256 ../graffiticode-skills/dist/graffiticode-plugin-2.1.0.zip
# Expected: a428f4155024df1272c65377c6bd9a1b9e74880d447a16d01700004a9f88fd97

# Spot-check contents
cd ../graffiticode-skills && unzip -l dist/graffiticode-plugin-2.1.0.zip
# Expected: plugin.json, mcp.json, .app.json, skills/{render,assessments,learnosity}/SKILL.md
```

### 3. Portal: Upload and Scan Tools

1. Open the **v2 draft** at platform.openai.com
2. Set version to **2.1.0**
3. Upload `graffiticode-skills/dist/graffiticode-plugin-2.1.0.zip`
4. Click **Scan Tools**
5. **Wait for scan to complete**, then verify:

| Check | Expected |
|-------|----------|
| Tool count | **7** (create_item, update_item, render_item, get_item, get_spec, list_languages, get_language_info) |
| Widget marker | On `render_item` **ONLY** (not `get_item`) |
| Widget URI format | `widget-mcp.<hash>.html` (NOT `widget-oai` or `form-widget`) |
| CSP | `resourceDomains` only, no `frameDomains` |

### 4. Verify scan hit the live server

```bash
# Check logs for the scan's tools/list call (within last few minutes)
gcloud logging read 'resource.labels.service_name="mcp-service" AND textPayload:"tools/list"' \
  --project graffiticode-app --freshness=10m --limit=3 \
  --format="value(timestamp,textPayload)"
```

Look for a `[widget] tools/list` line showing the current widget hash. If the hash in the
portal snapshot doesn't match, the scan read a stale cache — wait and rescan.

### 5. Final checks before Submit

- [ ] Version is **2.1.0**
- [ ] All 7 tools visible with correct schemas
- [ ] Widget appears in preview for `render_item` only
- [ ] Starter prompts are the 3 from the ZIP (invoice, concept web, Learnosity)
- [ ] Category is **Productivity**
- [ ] Legal links resolve: `/privacy`, `/terms`

### 6. Submit

1. **Freeze** the metadata
2. Click **Submit for Review**
3. Record submission timestamp here: `_______________`

### 7. After approval

1. Click **Publish** (apps do not auto-list)
2. Verify listing appears in directory
3. Test the 3 starter prompts from a fresh install
4. Update this doc with the approval date

---

## Status at a glance

**2026-09-18, 19:19 UTC — the widget renders inline in ChatGPT.** A person asked for a
five-question quiz through the workspace plugin on `mcp-service-00200-l8w` and it mounted
unprompted (`boot` → `mounted`, no `dump`). It mounts in Claude and Codex too. What blocked it for
two days was not the host: `@graffiticode/l0180-view@0.1.0` had no activity support, so a
multi-question quiz reached a Form that printed the payload instead of rendering it. Fixed by
publishing `l0180-view@0.2.0` and the `@graffiticode/l0180` core it depends on. Full account and
the beacon method in `openai-submission.md` §11.

| | |
|---|---|
| Live in the directory | **v1.0.0**, approved 2026-08-14 |
| Last submission | **v2.0.0, REJECTED 2026-08-30** — "one or more test cases did not produce correct results" |
| The v2 draft | **still editable in the portal** (read back 2026-09-16). This is what resubmits unless changed |
| Resubmission | **not filed.** Blocked on one thing: nobody has run the 5+3 test cases in ChatGPT |
| Server | `mcp-service-00196-jcc` (2026-09-16). Carries `e2365df` — quiz summary + Learnosity ✓ |
| Console | `console-00618-4gk` (2026-09-16), carries the catalog-search work |

---

## The critical path

Submitting as **v2.1.0**, rescanned in the still-editable v2 draft.

1. ~~**Deploy `e2365df`**~~ — **done 2026-09-16**, revision `mcp-service-00196-jcc`. Verified
   live: a 3-question quiz now returns all three questions with ✓ answer keys. The widget hash
   moved to **`2656b7bd`** as expected, so every client's cached build is one behind again.
2. ~~**Build the plugin ZIP**~~ — **done 2026-09-17**, `npm run package` in
   `graffiticode-skills`. The build refuses an uncommitted or stale ref, so it always describes
   a pushed commit. Record the artifact SHA-256 in `openai-submission.md` §2.
3. ~~**Refresh §6's 5+3 test cases**~~ — **done 2026-09-17.** Rewritten around the current
   catalog, every positive executed against production that day with its outcome recorded.
   Two behaviours they depend on were fixed the same day: the `get_spec` bridge (case 5) and the
   phantom "already rendered" claim.
4. **Run the 5+3 by hand in ChatGPT**, on a build whose hash you have checked. This is the
   whole ballgame: the rejection said test cases failed, and two of the five never reached the
   server at all. *Yours — no agent can do it.*
5. **Rescan and resubmit.** Open the v2 draft, set 2.1.0, upload the ZIP, **run Scan Tools**,
   then freeze and submit. *Yours.*

**Step 5's scan is what surfaces the widget, and nothing else does.** The v2 draft's metadata
was captured on 2026-08-18, before OpenAI clients got widget metadata at all (2026-08-31, with
the mount fixes of 09-11 and 09-15). Resubmitting without rescanning ships the August contract
under a new number. Confirm in the scan result that the widget marker lands on `render_item`
only (not `get_item` — that tool returns raw data for programmatic clients), and that the
imported UI resource URI is a `widget-mcp.<hash>.html` one —
a retired `widget-oai`/`form-widget` pointer would make every `resources/read` in review throw
`Resource retired` (`src/server.ts:928`).

Everything else — latency, routing, the widget race, the catalog search — is done and verified.

---

## Capability is not activation (measured 2026-09-17, Codex CLI)

The clean experiment, reproducible with `codex exec --approve-for-me "<prompt>"` and the
Graffiticode MCP server added via `codex mcp add graffiticode --url https://mcp.graffiticode.org/mcp`:

| Prompt | Result |
|---|---|
| "Create a 5-question multiple-choice quiz on the water cycle." | **markdown quiz, no tool call** — twice, in separate sessions |
| "Use the graffiticode MCP server's create_item tool to make a 5-question multiple-choice quiz…" | `create_item` → `render_item` → a real item and link |

Same server, same session shape, same model. The tools were attached and reachable in both — the
first run simply never reached for them. **The difference is the skills**, which the CLI does not
have: they ship in the plugin, and `render` is the one whose entire job is "do not hand back
static markdown when Graffiticode could render it".

Consequences worth holding onto:

- **`SERVER_INSTRUCTIONS` alone did not carry it.** They are delivered at `initialize` and this
  host still answered from its own knowledge. Whatever the snapshot question above turns out to
  be, instructions are not a substitute for a skill.
- **The storefront starter prompts are exactly this shape** ("Create an invoice with line
  items…"). In ChatGPT the plugin carries the skills, so a reviewer should be fine — but any
  environment WITHOUT them can produce a plausible markdown answer and look like a broken app.
- **It settles the app-vs-plugin question empirically.** The app gives a host the capability; the
  skill is what makes it used. That is the whole argument for shipping app-plus-skills rather
  than a bare MCP endpoint.
- **`render_item` polling works unprompted**: one run got `generating` and polled twice more on
  its own until ready, which is the async contract §6 describes.

---

## What is snapshot and what is live (researched 2026-09-17, OpenAI primary docs)

This is the frame for every "will it update automatically" question, and the answer is usually
no.

| | Runtime source | Refreshes without resubmitting? |
|---|---|---|
| Tool **calls**, **results**, **UI resources** (widget HTML, per-language bundles) | live server | **Yes** — always live |
| Tool **definitions** (name, description, schemas, annotations) | last accepted scan | Docs say yes via continuous review; **OpenAI staff said no** on 2026-07-23. Contradictory — do not rely on it |
| **`_meta`**, linked UI resource metadata, **CSP** | submission snapshot | **No** |
| Server **`instructions`** | undocumented | Imported at scan; absent from the refresh sentence. **Assume snapshot** |
| **Skills** (ZIP *or* MCP-served) | submission snapshot | **No.** Stated three times: "ChatGPT and Codex do not fetch them from your MCP server at runtime" |
| Listing copy (`interface.*`) | submission snapshot | **No** |
| Arbitrary non-UI **resources** (`graffiticode://skills/<id>`) | undocumented | Probably never read by ChatGPT at all — "Plugins primarily use tools" |

Three consequences worth holding onto:

- **`skills/list` (SEP-2640) would not buy dynamic skills.** It buys single-sourcing — no ZIP to
  keep in sync — and nothing else. That is why the refresh ships a built ZIP instead.
- **Our MCP resources deliver nothing to ChatGPT.** The runtime GitHub discovery that makes a
  new skill live in ~3.5 minutes serves Claude and any other resource-reading client; ChatGPT
  sees the snapshot taken at Scan Tools.
- **The language catalog may be frozen for ChatGPT.** `buildServerInstructions(getCachedFullCatalog())`
  rebuilds it into `instructions` on every `initialize` — a live mechanism whose output the
  portal appears to snapshot. If so, ChatGPT has been routing against the catalog as of
  submission day, while `list_languages` would have returned the current one all along. **Test
  it in the ChatGPT pass**: ask for a language added since 2026-08-18 and see whether it routes.
  If it does not, the fix is to shrink `instructions` to a stable pointer and let the tool
  result carry the catalog — at the cost of the ~14s discovery call removed on 2026-09-01.

---

## Decisions owed

1. **Subtitle.** Draft holds `Assessments, diagrams and more` (30/30). Proposed:
   `Quizzes, spreadsheets, charts` (29/30) — the live one spends its characters on the two
   words nobody searches. Rationale in `openai-listing-copy.md`.
2. **Description.** Adopt the three-paragraph draft that adds L0177/L0178, or keep v2's
   two-paragraph text and leave both integration languages invisible.
3. ~~**Starter prompt 1.**~~ **Settled 2026-09-17.** The old record was wrong on the facts:
   L0179 formats currency perfectly well *when asked*, it just does not volunteer it. The prompt
   as written produced no `$` anywhere; reworded to end "…and a grand total, formatted as
   currency" (120/128 chars) it returns `format "$0.00"`, `=B2*C2` row totals and `=SUM(D2:D4)`.
   Use the reworded prompt.
4. **L0159.** It is `hidden`, so `matching game` / `memory game` cannot be advertised or routed
   to. Unhide it and both words go into the copy and the catalog; leave it and they stay out.

---

## App vs plugin, and how to test the refresh

Source: advice from ChatGPT on 2026-09-17, pasted into a working session, and **since checked
against OpenAI's primary docs** — see the snapshot-vs-live section above, which supersedes this
one wherever they disagree. The two-layer account below held up; the package format is the
Agent Plugins 1.0.0 standard (`plugin.json` + `skills/<id>/SKILL.md`), and the plugin's
`interface` block is the listing itself. **What did not hold up:** GitHub marketplace import is
workspace-private distribution, *not* a route into the public directory — public submission is
still a ZIP upload at the portal. The testing advice below is unverified but sound, and the
corrections marked in it still stand.

### The two layers

According to that advice, OpenAI uses the two words for different layers:

| | App | Plugin |
|---|---|---|
| What it is | The connection to Graffiticode (our MCP server) | The package users install and invoke |
| Provides tools | Yes | Through an app it includes |
| Carries skills/instructions | No | Yes |
| Can contain several apps | No | Yes |
| Discovery surface | None of its own; sits underneath | **Plugin Directory** |

- **The Plugin Directory is said to be the main discovery surface since 2026-07-09.** A plugin
  bundles apps, skills and app templates. Apps still exist, as the integration layer underneath.
- **What this means for us:** it's the same structure we already submit as
  "app-plus-skills" (runbook §2). The MCP server is the app. The `graffiticode-skills` ZIP is
  the behavioural layer: when to call Graffiticode, which language to pick, how to read the
  result.
- **Why ChatGPT doesn't reliably use a registered server:** the app gives ChatGPT the
  *capability*, and the skill gives it the *workflow*. When the server is connected but never
  gets called, look at the skills and `SERVER_INSTRUCTIONS` before the tools.
- **Corrections to the advice:** its example diagram listed `compile` and `create artifact`
  tools. Neither exists. The real set is the seven tools in `CLAUDE.md`.

### What to test: discovery, then routing, then execution

| Layer | Question | Example |
|---|---|---|
| Discovery | Does ChatGPT see that Graffiticode is relevant, **without being told**? | "Create a polished bar chart showing monthly sales using sample data." |
| Routing | Does it pick the right language? | chart → L0173, spreadsheet → L0179, concept web → L0169, quiz → L0180 |
| Execution | Does the item actually work? | reaches `ready`, the widget mounts, the link opens |

**Prompt categories** (aim for 15–20 prompts across them):

1. **Obvious fit, no mention of Graffiticode.** Bar chart, household budget spreadsheet, water
   cycle concept map, 5-question photosynthesis quiz. This is the harder test and the more
   valuable one.
2. **Explicit invocation.** The same asks, phrased as `@Graffiticode …` or "Use Graffiticode
   to …".
3. **Several languages could apply.** Spreadsheet vs chart, concept web vs assessment, and
   Learnosity only when the user names it (the vendor gate; see `npm run eval:routing`).
   - The advice also listed "Mystic Wonk/L0182". This repo's docs don't record it. Confirm it's
     in the catalog before writing a case for it.
   - The advice said spreadsheet → L0166. **L0166 was deprecated on 2026-08-26. Use L0179.**
4. **Follow-ups that should edit, not restart.** "Make the bars horizontal", "Add March",
   "Make question 3 harder", "Add another category to the budget". Expect `update_item` on the
   existing `item_id`, not a new `create_item`.
5. **Boundary cases: activation vs non-activation.**
   - Should **not** call Graffiticode: "What's a bar chart?", "Give me five ideas for a quiz",
     "Show me how to make a spreadsheet in Excel".
   - **Should** call it: "Create the quiz", "Make the spreadsheet for me".

   These are strong candidates for the 3 negative test cases in §6. They are more realistic than
   "Book me a flight to Tokyo".

**Four configurations**, each run in a **fresh chat**:

- **A.** Plugin not installed (baseline: what ChatGPT does on its own)
- **B.** Plugin installed, no `@` mention (discovery: the most informative one)
- **C.** Plugin installed, with `@Graffiticode` (explicit routing)
- **D.** A fresh conversation for every important case; never lean on earlier context

**Score each run on five things, not a single pass/fail:** activation, non-activation,
language selection, compilation, UX. Also record the chain
*prompt → ChatGPT's interpretation → language → generated item → render*, so a bad result
points to the step that failed.

**Permissions.**
- Test read-only calls and consequential calls separately. OpenAI reportedly has per-app
  permission controls (from "ask before actions" to allowing low-risk actions).
- **Correction to the advice:** we have no publish/share/send tool. Our one consequential call
  is `update_item` (`destructiveHint: true`, `src/tools.ts`).
- The test that matters: does ChatGPT ask for confirmation before `update_item` and not before
  `render_item` / `get_spec` / `list_languages`?

**Don't use `list_languages` as an acceptance test.** It's a good MCP diagnostic and a poor
product test, which matches the 2026-09-01 change to call `create_item` directly. §6 positive
case 1 still describes the old `list_languages → get_language_info` path. Fix it in step 2 of
the critical path.

**Best two end-to-end smoke tests:**
- "Create a polished bar chart using sample data."
- "Make a 5-question multiple-choice quiz on the water cycle."

They exercise two very different languages, and a reviewer understands both without knowing
anything about Graffiticode. Run each with and without `@Graffiticode`.

### How to install the development version (unverified)

- **Public listing:** Plugins → search "Graffiticode" → Install plugin → Connect → new chat
  → `@Graffiticode`. That tests v1.0.0, **not** the refresh.
- **Pre-release (recommended):** use a workspace-private plugin. Workspace settings →
  Plugins → Add → Import marketplace → GitHub repository. Set Graffiticode to *Available*,
  install it yourself, and use **Sync now** after each change instead of waiting for the daily
  sync.
  - This tests the exact manifest + skill + app combination you're about to submit.
  - **Unknown:** whether we have a GitHub plugin repo in the shape this route expects. The skills
    repo is not obviously one.

### Web vs desktop vs mobile

- **Web first.** It's the main acceptance environment and the easiest place to debug, because
  it takes the desktop app's version and cache state out of the picture.
- **Desktop** is a regression pass. If something works on web and fails on desktop, suspect
  client caching before the server; see "two clients, two caches" below.
- **Mobile:** smoke-test the 2–3 key workflows.
- **This does not relax the §5 gate.** The reviewer tests web **and** mobile, so both still need
  a full 5+3 run and a widget render a person has watched.

---

## Verified, with dates

Nothing here should be re-derived. Everything else should be treated as unknown.

| What | When | Result |
|---|---|---|
| Starter prompt routing, 3 runs each | 2026-09-15 | L0179 / L0169 / L0176, 3/3 each; prompts 1–2 route with zero discovery calls |
| Starter prompt generation | 2026-09-15 | 13.0s / 9.7s / 7.4s, contents checked field by field |
| Full routing eval | 2026-09-15 | 14 cases × 3 runs + 10 catalog invariants, all green |
| Catalog search after the console deploy | 2026-09-16 | `invoice`→L0179, `flashcards`→L0181, `quiz`→L0180, `do my laundry`→(none) |
| Widget render on a NAMED build | 2026-09-16 02:45 / 02:49 UTC | L0173 chart and L0169 concept web drew in Codex on `ae93cbff` |
| ChatGPT served the current build | 2026-09-16 16:21 UTC | read the legacy URI, which maps to current — see below |
| Demo sequence end to end | 2026-09-16 | quiz 13.6s → add cloze ~20s → flashcards via `get_spec` ~25-30s |
| Quiz summary + answer key, in production | 2026-09-16, rev `00196` | 3 questions listed, each with its ✓ correct option |

**The rule that makes those dates meaningful:** a render proves nothing unless you know which
build the client loaded. Check before concluding anything:

```bash
gcloud logging read 'resource.labels.service_name="mcp-service" AND textPayload:"resources/read"' \
  --project graffiticode-app --freshness=2h --format="value(timestamp,textPayload)"
```

Current build as of this writing: **`2656b7bd`** (revision `mcp-service-00196-jcc`). It moves on
every deploy that touches `src/widget/` or `src/item-content.ts`.

## Not verified

- ~~**No person has watched a widget render in ChatGPT itself.**~~ **Done 2026-09-18** — see
  the top of this file. What remains unverified is narrower: whether a candidate can ANSWER the
  inline quiz and see it scored inside ChatGPT's sandbox. The scorer is client-side and pinned by
  a jsdom test, but nobody has clicked an option on that host.
- **The multi-question quiz shape in the widget.** A five-question quiz is
  `data.activity.items[]`, a different shape from the single item our mount test covers. That
  exact distinction was broken in the summary extractor until 2026-09-16. Dry-run before filming
  or demoing.
- **Which copy the LIVE v1.0.0 listing shows.** The 2026-09-16 read-back was the v2 draft.
  Whether any v2 copy reached the published listing through post-approval editing is unanswered.
- **L0180 and L0181 rendering in any OpenAI host.**

---

## What we learned that is not obvious

**Clients mount the widget build they cached, not the one we serve.** The resource URI is
content-hashed so new content cannot be served from a cache keyed on a stable URI — but the URI
itself arrives in `tools/list`, and these clients cache that. One read a build from five days
earlier seventy seconds after a fresh `tools/list`. Two diagnoses were wrong before this was
understood. Full account in §11.

**The legacy URI is a working escape hatch.** ChatGPT's runtime asks for
`ui://graffiticode/claude-form-widget.html`, from before content hashing existed, and
`src/widget/index.ts:52` maps it to the **current** widget. So ChatGPT gets today's build
despite an ancient cached id — which is why the caching trap is survivable at all. Do not remove
that shim.

**OpenAI scans the server daily at 14:21 UTC**, on the minute, reading `tools/list` and the
widget resource, and it does take the current URI. It is not what refreshes what a user's
client mounts.

**One product, two clients, two caches.** `codex-mcp-client` (local, refreshed on launch) and
`openai-mcp (Codex)` (OpenAI's cloud side, its own snapshot) loaded different builds ninety
seconds apart in the same session. That alone can produce a "renders on mobile, card on desktop"
split with no code difference — which is what the 2026-09-11 finding probably was.

**Codex flips its capability declaration between launches** of the same binary, so it lands on
the `mcp-apps` route or the `openai` route at random. Both must work; this is why the transport
is raced rather than guessed.

**Empty summaries hide behind widgets.** Three languages returned a title and a link and nothing
else — L0169, L0180 multi-question, and every Learnosity answer key — because a widget host
mounts the real component and never reads the summary. The only clients that can see the bug are
the ones we were not watching. Assume the next one is broken too until a payload is checked.

**Evals go stale silently.** Two routing cases asserted a catalog that no longer existed and
were only caught because unrelated work forced a full run.

---

## The 90-second screencast (for the listing)

Four shots, all dry-run against production on 2026-09-16.

1. **"Make a 5-question multiple-choice quiz on the water cycle."** (~14s) — it mounts, and
   **you answer a question on camera and it scores you.** That shot is the whole pitch.
2. **"Add a fill-in-the-blank question about condensation."** (~20s) — returns as question 6, a
   text-entry blank accepting "condensation". Refinement is just talking.
3. **"Turn that into a flashcard deck for studying."** (~25-30s) — `get_spec` carries the
   content across languages: 6 cards, each question mapped to its answer. L0181 renders
   natively as of 2026-09-16.
4. **"Open in Graffiticode"** — it persists and it is editable.

Leave out the Learnosity integration recipes (spec prose, bad on video) and anything unverified
on the host you record in. Three generations is ~60s of a 90s video, so trim in post but leave
the progress line visible for a beat — "11s, ~433 tokens written" reads as working rather than
hung. If a `render_item` errors, ask again; one timed out and succeeded on retry.

---

## Where things live

- **Runbook and reviewer materials:** `openai-submission.md` (§10 rejection findings, §11 caching)
- **Canonical copy, per version:** `openai-listing-copy.md` (read-back, proposals, verification)
- **Routing eval:** `npm run eval:routing`, or `-- --only starter` for the three storefront
  prompts. Re-run after touching `SERVER_INSTRUCTIONS`, tool descriptions, or the catalog.
- **Catalog search:** lives in the **console** repo (`src/lib/languages.ts`), not this one.
- **Scheduled reminder:** routine `trig_011UsNKpmrBBdVJr8eNBwz3j`. It fired 2026-09-16 14:45 UTC,
  confirmed no `src/` drift, and correctly refused to fake the ChatGPT test rather than invent a
  result. A one-shot; re-arm it with a new `run_once_at` if you want another.

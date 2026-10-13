# Language contract: routing & composition

What each Graffiticode language (`l0NNN`) must provide so the console can **route requests to
the right language** and **compose languages safely**. The model is server-authoritative:

- **Routing** decides the *head* language for a request. The client's chosen `language` is a
  hint; the server validates it against each language's `scope.json` and re-routes if wrong.
  (Clients — especially Codex/ChatGPT — freelance; routing cannot depend on them.)
- **Composition** is **reactive**, and governed by an explicit per-language `composesWith`
  allowlist (the hard fence). Nothing decides to compose before generation: the head generates
  first, and if the program it wrote emits `data use "<lang>"`, the console generates that
  upstream — provided the allowlist permits it. The client never composes.

Both decisions are only as good as the metadata each language publishes. This doc enumerates
that metadata, per language.

---

## 1. Every language: `scope.json` (the routing contract)

Served at `https://l<id>.graffiticode.org/scope.json`; the console fetches it in
`listLanguages()` (cached ~5 min). The pre-flight router (`classifyAndRoute` in
`src/lib/language-router.ts`) hands the current language's scope + a catalog of the others to a
classifier that decides in-scope vs. re-route.

Required fields:

- **`summary`** — one sentence: what this language *authors*. Do **not** over-claim adjacent
  domains. (Lesson: L0166 led with "spreadsheet-based **assessment**," which made the router
  judge ELA assessment items in-scope for a spreadsheet. It now leads with "interactive
  spreadsheets.")
- **`in_scope`** — concrete, specific capabilities. Specific beats broad: it both helps the
  router land *here* for the right requests and keeps it from landing here for the wrong ones.
- **`out_of_scope`** — the load-bearing field for routing accuracy. List **domain boundaries**,
  not just architectural exclusions. Explicitly disclaim the adjacent things this language could
  be *mistaken* for. Ask: "what would a confused client wrongly send here?" and name it.
  - Good: *"Authoring assessment items/questions as content — reading-comprehension/ELA items,
    MCQ/EBSR/short-answer, passages, stems, answer keys. L0166 authors a spreadsheet
    interaction, not question items."*
  - Weak: only listing "pivot tables, external imports, host embedding" (architectural).

**Rule of thumb:** the clearer a language *owns* its niche (`summary`/`in_scope`) and *disowns*
its neighbors (`out_of_scope`), the more deterministic routing becomes. The classifier is an LLM
with a logged fail-open — the scope contract is the determinism lever, not prompt tuning.

## 2. Every language: console registration

Add an entry to `LANGUAGES` in `src/lib/languages.ts`:

- `id`, `name`, `description`, `domains` — basic catalog fields.
- `routingHint` — fallback descriptor used before `scope.json` is fetched (cold start).
- `status` — `"Beta"`, `"Internal"`, etc.
- `internal: true` — for non-authoring dialects (e.g. the L0010 planner, L0013). Internal
  dialects are excluded from routing targets and never proposed as composition upstreams.
- `composesWith` — see §4.

`domains` is an attractor: don't tag a language into a domain (e.g. `"assessments"`) it only
*supports* indirectly — that draws mis-routes. (L0166 stays in `assessments` because it embeds
into Learnosity assessments, but its `scope.json` must then disclaim *authoring* assessment
items.)

## 3. Every language: out-of-scope sentinel (secondary net)

The generation instructions (`instructions.md`) already carry an "Out-of-Scope Detection"
block: if a request is clearly outside the dialect, emit `OUT_OF_SCOPE: <reason>` instead of
generating. This is the **backstop** behind the pre-flight router (it fires if routing missed).
Keep it. It's biased toward "when in doubt, generate," so it is not a substitute for a sharp
`scope.json`.

---

## 4. Composition: two separate things

Composition needs **both** of the following, and they are owned in different places. Confusing
them is the mistake this section exists to prevent.

### 4a. Permission — `composesWith` (the console decides)

The permission matrix is the **hard fence** — composition can only happen along declared edges.
Set `composesWith` on the language's `LANGUAGES` entry (`src/lib/languages.ts`). Enforced by
`composesWithFor` + `fenceComposition` in `src/lib/language-router.ts`.

- **Explicit list** (`composesWith: ["0179"]`) — may compose ONLY with those upstreams. Use for
  widget-embedding hosts (L0176 embeds the L0179 spreadsheet as a Learnosity `custom` question —
  the only product edge). L0000 also declares `["0000"]` — self-composition, an internal test of
  the `data use` path with no second language involved (2026-09-22).
- **`["*"]`** — *may* compose with any non-internal authoring language; the broad wildcard. Use
  only when a host genuinely consumes from anything. Prefer an explicit list — `["*"]` is a wide
  trust grant.
- **Absent / empty** — **atomic only.** No composition. This is the default and correct for
  nearly every language (e.g. L0175 ELA — it never composes; it authors complete items itself).

A permission is **not** a trigger. Declaring an edge costs nothing at runtime and makes nothing
happen: if the head's generator never emits the binding, the language is atomic in practice.

**Removing an edge** stops NEW compositions only. Bindings already present in an item's source
are grandfathered at edit time (`extractLangIds(currentSrc)` in `generate-for-request.ts`), so an
item built on an edge that has since been withdrawn still edits and still renders.

> `composesWith` lives in the console's static `LANGUAGES`. Adding a composition edge is a
> console change, not a language-repo change. (Planned: move it into each `scope.json` so
> languages self-declare.)

### 4b. Trigger — your `instructions.md` (the language decides)

**A language that wants to compose must teach its own generator when to bind.** This is the whole
trigger; there is no planner. `instructions.md` needs a section that says, in the dialect's own
terms, which request shapes require an upstream and which upstream each maps to — see L0176's
"Pipeline Composition" section for the reference implementation (a content-type → upstream-id
table, the exact syntax, and a finish-time self-check).

There used to be a pre-flight LLM planner (`planSequence` / `planComposition` / an L0010
planning-RAG corpus) that decided this from catalog blurbs before any code existed. It was
removed on 2026-09-09. It guessed, and its guesses failed in the direction that reads worst to a
user: an upstream stage would refuse the whole request with **its own** `OUT_OF_SCOPE:` sentinel,
so someone who asked L0173 for an interactive bar chart was told that L0170 has no charting
capabilities — a refusal from a language they never named, about a capability the language they
did name has. A dialect knows when it needs an upstream; a router reading a one-line summary does
not.

## 5. Composition — as a HEAD (consumer)

If your language consumes an upstream:

- **Emit the binding when you author the embed, in the same breath.** The head MUST author
  `data use "<lang>"` (where `<lang>` is the upstream id) so the upstream's compiled output flows
  in at runtime. A head that describes the embedded content but omits the binding renders an
  **empty** interaction — and, now that the binding is also the *trigger*, omitting it means no
  upstream is generated at all.
  - Make this a **hard requirement** in `instructions.md`, with a finish-time self-check —
    not a soft "preferred." (Lesson: L0158 dropped the `data use "0166"` binding ~40% of the
    time.)
- **If the upstream fails, the console retries your head atomically** — one regeneration with a
  directive to author the content inline and emit no binding — rather than handing the user the
  upstream's error. So a dialect that *can* author the content itself should be able to; say so
  in `instructions.md` (L0176 documents a direct-table form alongside the L0179 embed). If the
  retry still emits a binding, the request fails with an error naming your language and the
  upstream.
- The surrounding `custom`/embed node's `lang` should equal the `use` argument.

## 6. Composition — as an UPSTREAM (provider)

If your language feeds a head (data provider or embeddable widget):

- **Produce a consumable, schema-stable data model.** The head binds your output via the
  base-language `data {}` primitive; a stable shape is what makes the edge work.
- Publish a `schema.json` the console can fetch (the reactive path reads `L<lang>/schema.json`
  when generating the upstream).
- Render sensibly **standalone** too (with empty `data {}`), so the upstream task previews on its
  own before it's chained.

## 7. Cross-language reuse (`get_spec`)

`get_spec` produces a platform-neutral English spec of an item so its content can be re-authored
in another language. For this to be faithful, your language must provide:

- **Lexicon** (`getLanguageLexicon`) and **unparse-hints** (`getLanguageHints`) — `get_spec`
  decompiles the AST via `unparse(code, lexicon, { hints })`. Missing/empty lexicon or hints →
  low-fidelity spec.
- **`instructions.md`** — reused (canonical semantics) by the spec generator.
- Keep authored content as readable string literals in the AST where possible — the spec's
  fidelity guard checks that salient authored strings survive into the spec.
- **`spec-directive.md`** (OPTIONAL, `getLanguageSpecDirective`) — overrides the global
  content-oriented `SPEC_DIRECTIVE` so a dialect can shape what `get_spec` emits. Absent → the
  global directive is used (unchanged). Used by the developer-integration "oracle" dialects (e.g.
  L0177) to emit a language-neutral **recipe** — goal, preconditions, procedure, gotchas,
  acceptance criteria — instead of a content description.

## 8. Operational notes

- **Caching:** `scope.json` and language docs are cached in the console ~5 min. After you change
  a language's `scope.json`/`instructions.md`, **redeploy that `l0NNN` service** (`npm run
  gcp:build`), then allow the console's fetch-cache TTL to lapse before the change takes effect.
- **Verify routing** via `npm run gcp:logs`: look for
  `[routing] … preflight.reroute from=… to=…` (re-route happened),
  `[routing] … scope-gate … inScope=…` (every decision),
  `[composition] … head=L… permits=[…] upstreams=[…]` (one line per run, composing or not), and
  `[composition] … fallback.atomic head=L…` (an upstream failed and the head was retried alone).
- **Kill switches:** `SCOPE_GATE_ENABLED=false` disables routing; `COMPOSITION_ENABLED=false`
  forces everything atomic.

---

## Quick checklist per language

| Concern | Provide |
| --- | --- |
| **Routing in** | sharp `scope.json` `summary` + `in_scope`; accurate `domains`/`routingHint` |
| **Routing out** | `out_of_scope` naming the adjacent things you'd be mis-sent (domain boundaries) |
| **Backstop** | `OUT_OF_SCOPE:` sentinel in `instructions.md` |
| **Compose: allowed?** | `composesWith` on the `LANGUAGES` entry (explicit list e.g. `["0179"]` / `["*"]` wildcard / omit ⇒ atomic) — a permission, not a trigger |
| **Compose: when?** | a section in your own `instructions.md` mapping request shapes to upstream ids (L0176's "Pipeline Composition" is the reference) — this is the only trigger |
| **Compose: as head** | `instructions.md` makes `data use "<lang>"` a REQUIRED binding + self-check |
| **Compose: as upstream** | stable data model + `schema.json`; renders standalone with empty `data {}` |
| **Cross-language** | lexicon + unparse-hints + `instructions.md` for `get_spec` |
| **Internal dialect** | `internal: true` in `LANGUAGES` (excluded from routing & composition) |

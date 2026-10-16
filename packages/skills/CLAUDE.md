# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

There is no source code, no build, no test suite, and no lint step. The repo is
the source of truth for Graffiticode's agent **skills**: each top-level directory
is one skill, containing a single `SKILL.md` — YAML frontmatter (`name`,
`description`) followed by a markdown body that instructs an AI agent on how and
when to use the Graffiticode MCP tools.

The artifact being edited is *agent behavior*. A change to a skill body changes
what agents do; a change to a frontmatter `description` changes *whether they
fire at all* (see Routing below).

## Editing a skill = deploying it

`graffiticode-mcp-server` discovers this repo **at request time** over the GitHub
contents API against the **default branch**, and serves each skill as an MCP
resource at `graffiticode://skills/<dir-name>`. Nothing is copied into the
server; there is no generated artifact and no redeploy.

Consequences to hold in mind:

- **A push to `main` is a production deploy**, and that is the intended workflow —
  push to `main`, don't open a PR for a skill edit. **Measured: ~3.5 minutes to go
  live**, not the ~60s you would guess from the cache TTL — GitHub's raw-CDN
  propagation is the dominant term. Rollback is a revert and a push, live again on
  the same timescale.
- **Because there is no review gate, the checks are the gate.** Run
  `npm run validate` before pushing and `npm run smoke` after (see Validation
  below). CI runs both.
- **The directory name is the skill id** — renaming a directory changes the
  resource URI and breaks anyone referencing the old one.
- **A directory with no `SKILL.md` is skipped by the server.** This is the
  mechanism behind `forms/SKILL.md.draft`: it is held, not served. Promote it
  with `git mv forms/SKILL.md.draft forms/SKILL.md` — but only once the L0174
  webhook backend it documents (binding, terminal POST, signing secret,
  `submit_url`/`webhook` response fields, structured errors) actually ships. A
  skill that documents a backend that doesn't exist is worse than no skill.
- **The frontmatter must parse**, and the `description` becomes the resource
  description clients read. Verify frontmatter by eye before pushing; nothing
  will catch a malformed one for you.

To use a skill locally: `cp -r <skill> ~/.claude/skills/user/` and restart Claude
Code.

## Routing: the skills form a deliberate precedence hierarchy

The three served skills are not independent — they are a routing tree, and the
frontmatter `description` of each is the routing surface an agent reads.

- `render` — the **broad default**. Fires for any structured/visual/interactive
  output (charts, tables, diagrams, dashboards) instead of static markdown. It
  explicitly defers to the narrower skills.
- `assessments` — narrower: quizzes, flashcards, spreadsheet problems,
  subject/grade-specific items. Routes *by language `description`*, so a new
  specialist dialect wins automatically without a skill edit.
- `learnosity` — narrowest, and **gated**: it may only be used when the user has
  actually *named* Learnosity (or an Item Bank / the Items API / a
  Learnosity-integrated LMS).

**The vendor gate is the single most load-bearing invariant in the repo.** It is
stated in all three skills, deliberately and redundantly: question type (MCQ,
cloze, short text) is *never* a reason to route to Learnosity — every platform
has those shapes; only the user naming the vendor is. `assessments` has **no
general fallback** on purpose — when nothing matches, the correct behavior is to
tell the user what exists and ask, never to quietly pick the nearest language.
If you weaken this in one file, weaken it nowhere; if you change it, change all
three (git history shows it being *strengthened* repeatedly — treat regressions
here as bugs).

## Validation

```bash
npm run validate   # before pushing — frontmatter, invariants, cross-refs, README sync
npm run smoke      # after pushing — asks the live MCP server what it is serving
```

**`validate` parses frontmatter with a real YAML parser, which is stricter than
the MCP server's.** The server is lenient: it will serve a description containing
a bare `key: value` colon that spec YAML rejects outright. But these skills are
also installed directly into `~/.claude/skills/`, and *that* consumer does use a
real parser — so a skill can look fine over MCP and be broken on install. The
strictest consumer sets the bar. This is not hypothetical; it has already
happened once. Keep colons out of unquoted descriptions (the existing ones use
` — ` and ` - ` for exactly this reason).

**`smoke` compares the *served* description against the local one, and that is
the check that matters.** `resources/read` returns raw markdown and never parses
frontmatter, so a skill with broken YAML reads back perfectly while quietly
failing to appear or update in `resources/list` — the surface agents actually
route on. Only the listing comparison catches it. It polls, because the server's
~60s cache means a fresh push is legitimately not live yet; a mismatch that
survives the cache window is real.

`validate` also mechanically enforces the invariant below: no `L0xxx` in a served
skill body.

## How to add a capability without pinning to a language ID

The "never hardcode language IDs" rule forbids naming IDs — it does not forbid
teaching capabilities. The two come apart if you split knowledge by how fast it
changes:

- **What languages exist and what each does right now** → the catalog
  (`list_languages`, `get_language_info`, `when_to_use`, `not_for`). Discovered
  every session. Never restated in a skill.
- **What *jobs* a domain contains, how to tell which one you're in, and the
  contract for driving each** (what you send, what comes back, what "done"
  looks like) → the skill. Stable across catalog churn.

So a capability is written as a **job in the user's or the vendor's vocabulary**
("embedding the Learnosity authoring experience in your app"), never in
Graffiticode's ID space. Vendor terms — Author API, Item Bank, item editor — are
safe to name in a vendor-scoped skill; `L0177` is not.

The routing key is then each language's **self-description, including its
negative clauses**: the integration languages are the ones whose `when_to_use`
says they produce integration recipes and say explicitly that they do *not*
author item content. Routing on a negative clause survives renumbering,
deprecation, and new domain members — which is how the
deprecated-legacy-item-language rule already works. But a negative clause is
only a discriminator while it picks out *one* language: when the data-plane
member joined, "does not author item content" started matching two, and the
skill had to move to the axis the languages state about themselves (a UX of the
data versus the data). Check that a negative clause still separates before
relying on it. `learnosity/SKILL.md` ("Three jobs live in this domain") is the
worked example; copy its shape. `assessments/SKILL.md` follows it — its job map
replaced a shape-to-language lookup table that had silently rotted as the
catalog moved underneath it.

Capability boundaries that are still moving (does the domain cover delivery yet?
rendered reports?) belong in the catalog, not the skill —
point the agent at `get_language_info`'s `supported_item_types` / `not_for`
rather than freezing an answer that will rot.

## Invariants repeated across skills — keep them in sync

When you edit one of these sections in any skill, check whether its siblings need
the same edit. They are duplicated by design (each `SKILL.md` must stand alone),
which means they drift silently.

- **Never write Graffiticode DSL / vendor JSON directly.** All generation is by
  the backend from a natural-language `description`; the skill's job is to write
  a *good prompt*, not code.
- **Never hardcode language IDs.** Always discover via `list_languages`
  (domain-scoped where possible). The catalog is dynamic.
- **Iterate, don't recreate.** `update_item(item_id, …)` preserves conversation
  history; a fresh `create_item` loses it.
- **The widget is the rendering.** The agent's reply is one line, drawn from the
  response's own `description` / `change_summary` — never a markdown simulation
  of the item, its options, or its answer key.
- **Free-plan `view_url` / `claim_url` / `claim_message`.** Surface only values
  the server returned; free-plan items expire after 48h unless claimed.
- **`get_spec` is the only bridge between languages.** Never pass an item's
  `src`, `data`, or id into another language's `create_item` — they are private
  to their own language. This is what makes composite requests ("an ELA item
  *for Learnosity*") a round-trip: author the inner content in its specialist,
  `get_spec` it, then create the host item from that spec.

## Writing style for skill bodies

Match the existing voice — these files are prompts, and the prose is doing work.
Imperative and addressed to the agent ("Call `list_languages`…", "Do not
skip…"). Rules carry their rationale inline, because an agent that knows *why*
generalizes correctly to cases the skill didn't enumerate. Bad/Good example
pairs for `description` quality are a recurring, effective device. Every skill
ends with a `## Guardrails` section of hard negatives.

## Also update the README

`README.md` carries the skill table, the drafts table, and the description of the
MCP discovery flow. Adding, renaming, or promoting a skill means updating it in
the same commit.

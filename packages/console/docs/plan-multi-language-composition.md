# Multi-Language Composition — Shipped Mechanism

> **Status:** describes what the console *actually does* today. An earlier draft
> of this doc proposed a `NEEDS_INNER` signal plus a Haiku "router-as-planner"
> (`planInnerForRequest`). That approach was **not implemented** — there is no
> `NEEDS_INNER` handling or `planInnerForRequest` in the code. The shipped design
> is **reactive AST discovery**: the head generation model writes a
> `data use "<id>"` annotation into the code, and the console discovers it
> structurally. The proactive `classifyComposition` / `orchestrateComposition`
> functions exist in `src/lib/language-router.ts` but are currently **dead code**
> (imported at `src/pages/api/resolvers.ts:9`, never called).

## Context

Some requests need more than one dialect — e.g. an L0158 Learnosity question whose
interaction is an L0166 spreadsheet. The L0166 compile output becomes the `data`
of the L0158 program. The runtime composes this transparently via the `id1+id2`
chained-id primitive: api.graffiticode.org compiles the right-hand (inner) task
first and feeds its output as `data` to the left-hand (outer) task, whose compiler
performs the composition.

What the console adds is the generator-side piece that decides "this prompt needs
an upstream," generates each task, and returns a chained task id.

## How it works (reactive discovery)

The flow lives in `src/pages/api/resolvers.ts` (the code-generation resolver) and
`src/lib/composition-discovery.ts`:

1. **Head generation.** The head dialect's generation model runs as usual
   (`codeGenerationService`, per-lang prompt + RAG). When the user's request calls
   for upstream data from another dialect, the model writes a `data use "<id>"`
   annotation directly into the generated source. This is RAG-/instructions-driven
   — nothing outside the model decides the upstream id; it falls out of the head
   dialect's own training.
2. **Parse.** `parseCode` turns the head source into an AST node pool.
3. **Discovery.** `resolveUpstreams(code)` (`src/lib/composition-discovery.ts:13`,
   called at `resolvers.ts:490`) walks the node pool for the
   `DATA( USE( STR("<id>") ) )` pattern, in scan order. Each id is validated
   against `^\d{3,5}$`; a non-id `use` argument throws a composition error. It
   returns the ordered list of upstream language ids.
4. **Upstream generation.** Each discovered upstream is generated **in parallel**
   with the **verbatim** user prompt (`resolvers.ts:499-513`) — no scoped
   sub-prompt is synthesized; each upstream's own RAG scopes the work. A failed
   upstream (errors, or no task id) aborts the whole generation.
5. **Head post + chaining.** The (possibly rewritten) head AST is posted via
   `postTask`, yielding `headTaskId`. The final task id is
   `headTaskId+upstreamTaskIds.join("+")` (`resolvers.ts:542`) — **outer/head
   left, inner/upstream right**, matching the chained-id semantics in
   `src/utils/swr/fetchers.ts`.

### Chained-id encoding

The `+`-joined id is the surface form. `src/utils/storage/firestore.ts:12-51`:

- `encodeId({ taskIds })` — base64url of `{"taskIds":[...]}`.
- `decodeId(id)` — splits on `+`, base64url-decodes each segment, flattens all
  `taskIds` arrays into one list.
- `appendIds(id, …others)` — decodes each and re-encodes into a single base64url
  wrapper (used when merging ids after the fact).

So `headTaskId+upstreamTaskId` is two independently-decodable segments joined by
`+`; each segment is itself a base64url-wrapped `taskIds` array.

## Console vs. runtime gap (multi-upstream)

> **Known gap — documented, not resolved.** `resolveUpstreams` can discover and
> chain **multiple** upstreams (`head+u1+u2+…`), but the runtime
> (`compile(code, data, …)` in basis / l0000) feeds a **single** `data` value. The
> fully-supported path today is one head + one upstream (`head+inner`). Multiple
> upstreams are emit-able by the console but not consumable by the runtime. See
> `docs/pipeline-imports-spec.md` for the runtime side.

## Routing note

Composition routing here is **reactive and model-mediated**: the head model itself
selects the upstream id by writing `data use "<id>"`. This is distinct from the
out-of-scope language router (`findBestLanguages`, called from
`src/lib/code-generation-service.ts` on the `OUT_OF_SCOPE:` path), which suggests a
*replacement* dialect when a prompt doesn't fit the current one — see
`docs/plan-out-of-scope-routing.md`. The proactive composition planner
(`classifyComposition` / `orchestrateComposition`) is not wired in.

## Verification

End-to-end (browser):
1. `npm run dev`, sign in, set chat lang to a head dialect (e.g. 0158).
2. Prompt something that needs an upstream, naming the dialect id (e.g.
   "create a budget spreadsheet assessment, use 0166 for the spreadsheet").
3. Server logs should show `[composition] … reactive upstreams=0166`
   (`resolvers.ts:494`), an L0166 generation, then a head post.
4. The final task id is the chained `head+inner` string; `/items` shows a single
   row under the head dialect; the chained id appears in the item's `taskId`.

Code checks:
- `src/lib/composition-discovery.ts` matches `DATA(USE(STR))` + `^\d{3,5}$`.
- `resolvers.ts:499-544` generates upstreams with the verbatim prompt and joins
  ids with `+`.
- `classifyComposition` / `orchestrateComposition` have no call sites
  (`grep -rn` finds only the definition and the unused import).
- `npm run lint && npm run typecheck` pass (docs-only change here).

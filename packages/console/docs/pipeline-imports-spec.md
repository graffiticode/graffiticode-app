# Graffiticode Pipeline Imports — Spec

> **Status:** describes the *shipped* mechanism. An earlier draft of this doc
> specified a two-function `data` / `typed-data` model that was never implemented.
> The shipped design is a single `data` builtin with a nested `use` form.
> The authoritative source is `l0000/packages/core/spec/usage-guide.md`
> ("Composition: `data use \"<lang>\"`"); this file mirrors it from the console's
> point of view.

## Summary

A Graffiticode program reads data from one upstream pipeline node through the
base-language `data` builtin. There are two forms:

- `data {x: 1, y: 2}` — declares a **default record**. If an upstream task is
  chained to this program at compile time, the upstream's compiled output replaces
  the default; otherwise the default is used. No language coupling, no schema
  validation.
- `data use "0166"` — declares that the upstream is expected to be a program in
  dialect **L0166**. The host fetches L0166's `schema.json` at compile time and
  validates the chained upstream value against it. If no upstream is chained,
  `data use "<lang>"` falls back to `{}`.

`data` and `use` are both arity-1 functions, so the two forms are **mutually
exclusive** within a single `data` call. Choose `data use "<lang>"` when you want
the host to discover the upstream automatically and validate its shape; choose
`data {…}` when you want a default value baked in and the chain wired manually.

There is **no `typed-data` function** in basis or in any dialect. Schema
validation rides on the `use` form of `data`.

The threat model is **accidents only**: prevent authors from consuming a
malformed or wrong-shaped upstream. Adversarial scenarios are out of scope.

## Surface syntax

### Default record (untyped)

```
let x = data {default}
```

Returns the upstream's compiled output, or `{default}` if no upstream is wired.
No schema validation.

### Declared upstream language (validated)

```
let x = data use "0166"
```

Returns the upstream's compiled output validated against L0166's schema, or `{}`
if no upstream is wired.

### Language ID forms

The `use` argument is a language id string. The compiler accepts a bare numeric
id and validates it against `^\d{3,5}$`; a non-id argument is a compile error
(`use: argument must be a language id, got "<x>"`). In the console's lexicon and
docs the canonical written form is the bare number (e.g. `"0166"`).

## Semantics

### Compile-time validation

Validation happens during compilation, not parsing. The parser produces a purely
syntactic AST (`DATA(USE(STR("0166")))`); the compiler resolves and validates it.

When the compiler evaluates `data use "0166"`
(`l0000/packages/core/dist/compiler.js:1267-1318`, identical logic in
`basis/src/compiler.js`):

1. **`USE`** visits the `STR` child to get the language id, validates `^\d{3,5}$`,
   then fetches `L<lang>/schema.json` over HTTP. The fetch is cached in-process
   (~1h TTL). Fetch failures surface as compile errors
   (`use: failed to load L<lang>/schema.json: …`). The schema is attached to the
   returned record on a hidden Symbol key (`SCHEMA_SYM = Symbol.for("gcSchema")`).
2. **`DATA`** reads the upstream value from `options.data` (unwrapping a
   `{ data, errors }` envelope if present), reads the schema off the `use` record's
   `SCHEMA_SYM`, and — when an upstream is bound — runs
   `validateAgainstSchema(plain, schema)`. A non-conforming upstream fails the
   compile with an `"upstream data does not match …"` error. With no upstream
   bound, the `{}` fallback is used and validation is skipped.

The default-record form (`data {…}`) undergoes no schema validation; the default
is simply replaced by the upstream value when one is wired.

### Single-upstream constraint (runtime)

At runtime a program has **exactly one** upstream. The compiler entrypoint is
`compile(code, data, config, resume)` — a single `data` argument. Multiple `data`
calls in one program all read that same upstream value. Multi-source fan-in is
not a runtime feature.

### Console vs. runtime gap (multi-upstream)

> **Known gap — documented, not resolved.** The console's composition discovery
> (`src/lib/composition-discovery.ts` `resolveUpstreams`) walks the head AST for
> *every* `DATA(USE(STR))` annotation and can build a compound task id of the form
> `head+u1+u2+…` (`src/pages/api/resolvers.ts:542`). The runtime, however, feeds a
> single `data` value to `compile()`. So while the console can *emit* a chain with
> more than one upstream, the runtime consumes only one. Treat multi-upstream as a
> known, unresolved gap until either the runtime gains fan-in or the console
> restricts emission to a single upstream. The single-upstream case
> (`head+inner`) is the only fully-supported path today.

### Top-level result shape

A dialect's compiled output is consumed both by its own renderer and — when
chained — by another dialect via `data use "<lang>"`. To make composition
predictable, every dialect should return a **record** at the top level (wrap lists
under a domain-named key, e.g. `{ rows: [...] }`), and declare that key in its
`schema.json` so `data use` consumers can validate against it. This is a
dialect-authoring convention; basis passes the top-level result through as-is.
See `l0000/.../usage-guide.md` "Top-level result shape."

### Caching

Programs are parsed once and interned by source. Compile is a separate phase;
compiled outputs are interned by (source + the task ids of transitive upstreams).
Re-authoring an upstream yields a new upstream task id, which invalidates the
consumer's compile cache entry but not its parse cache entry.

## Worked example: L0166 → L0158

A spreadsheet question authored in L0158 consumes spreadsheet content produced by
an L0166 program:

```
let sheet = data use "0166"

question {
  parts: [
    {
      id: 1,
      content: {
        type: spreadsheet,
        data: sheet
      }
    }
  ]
}
```

What the compiler does:

1. `USE` resolves `"0166"`, fetches L0166's `schema.json`, tags the record.
2. `DATA` binds `sheet` to the chained upstream's output (or `{}` if unwired) and,
   when bound, validates it against L0166's schema; a non-conforming upstream fails
   the compile.
3. The rest of the program embeds `sheet` at `content.data`. L0158 itself does not
   need to know L0166's internals — the `data use "0166"` declaration is the only
   thing tying the two dialects together.

## Out of scope

- `typed-data` and any second import function — there is only `data` (+ `use`).
- Multiple direct upstreams per program at runtime (see the console-vs-runtime gap).
- Schema versioning. Within a language id, schemas evolve additively; breaking
  changes mean a new language id.
- `open`-style flattening of imported names into local scope.
- Adversarial threat model (capabilities, IFC, declassification).

## See also

- `l0000/packages/core/spec/usage-guide.md` — authoritative composition guide.
- `l0000/packages/core/spec/spec.md`, `examples.md` — `data`/`use` signatures and
  training examples.
- `docs/plan-multi-language-composition.md` — how the console *generates* a
  composed program and chains task ids.

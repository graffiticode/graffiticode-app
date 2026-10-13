# RAG Training Notes for L0166

## Query-Document Embedding Alignment

### Problem
Multi-turn conversation prompts were being used as-is for RAG vector search queries. The full conversation context (previous turns, generated code, etc.) diluted the embedding, causing low similarity scores even when the core request closely matched a training example.

Example: "format the numbers using #,##0" embedded within a full penguin-data conversation scored only 0.46 against the training example "format column A using ($#,##0)".

### Fix
Added `extractSearchQuery()` in `code-generation-service.ts` to strip conversation context before embedding. It extracts just the text after the `"Now, please address this new request:\n"` marker. After this fix, the same query type scored 0.65.

## Training Example Curation

### Problem
Some training examples had multi-turn conversation history stored in their prompt fields, causing bloated document embeddings. A "home budget assessment" example had property update JSON and markdown tables in its embedding text.

### Fix
Curated training examples to single-turn prompts that match how users actually ask. After curation + embedding refresh, identical prompts score 1.0 similarity and similar prompts (e.g., "create a simple home budget assessment" vs "make a simple income statement assessment") score 0.95.

### Workflow
```bash
# Curate the corpus items (eval account, mark=1) — the RAG corpus is built from them.
# Then rebuild embeddings for the language:
npx tsx scripts/generate-embeddings-from-examples.ts --lang 0166
```

## Prompt Engineering for Pattern Fidelity

### Problem
Even with high similarity matches, Claude would "freelance" — generating structurally similar but different code (e.g., using formula-based assessments instead of value-based from the training example).

### Fix
Added instruction after `<RETRIEVED_CONTEXT>` in the prompt template:

> When a retrieved example closely matches the user's request, follow its coding patterns and techniques. If there is existing current code, apply the example's patterns to the current code rather than replacing it.

The second sentence prevents matched examples from overriding current code in multi-turn conversations.

## RAG vs DSPy Roles

- **RAG** answers "what examples should Claude see?" — retrieves training examples by embedding similarity
- **DSPy** answers "how should we present those examples?" — optimizes prompt structure, instructions, and example selection

Current approach: static prompt template + curated RAG examples. DSPy adds value as the next layer when there's a scoring metric and enough traffic to optimize against.

## When to Move from RAG to DSPy

### RAG phase (current)
- Adding/curating training examples still improves output quality
- Still discovering prompt patterns that users commonly ask for
- Similarity scores are the main bottleneck (fixable with better examples)

### DSPy tipping point
- Good coverage of common prompts (50+ curated examples per language) but quality plateaus
- Same retrieval results produce inconsistent outputs — the problem shifts from *what* Claude sees to *how* it's instructed
- Enough analytics data to define a scoring metric (compile rate, user feedback, edit rate)
- Need per-request-type prompt tuning too complex to hand-code

### Practical signal
When report failures shift from "wrong example retrieved" to "right example retrieved, wrong output anyway."

## Training Example Coverage Targets

### Structural examples (priority)
- Target: ~50-80 curated examples to cover the L0166 feature surface
- Cover: format, assess, columns, formulas, borders, alignment, font-weight, width, etc.
- Each structural request ("add a format", "make column B right-aligned") should have a close match

### Subject matter examples (lower priority)
- Target: ~20-30 domain templates (budgets, grade books, inventories, income statements, etc.)
- Same format as structural examples — a prompt and expected code
- Purpose: show Claude what a *good* instance of a domain looks like in L0166
- Lower priority because content authors are in the loop prompting for corrections — Claude already knows what a budget looks like, it just needs to know how to express it in L0166
- Only becomes important if users consistently need many turns to get reasonable content for common domains

### Overall tipping point
~80-100 curated examples with good structural coverage, RAG report consistently showing top similarity > 0.7 for most requests. At that point, diminishing returns from more examples — DSPy becomes worth the investment.

## Reliability Strategy: Reducing the Error Surface

The core strategy: **reduce the surface area of what Claude can get wrong on each turn.** Each layer makes the system more deterministic without losing flexibility.

### What we have
- Compilation verification with retry (Claude fixes its own syntax errors)
- RAG for structural pattern matching
- Prompt instruction to follow matched examples

### What would close the remaining gaps

1. **Structured error feedback** — Feed back specific compiler errors (line, expected token) rather than just "it failed." `parseStructuredErrors()` in dspy-service.ts already supports this. More precise error context = faster convergence.

2. **Output validation beyond compilation** — Code can compile but be wrong. Validate that generated code preserves existing cells/columns when the user only asked to change one thing. Diff-based check: "user asked to format column B, but columns A and C changed too" — reject and retry.

3. **Constrained generation** — Instead of free-form generation, give Claude the current AST and ask it to modify specific nodes. Eliminates the "regenerate everything" failure mode. Property update detection (`isPropertyUpdate`) already moves in this direction.

4. **Change guardrails** — In multi-turn conversations, diff output against current code. If the user said "format column B" but the diff shows 15 cells changed, flag or auto-reject.

5. **Template-first generation** — For high-similarity matches (> 0.9), give Claude the matched example's code as a starting point and ask it to adapt. Flips the problem from "generate correct code" to "make minimal edits" — which LLMs are better at.

6. **Progressive complexity** — Start users with a template (already implemented via `"Create a minimal starting template"`). Each turn makes one change. Naturally constrains generation scope and makes errors easier to catch and fix.

## Key Principles

1. **Clean data in, clean embeddings out** — single-turn curated prompts produce better matches
2. **Query extraction matters** — search on the latest user request, not the full conversation
3. **Structure training, not content** — training examples teach L0166 patterns; content correctness comes from iterative user prompting
4. **Convergence over first-shot accuracy** — users will prompt for corrections; the system should reliably apply changes without regressions

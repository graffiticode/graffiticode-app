# Design Thread: Out-of-Scope Detection + Language Routing

*2025-05-01 — Design conversation for out-of-scope feedback and language routing*

---

## Starting Point

Graffiticode languages are task-specific. We want to train the language-specific AI helper to provide feedback if the user asks for something outside the language's capability, including suggesting another language or rephrasing the request.

## Exploration

Analyzed the current code generation flow:

- **instructions.md** (per language repo) describes dialect-specific capabilities — already positive/descriptive
- **System prompt** (`getSystemPromptForDialect()` in `code-generation-service.ts`) combines base Graffiticode syntax + dialect instructions
- **No existing mechanism** to detect or respond to out-of-scope requests
- When a request doesn't fit, Claude either generates wrong code or code that fails compilation — wasting compile units

## Initial Approaches Considered

1. **Scope boundaries in instructions.md** — hardcode "can't do X, suggest L0159" per language
2. **Pre-generation classification step** — extra Haiku call before every request
3. **Cross-language catalog in system prompt** — inject sibling language list
4. **Hybrid of 1+3**

## Key Design Decision: Positive Scope + Haiku Router

Rather than hardcoding cross-language references in each instructions.md (which creates coupling and maintenance burden), the design separates concerns:

- **instructions.md** stays positive — only describes what the language CAN do
- **System prompt** tells Claude to signal OUT_OF_SCOPE when a request doesn't match
- **A reusable Haiku-based router** (`language-router.ts`) searches the dynamic language catalog to find alternatives — no hardcoded cross-references needed

## MCP Client Consideration

The feedback mechanism serves two audiences:

1. **Human users** in the console — "I can't do that, but L0159 can"
2. **MCP clients** (Claude, ChatGPT) — structured signal enabling automatic language routing

The MCP server acts as a language router for user requests. Individual language tools stick to their expertise — if you ask L0166 to do L0158 things, it says it can't. The MCP client can then switch languages automatically.

The structured response format:
```json
{
  "out_of_scope": true,
  "reason": "L0166 creates spreadsheets, not flashcard games",
  "suggestions": [
    { "language": "L0159", "description": "Flashcards, Match and Memory card games", "reasoning": "..." }
  ],
  "rephrase_hint": "..."
}
```

## Future Agent Mode Consideration

In the future, the console will have an agent mode chat on the tools page where users make generic requests without pre-selecting a language. The agent finds the best language and does what the user requests.

This is the **proactive** version of what we're building now as a **reactive** path:

- **Now (reactive):** User picks L0166, asks for flashcards → OUT_OF_SCOPE → Haiku finds L0159
- **Future (proactive):** User says "make me flashcards" → Haiku finds L0159 → create_item

Same routing logic, different trigger. This means:

**The Haiku language router should be a standalone, reusable function — not buried inside the out-of-scope error path.**

```typescript
findBestLanguages(userRequest, languageCatalog)
  → { suggestions, rephraseHint }
```

Called from two places:
1. **Now:** Inside `generateCode()` when OUT_OF_SCOPE is detected
2. **Future:** At the top of agent mode flow to proactively select a language

## Architecture

```
User request + language
        |
        v
  Code generation (Sonnet) — system prompt includes instructions.md
        |
        v
  Claude responds with code OR "OUT_OF_SCOPE: <reason>"
        |
        +-- Code? --> parse, compile, return as normal
        |
        +-- OUT_OF_SCOPE?
                |
                v
          language-router (Haiku) with:
          - user's request
          - reason it was out of scope
          - full language catalog (fetched dynamically)
                |
                v
          structured suggestion: { suggestions, rephraseHint }
                |
                v
          return to caller (console UI or MCP server)
```

## Files Changed

| File | Change |
|------|--------|
| `src/lib/language-router.ts` | **New** — reusable Haiku-based language router |
| `src/lib/code-generation-service.ts` | Add OUT_OF_SCOPE instruction to system prompt; detect signal and call router |
| `src/pages/api/resolvers.ts` | Pass through outOfScope field |
| `src/pages/api/index.ts` | Add outOfScope to GraphQL schema |
| `../graffiticode-mcp-server/src/tools.ts` | Handle outOfScope in create/update item |
| Console UI component | Render out-of-scope suggestions |

## Implementation Plan

Full plan with code sketches: `docs/plan-out-of-scope-routing.md`

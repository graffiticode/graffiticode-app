# Plan: Out-of-Scope Detection + Language Routing

## Goal

When a user asks a Graffiticode language to do something outside its capabilities, the system should:
1. Detect the request is out of scope (without wasting compile units)
2. Suggest alternative languages that can handle the request
3. Return structured feedback usable by both the console UI and MCP clients

## Design Principles

- Each language's `instructions.md` only describes what it CAN do (positive scope, no cross-references)
- A reusable Haiku-based language router finds alternatives by searching the dynamic language catalog
- The router is a standalone module so it can also be used by a future agent mode that proactively selects languages

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

## Implementation Steps

### Step 1: Add out-of-scope instruction to system prompt

File: `src/lib/code-generation-service.ts`, function `getSystemPromptForDialect()`

After the line `prompt += fileInstructions;` and before the Response Requirements section, add to the base prompt (so it applies to all languages):

```
If the user's request is clearly outside the capabilities of this dialect, do not attempt to generate code. Instead, respond with ONLY:
OUT_OF_SCOPE: <one sentence explaining what this dialect does and why the request doesn't fit>
```

This goes in the base prompt, not in individual instructions.md files.

### Step 2: Create the language router module

New file: `src/lib/language-router.ts`

Export a function:
```typescript
interface LanguageSuggestion {
  language: string;      // e.g. "L0159"
  description: string;   // e.g. "Flashcards, Match and Memory card games"
  reasoning: string;     // why this language fits
}

interface RouteResult {
  suggestions: LanguageSuggestion[];
  rephraseHint?: string; // optional hint if the request could partially fit the current language
}

export async function findBestLanguages(params: {
  userRequest: string;
  outOfScopeReason: string;
  currentLang: string;
  auth: any;
}): Promise<RouteResult>
```

Implementation:
- Fetch available languages via the existing `listLanguages()` from `src/lib/languages.ts` (filter out "hide" domains and the current language)
- Make a single Haiku call with the user request, the out-of-scope reason, and the language catalog
- Prompt Haiku to return JSON: ranked suggestions (max 3) + optional rephrase hint
- Parse and return structured result
- Use CLAUDE_MODELS.HAIKU for the call (already defined in code-generation-service.ts)

### Step 3: Detect OUT_OF_SCOPE in generateCode

File: `src/lib/code-generation-service.ts`, in the `generateCode()` function

After `streamResult.code` is obtained (around line 1300, after `processGeneratedCode`), before the verification loop:

```typescript
// Check for out-of-scope signal
if (generatedCode.trim().startsWith("OUT_OF_SCOPE:")) {
  const reason = generatedCode.replace(/^OUT_OF_SCOPE:\s*/, "").trim();
  const routeResult = await findBestLanguages({
    userRequest: prompt,
    outOfScopeReason: reason,
    currentLang: lang,
    auth,
  });
  return {
    code: null,
    taskId: null,
    outOfScope: {
      reason,
      ...routeResult,
    },
    lang,
    model: modelToUse,
    usage: {
      input_tokens: finalUsage.prompt_tokens,
      output_tokens: finalUsage.completion_tokens,
    },
  };
}
```

No compile units wasted — we skip verification/compilation entirely.

### Step 4: Pass through in resolvers.ts

File: `src/pages/api/resolvers.ts`, in `generateCode()`

After the `codeGenerationService()` call, check for `outOfScope` on the result and return it as a new field on the GraphQL response:

```typescript
if ('outOfScope' in result && result.outOfScope) {
  return {
    src: null,
    taskId: null,
    language,
    description: null,
    model: result.model,
    usage: result.usage,
    outOfScope: result.outOfScope,
  };
}
```

This requires adding `outOfScope` to the GraphQL schema for the generateCode mutation response type.

### Step 5: Handle in MCP server

File: `../graffiticode-mcp-server/src/tools.ts`, in `handleCreateItem()` and `handleUpdateItem()`

When `generated.outOfScope` is present, return a structured tool result instead of an error:

```typescript
if (generated.outOfScope) {
  return {
    out_of_scope: true,
    current_language: `L${existingItem.lang}`,
    reason: generated.outOfScope.reason,
    suggestions: generated.outOfScope.suggestions,
    rephrase_hint: generated.outOfScope.rephraseHint,
    hint: `This request doesn't match ${generated.outOfScope.reason}. Try create_item() with one of the suggested languages.`,
  };
}
```

This gives MCP clients (Claude, ChatGPT, etc.) structured data to automatically retry with the right language.

### Step 6: Handle in console UI

File: `src/components/HelpPanel.tsx` (or wherever chat responses render)

When the response contains `outOfScope`, render a friendly message:
- "This language creates [what it does]. Your request for [what they asked] would be better handled by:"
- List suggested languages with clickable links to switch
- Optionally show rephrase hint

## Files Changed

| File | Change |
|------|--------|
| `src/lib/language-router.ts` | **New** — reusable Haiku-based language router |
| `src/lib/code-generation-service.ts` | Add OUT_OF_SCOPE instruction to system prompt; detect signal and call router |
| `src/pages/api/resolvers.ts` | Pass through outOfScope field |
| `src/pages/api/index.ts` | Add outOfScope to GraphQL schema |
| `../graffiticode-mcp-server/src/tools.ts` | Handle outOfScope in create/update item |
| Console UI component | Render out-of-scope suggestions |

## Current Implementation Status

Steps 1-3 are **done**. Steps 4-6 are **not yet implemented**.

What exists today:
- System prompt includes OUT_OF_SCOPE instruction (Step 1) ✅
- `language-router.ts` exists with Haiku-based routing (Step 2) ✅
- `code-generation-service.ts` detects OUT_OF_SCOPE and calls router (Step 3) ✅
- Router now uses `routingHint` field from `languages.ts` for richer catalog descriptions ✅
- Suggestions are returned as plain-text error messages, not structured data

What's missing:
- **Step 4 (resolvers.ts + GraphQL schema)**: `outOfScope` is not a separate field — it's flattened into `errors[].message`. The GraphQL schema needs an `OutOfScope` type with structured fields (reason, suggestions array with id/name/description/reason). The resolver needs to return this as a distinct field alongside `errors`.
- **Step 5 (MCP server)**: `graffiticode-mcp-server/src/tools.ts` has no out-of-scope handling. It currently receives errors as strings. Once Step 4 exposes structured `outOfScope` data via GraphQL, the MCP server should return it as structured tool result content (not `isError: true`) so the client model can automatically call `create_item()` with the suggested language. Key: the MCP tool result should include the suggestion language IDs so the client doesn't have to parse text.
- **Step 6 (Console UI)**: `ChatBot.tsx` renders out-of-scope as `type: 'error'`. Should render as a friendly message with clickable language links/buttons to switch.

## Future: Agent Mode

The `findBestLanguages()` function in `language-router.ts` is designed to also serve a future agent mode where users make generic requests without pre-selecting a language. In that flow, the agent calls `findBestLanguages()` proactively (without an OUT_OF_SCOPE trigger) to select the right language before calling `create_item`. Same router, different entry point.

## Testing

- Ask L0166 to "create flashcards" → should get OUT_OF_SCOPE with L0159 suggestion
- Ask L0159 to "create a spreadsheet" → should get OUT_OF_SCOPE with L0166 suggestion
- Ask L0166 to "create a spreadsheet with grades" → should generate code normally (in scope)
- Ask L0169 to "fetch data from a URL" → should get OUT_OF_SCOPE with L0170 suggestion
- Verify no compile units consumed on out-of-scope requests
- Verify MCP client receives structured suggestion and can auto-retry

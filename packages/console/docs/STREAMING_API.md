# LLM Streaming API

`src/lib/llm-generation-service.ts` is the shared long-form generation path for
Anthropic Messages and OpenAI Responses. It streams provider output internally,
continues responses cut off by token limits, and returns one assembled
Graffiticode program.

## Primary API

```ts
import { generateCodeWithContinuation } from "../src/lib/llm-generation-service";

const result = await generateCodeWithContinuation({
  formattedPrompt,
  lang: "0175",
  options: {
    provider: "auto",
    tier: "balanced",
    maxTokens: 16384,
    maxContinuations: 10,
  },
});
```

The result includes:

- `code`, normalized token `usage`, and continuation `chunks`;
- the successful `provider`, `model`, and provider-neutral `tier`;
- every provider `attempt` and an optional `fallbackReason`;
- `error` when no allowed provider completes the request.

## Continuation Behavior

Continuation occurs only when the provider reports a token-limit stop and the
program has not ended with `..`. Conversation history includes the partial
assistant response and a short continuation instruction. Fenced code blocks are
joined without separators so a token boundary cannot inject whitespace.

If a model restarts the program during continuation, the abandoned prefix is
dropped before returning the final code.

## Failover Behavior

An eligible provider failure causes one full restart on the next family in the
language's priority list (`src/lib/model-priority.ts`). Partial output is
discarded; streams from different providers are never combined. At most one
cross-family restart per logical call, however long the list is. A model pin
(internal/eval only) selects a single family and never fails over.

Provider HTTP retries are disabled so retry ownership remains in this service. A
short circuit breaker skips repeatedly failing families, except that the last
remaining family is always attempted. See
[LLM_PROVIDERS.md](./LLM_PROVIDERS.md) for the tier mappings, the per-language
ordering, and why model choice is not client-selectable.

## Usage Accounting

The adapter normalizes both providers to disjoint counts:

```ts
{
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  reasoningTokens
}
```

OpenAI cached tokens are removed from `inputTokens` before returning. This keeps
pricing and telemetry consistent with the existing Anthropic accounting model.

`reasoningTokens` is the one field that is **not** disjoint: it is a *subset* of
`outputTokens`. Providers that report it (OpenAI's
`output_tokens_details.reasoning_tokens`; 0 on Anthropic, which does not break
thinking out) bill it at the output rate and already include it there, so adding
it into a total double-counts. It exists so cost-per-success can be attributed
across reasoning-effort levels — never to compute a bill.

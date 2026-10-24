import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setAnthropicAuthTestHooks } from '@graffiticode-app/core/lib/anthropic-auth';
import { generateCodeWithContinuation } from '@graffiticode-app/core/lib/llm-generation-service';

// A Claude credential failure must roll the generation over to the next provider. A failed federation exchange
// throws with no HTTP response; it has to surface as a failoverable authentication_error, not a dead end.
test('a failed federation exchange fails over to the next provider instead of failing the generation', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_FEDERATION_RULE_ID = 'fdrl_1';
    process.env.ANTHROPIC_ORGANIZATION_ID = 'org-1';
    process.env.ANTHROPIC_SERVICE_ACCOUNT_ID = 'svac_1';
    process.env.CODEGEN_DEFAULT_PRIORITY = 'anthropic,openai';
    __setAnthropicAuthTestHooks({
      fetch: (async (input: any) => {
        const url = String(input);
        if (url.startsWith('http://metadata.google.internal/')) return new Response('google-id-token', { status: 200 });
        if (url === 'https://api.anthropic.com/v1/oauth/token') return new Response('{}', { status: 401 });
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch,
    });
    const result = await generateCodeWithContinuation({ prompt: 'a 2x2 table', lang: '0000' });
    const [first, second] = result.attempts;
    assert.equal(first.provider, 'anthropic');
    assert.equal(first.success, false);
    assert.equal(first.code, 'authentication_error');
    assert.match(String(first.error), /Anthropic authentication failed: Anthropic token exchange failed \(401\)/);
    assert.equal(second?.provider, 'openai', 'the generation rolled over to OpenAI');
    assert.equal(result.fallbackReason, 'authentication_error');
  } finally {
    __setAnthropicAuthTestHooks(null);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

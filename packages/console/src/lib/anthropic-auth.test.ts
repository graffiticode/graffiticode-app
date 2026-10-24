import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicAuthHeaders,
  anthropicCredentialsConfigured,
  anthropicAuthMode,
  __setAnthropicAuthTestHooks,
} from '@graffiticode-app/core/lib/anthropic-auth';

const ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID'];
const saved: Record<string, string | undefined> = {};
let clock = 1_000_000;
let calls: { url: string; body?: any }[] = [];
let exchangeStatus = 200;
let idTokens = 0;

const fakeFetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith('http://metadata.google.internal/')) {
    assert.equal(init?.headers?.['Metadata-Flavor'], 'Google');
    assert.match(url, /audience=https%3A%2F%2Fapi\.anthropic\.com&format=full$/);
    idTokens += 1;
    calls.push({ url });
    return new Response(`google-id-token-${idTokens}`, { status: 200 });
  }
  if (url === 'https://api.anthropic.com/v1/oauth/token') {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (exchangeStatus !== 200) return new Response('{"type":"error"}', { status: exchangeStatus });
    return Response.json({ access_token: `sk-ant-oat01-${body.assertion}`, expires_in: 600 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

function federate() {
  process.env.ANTHROPIC_FEDERATION_RULE_ID = 'fdrl_1';
  process.env.ANTHROPIC_ORGANIZATION_ID = 'org-1';
  process.env.ANTHROPIC_SERVICE_ACCOUNT_ID = 'svac_1';
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  clock = 1_000_000; calls = []; exchangeStatus = 200; idTokens = 0;
  __setAnthropicAuthTestHooks({ fetch: fakeFetch, now: () => clock });
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  __setAnthropicAuthTestHooks(null);
});

test('federation: exchanges a Google identity token and sends a bearer token, not the key', async () => {
  federate();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-static';
  const headers = await anthropicAuthHeaders();
  assert.deepEqual(headers, { authorization: 'Bearer sk-ant-oat01-google-id-token-1' });
  const ex = calls.find((c) => c.body)!.body;
  assert.deepEqual(ex, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'google-id-token-1',
    federation_rule_id: 'fdrl_1',
    organization_id: 'org-1',
    service_account_id: 'svac_1',
  });
  assert.equal(anthropicAuthMode(), 'federation');
});

test('federation passes the workspace id when set', async () => {
  federate();
  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_1';
  await anthropicAuthHeaders();
  assert.equal(calls.find((c) => c.body)!.body.workspace_id, 'wrkspc_1');
});

test('the access token is cached, and refreshed with a FRESH identity token before it expires', async () => {
  federate();
  await anthropicAuthHeaders();
  await anthropicAuthHeaders();
  assert.equal(idTokens, 1, 'cached within its lifetime');
  clock += (600 - 119) * 1000; // inside the 120 s refresh margin
  const h = await anthropicAuthHeaders();
  assert.equal(idTokens, 2, 'refreshed early');
  assert.equal(h.authorization, 'Bearer sk-ant-oat01-google-id-token-2', 'a new identity token, never a reused one');
});

test('concurrent callers share one exchange', async () => {
  federate();
  await Promise.all([anthropicAuthHeaders(), anthropicAuthHeaders(), anthropicAuthHeaders()]);
  assert.equal(calls.filter((c) => c.body).length, 1);
});

test('a failed exchange falls back to the static key while it is still set, and logs it', async () => {
  federate();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-static';
  exchangeStatus = 401;
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errors.push(m); };
  try {
    assert.deepEqual(await anthropicAuthHeaders(), { 'x-api-key': 'sk-ant-static' });
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /federation failed, falling back to ANTHROPIC_API_KEY: Anthropic token exchange failed \(401\)/);
});

test('once the key is removed, a failed exchange is an error, not a silent fallback', async () => {
  federate();
  exchangeStatus = 401;
  await assert.rejects(anthropicAuthHeaders(), /token exchange failed \(401\)/);
});

test('without federation the static key is used; with neither, nothing is configured', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-static';
  assert.equal(anthropicAuthMode(), 'api-key');
  assert.deepEqual(await anthropicAuthHeaders(), { 'x-api-key': 'sk-ant-static' });
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(anthropicCredentialsConfigured(), false);
  assert.equal(anthropicAuthMode(), 'none');
  await assert.rejects(anthropicAuthHeaders(), /not configured/);
});

test('partial federation config is not federation', async () => {
  process.env.ANTHROPIC_FEDERATION_RULE_ID = 'fdrl_1';
  assert.equal(anthropicCredentialsConfigured(), false);
});

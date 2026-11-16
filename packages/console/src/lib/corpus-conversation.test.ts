import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusTurns, writtenByPrimary, unconfiguredPrimaries, primaryProvider } from './corpus-conversation';
import { harnessConversationId, harnessKindOf } from './harness-item-ids';

test('corpusTurns takes user messages in order, not the joined prompt', () => {
  const row = {
    prompt: 'Take `workplace-pulse`.\n\nAnswer it honestly.',
    messages: [
      { role: 'user', content: 'Take `workplace-pulse`.' },
      { role: 'assistant', content: '```\nsurvey [...]..\n```' },
      { role: 'user', content: ' Answer it honestly. ' },
    ],
  };
  assert.deepEqual(corpusTurns(row), ['Take `workplace-pulse`.', 'Answer it honestly.']);
});

test('corpusTurns never splits a prompt on blank lines (L0175 passages)', () => {
  assert.deepEqual(corpusTurns({ prompt: 'Passage:\n\nOnce upon a time.\n\nWrite an item.' }), [
    'Passage:\n\nOnce upon a time.\n\nWrite an item.',
  ]);
  assert.deepEqual(corpusTurns({ prompt: '  ' }), []);
});

test('writtenByPrimary requires every turn on the first-choice provider', () => {
  const lang = '0182';
  const primary = primaryProvider(lang);
  const own = primary === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5-20251001';
  const other = primary === 'openai' ? 'claude-haiku-4-5-20251001' : 'gpt-5.6-luna';
  assert.equal(writtenByPrimary(lang, [own, own]), true);
  assert.equal(writtenByPrimary(lang, [own, other]), false);
  assert.equal(writtenByPrimary(lang, [own, null]), false);
  assert.equal(writtenByPrimary(lang, []), false);
});

test('unconfiguredPrimaries flags a language whose first-choice key is missing', () => {
  const saved = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const openaiFirst = ['0182', '0183'].filter((l) => primaryProvider(l) === 'openai');
    assert.ok(openaiFirst.length > 0, 'test needs an openai-first language');
    assert.deepEqual(
      unconfiguredPrimaries(openaiFirst).map((u) => u.lang),
      openaiFirst,
    );
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.deepEqual(unconfiguredPrimaries(openaiFirst), []);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('harnessConversationId stays a harness id and is per conversation', () => {
  const a = harnessConversationId('sweep', '0182', 'o3f25HY9K0zvRH2TRvmg');
  const b = harnessConversationId('sweep', '0182', 's4xMOxO6r8m4TIHrmMeA');
  assert.notEqual(a, b);
  assert.equal(harnessKindOf(a), 'sweep');
  assert.ok(a.startsWith('corpus-sweep-0182-'));
});

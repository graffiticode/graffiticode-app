import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFreePlanPromptLength,
  MAX_FREE_PLAN_PROMPT,
  MIN_FREE_PLAN_PROMPT,
} from '@graffiticode-app/core/lib/free-plan-quota';

// Collect the funnel events a call prints (emitEvent writes one JSON line to stdout).
function eventsFrom(fn: () => void): { events: any[]; error: any } {
  const events: any[] = [];
  const orig = console.log;
  console.log = (line: unknown) => {
    try { events.push(JSON.parse(String(line))); } catch { /* not an event */ }
  };
  let error: any = null;
  try { fn(); } catch (err) { error = err; } finally { console.log = orig; }
  return { events, error };
}

test('a prompt within the limits passes and emits nothing', () => {
  const { events, error } = eventsFrom(() => assertFreePlanPromptLength('x'.repeat(MAX_FREE_PLAN_PROMPT)));
  assert.equal(error, null);
  assert.deepEqual(events, []);
});

test('too long is a prompt_too_long wall', () => {
  const { events, error } = eventsFrom(() => assertFreePlanPromptLength('x'.repeat(MAX_FREE_PLAN_PROMPT + 1)));
  assert.equal(error?.code, 'free_plan_description_too_long');
  assert.equal(error.extensions.length, MAX_FREE_PLAN_PROMPT + 1);
  assert.match(error.message, /utm_medium=prompt_too_long/);
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'wall_hit');
  assert.equal(events[0].wall, 'prompt_too_long');
});

test('length is measured after trimming', () => {
  const padded = `  ${'x'.repeat(MAX_FREE_PLAN_PROMPT)}  `;
  assert.equal(eventsFrom(() => assertFreePlanPromptLength(padded)).error, null);
});

test('too short is refused but is not a wall', () => {
  const { events, error } = eventsFrom(() => assertFreePlanPromptLength('x'.repeat(MIN_FREE_PLAN_PROMPT - 1)));
  assert.equal(error?.code, 'free_plan_description_too_short');
  assert.deepEqual(events, []);
});

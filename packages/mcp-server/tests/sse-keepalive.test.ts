import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEPALIVE_FRAME,
  keepaliveAction,
  startSseKeepalive,
  type KeepaliveTarget,
} from "../src/sse-keepalive.js";

/** Minimal stand-in for a Node ServerResponse. */
function fakeRes(overrides: Partial<KeepaliveTarget> & { contentType?: string } = {}) {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const res: KeepaliveTarget & { writes: string[]; emit(event: string): void } = {
    writableEnded: false,
    destroyed: false,
    headersSent: true,
    // `in` rather than ??, so an explicitly-undefined content type (a response with
    // no Content-Type at all) is distinguishable from "not overridden".
    getHeader: (name: string) =>
      name.toLowerCase() === "content-type"
        ? "contentType" in overrides
          ? overrides.contentType
          : "text/event-stream"
        : undefined,
    write: (chunk: string) => writes.push(chunk),
    once: (event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
      return res;
    },
    writes,
    emit: (event: string) => (listeners[event] ?? []).forEach((l) => l()),
    ...overrides,
  };
  return res;
}

test("keepaliveAction waits for headers, writes to a stream, stops otherwise", () => {
  assert.equal(keepaliveAction(fakeRes()), "write");
  // The transport hasn't opened the stream yet — a later tick may.
  assert.equal(keepaliveAction(fakeRes({ headersSent: false })), "wait");
  // Not an event stream (e.g. a JSON error response): never write into it.
  assert.equal(keepaliveAction(fakeRes({ contentType: "application/json" })), "stop");
  assert.equal(keepaliveAction(fakeRes({ contentType: undefined as unknown as string })), "stop");
  // Response is over.
  assert.equal(keepaliveAction(fakeRes({ writableEnded: true })), "stop");
  assert.equal(keepaliveAction(fakeRes({ destroyed: true })), "stop");
});

test("startSseKeepalive writes comment frames on each tick of an open stream", () => {
  const res = fakeRes();
  let tick: () => void = () => {};
  startSseKeepalive(res, 1000, (fn) => {
    tick = fn;
    return { unref: () => {} };
  });

  tick();
  tick();
  assert.deepEqual(res.writes, [KEEPALIVE_FRAME, KEEPALIVE_FRAME]);
  // An SSE comment carries no event id and no data, so it cannot be mistaken for
  // a message or disturb stream resumability.
  assert.match(KEEPALIVE_FRAME, /^:/);
  assert.doesNotMatch(KEEPALIVE_FRAME, /^(id|data|event):/m);
});

test("startSseKeepalive cancels itself on a non-stream response and on close", () => {
  // JSON response: stop on the first tick, without ever writing.
  const json = fakeRes({ contentType: "application/json" });
  let jsonTick: () => void = () => {};
  let jsonCancelled = false;
  startSseKeepalive(json, 1000, (fn) => {
    jsonTick = fn;
    return { unref: () => {} };
  }, () => {
    jsonCancelled = true;
  });
  jsonTick();
  assert.equal(jsonCancelled, true);
  assert.deepEqual(json.writes, []);

  // Client disconnects: the response's own close event stops the interval.
  const stream = fakeRes();
  let streamCancelled = false;
  startSseKeepalive(stream, 1000, () => ({ unref: () => {} }), () => {
    streamCancelled = true;
  });
  stream.emit("close");
  assert.equal(streamCancelled, true);
});

test("a non-positive interval disables the keepalive entirely", () => {
  const res = fakeRes();
  let scheduled = false;
  for (const interval of [0, -1, NaN]) {
    startSseKeepalive(res, interval, () => {
      scheduled = true;
      return { unref: () => {} };
    });
  }
  assert.equal(scheduled, false);
  assert.deepEqual(res.writes, []);
});

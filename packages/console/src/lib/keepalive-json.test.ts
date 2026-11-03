import { test } from "node:test";
import assert from "node:assert/strict";
import { respondWithKeepalive } from "./keepalive-json";

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, chunks: [] as string[], ended: false, flushed: false };
  return {
    out,
    status(code: number) { out.status = code; },
    setHeader(name: string, value: string) { out.headers[name] = value; },
    flushHeaders() { out.flushed = true; },
    write(chunk: string) { out.chunks.push(chunk); },
    end(chunk?: string) { if (chunk) out.chunks.push(chunk); out.ended = true; },
  };
}

test("headers go out at once and spaces keep the connection alive until the JSON", async () => {
  const res = fakeRes();
  await respondWithKeepalive(res, () => new Promise((r) => setTimeout(() => r({ src: "x", taskId: "t" }), 35)), 10);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.flushed, true);
  assert.equal(res.out.ended, true);
  const body = res.out.chunks.join("");
  assert.ok(/^ {2,}\{/.test(body), "leading keep-alive spaces before the JSON");
  assert.deepEqual(JSON.parse(body), { src: "x", taskId: "t" });
});

test("a thrown error becomes { errors } in the body, never an HTTP status", async () => {
  const res = fakeRes();
  await respondWithKeepalive(res, async () => { throw Object.assign(new Error("over budget"), { code: "budget" }); }, 10);
  assert.equal(res.out.status, 200);
  assert.deepEqual(JSON.parse(res.out.chunks.join("")), { errors: [{ message: "over budget", code: "budget" }] });
});

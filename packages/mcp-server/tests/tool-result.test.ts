import assert from "node:assert/strict";
import test from "node:test";
import { formatToolResult } from "../src/tool-result.js";

// The summary is now expected IN structuredContent as well as in the text block —
// Claude Code and Cowork drop `content[0].text` for a tool with an outputSchema, so
// a summary that lived only there reached those models not at all. What this test
// exists to pin is unchanged and stated below: hydration (src / compiled data) must
// appear in NEITHER.
test("widget hydration stays out of structuredContent and chat text", () => {
  const response = formatToolResult({
    item_id: "item-1",
    status: "ready",
    language: "L0166",
    name: "Example",
    summary: "Example is ready — https://app.graffiticode.org/form/item-1",
    _meta: {
      graffiticode: {
        src: "secret language source",
        data: { answer: 42 },
        view_url: "https://app.graffiticode.org/form/item-1",
      },
    },
  });

  assert.deepEqual(response.structuredContent, {
    item_id: "item-1",
    status: "ready",
    language: "L0166",
    name: "Example",
    summary: "Example is ready — https://app.graffiticode.org/form/item-1",
  });
  const text = ((response.content as Array<{ text: string }>)[0]).text;
  assert.doesNotMatch(text, /secret language source|"answer"/);
  // The point of the duplication: a client reading only one of the two still gets
  // the link.
  assert.match(JSON.stringify(response.structuredContent), /form\/item-1/);
  assert.doesNotMatch(
    JSON.stringify(response.structuredContent),
    /secret language source|"answer"/
  );
  assert.equal((response._meta as Record<string, unknown>).graffiticode !== undefined, true);
});

test("stripHydration drops the hydration payload for widget-less (OpenAI) clients", () => {
  const result = {
    item_id: "item-1",
    status: "ready",
    language: "L0166",
    name: "Example",
    summary: "Ready: https://app.graffiticode.org/form/item-1",
    _meta: { graffiticode: { src: "secret language source", data: { answer: 42 } } },
  };

  const withWidget = formatToolResult(result);
  assert.equal((withWidget._meta as Record<string, unknown>).graffiticode !== undefined, true);

  const noWidget = formatToolResult(result, { stripHydration: true });
  // _meta was hydration-only, so it drops entirely (no empty `{}` shipped).
  assert.equal(noWidget._meta, undefined);
  // structuredContent + chat text stay identical and compact either way.
  assert.deepEqual(noWidget.structuredContent, withWidget.structuredContent);
  assert.doesNotMatch(JSON.stringify(noWidget), /secret language source|"answer"/);
});

test("stripHydration preserves auth-control metadata while dropping hydration", () => {
  const challenge = 'Bearer resource_metadata="https://mcp.graffiticode.org/.well-known/oauth-protected-resource", error="invalid_token"';
  const result = {
    item_id: "item-1",
    status: "ready",
    language: "L0166",
    name: "Example",
    summary: "Ready",
    _meta: {
      graffiticode: { src: "secret language source", data: { answer: 42 } },
      "mcp/www_authenticate": [challenge],
    },
  };

  const noWidget = formatToolResult(result, { stripHydration: true });
  const meta = noWidget._meta as Record<string, unknown>;
  // The auth challenge survives for ChatGPT (triggers account re-linking)...
  assert.deepEqual(meta["mcp/www_authenticate"], [challenge]);
  // ...but the hydration payload does not.
  assert.equal(meta.graffiticode, undefined);
  assert.doesNotMatch(JSON.stringify(noWidget), /secret language source|"answer"/);
});

test("render results cannot regress the removed access-token URL", () => {
  const response = formatToolResult({
    item_id: "item-1",
    status: "ready",
    language: "L0173",
    name: null,
    summary: "Ready: https://app.graffiticode.org/form/item-1",
    _meta: {
      graffiticode: {
        data: { data: { type: "chart" }, errors: [] },
        claim_url: "https://console.graffiticode.org/claim?token=allowed-claim-capability",
      },
    },
  });
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /form_url|access_token|authorization/i);
  assert.match(serialized, /claim\?token=allowed-claim-capability/);
});

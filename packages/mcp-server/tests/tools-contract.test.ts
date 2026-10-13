import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_SECURITY_SCHEMES,
  buildClaimFields,
  buildGeneratingResponse,
  buildReadySummary,
  classifyClientHost,
  getItemTool,
  parseHelp,
  reconnectHint,
  renderItemTool,
  tools,
  toolsForClient,
} from "../src/tools.js";
import type { AuthContext } from "../src/api.js";

type ToolRecord = Record<string, unknown> & { name: string };

// OpenAI clients now take the `openai` widget route (Phase 3); everything else
// unrecognised still gets text only. Split apart because the two now differ.
const OPENAI_CLIENTS = ["ChatGPT", "openai-apps", "openai-mcp", "openai-mcp (Codex)", "codex-mcp-client"];
// "gpt" belongs here, not above: the OpenAI route is an ALLOW-list of names we have
// actually seen (/openai|chatgpt|codex/), so a bare "gpt" is an unrecognised client
// and must get text. Same reasoning as web-sandbox.
const UNKNOWN_CLIENTS = ["web-sandbox", "some-unknown-host", "gpt", undefined as unknown as string];
const NON_CLAUDE_CLIENTS = [...OPENAI_CLIENTS, ...UNKNOWN_CLIENTS];
const WIDGET_TOOLS = new Set(["render_item"]);
const expectedSchemes = JSON.parse(JSON.stringify(TOOL_SECURITY_SCHEMES));

function metaOf(tool: ToolRecord): Record<string, unknown> {
  return tool._meta as Record<string, unknown>;
}

test("every structured tool declares an output schema", () => {
  for (const tool of tools as ToolRecord[]) {
    assert.ok(tool.outputSchema, `${tool.name} is missing outputSchema`);
  }
});

test("every tool advertises noauth-only securitySchemes to every client (incl. unknowns)", () => {
  // v1 is noauth-only for the OpenAI submission: no oauth2 scheme is advertised (we
  // are not standing up the OAuth connection until the callback fix lands). Guards
  // against accidentally re-advertising oauth2 before OAuth is review-ready.
  for (const client of ["claude-ai", ...NON_CLAUDE_CLIENTS]) {
    for (const tool of toolsForClient(client) as ToolRecord[]) {
      assert.deepEqual(tool.securitySchemes, expectedSchemes, `${client}/${tool.name} top-level securitySchemes`);
      assert.deepEqual(metaOf(tool).securitySchemes, expectedSchemes, `${client}/${tool.name} _meta.securitySchemes`);
      const types = (tool.securitySchemes as Array<{ type: string }>).map((s) => s.type);
      assert.deepEqual(types, ["noauth"], `${client}/${tool.name} should advertise noauth only`);
    }
  }
});

test("UNKNOWN clients get securitySchemes but NO widget/UI metadata", () => {
  // Still allow-list semantics. A client we do not recognise gets text, even if it
  // declares the UI extension — `web-sandbox`-style names are the family the
  // whitelist was added to catch. securitySchemes must survive regardless so
  // OpenAI's Scan Tools sees the optional-auth contract.
  for (const client of UNKNOWN_CLIENTS) {
    for (const tool of toolsForClient(client, true) as ToolRecord[]) {
      const meta = metaOf(tool);
      assert.equal(meta.ui, undefined, `${client}/${tool.name} leaked ui`);
      assert.equal(meta["ui/resourceUri"], undefined, `${client}/${tool.name} leaked ui/resourceUri`);
      assert.equal(meta["openai/outputTemplate"], undefined, `${client}/${tool.name} leaked outputTemplate`);
      assert.equal(meta["openai/resultCanProduceWidget"], undefined, `${client}/${tool.name} leaked widget hint`);
      assert.deepEqual(Object.keys(meta), ["securitySchemes"], `${client}/${tool.name} _meta should be securitySchemes-only`);
    }
  }
});

test("OpenAI clients get outputTemplate pointing at the SAME resource Claude uses", () => {
  // openai/outputTemplate is the Apps SDK's documented compatibility alias for
  // _meta.ui.resourceUri. One artifact, two key spellings — if these ever diverge,
  // ChatGPT mounts a different build than Claude does.
  const claude = toolsForClient("claude-ai", true) as ToolRecord[];
  const claudeUri = metaOf(claude.find((t) => t.name === "render_item")!)["ui/resourceUri"];
  assert.ok(typeof claudeUri === "string" && claudeUri.startsWith("ui://"));

  for (const client of OPENAI_CLIENTS) {
    // false: ChatGPT does NOT declare io.modelcontextprotocol/ui, so the route must
    // not depend on it.
    for (const tool of toolsForClient(client, false) as ToolRecord[]) {
      const meta = metaOf(tool);
      if (!WIDGET_TOOLS.has(tool.name)) {
        assert.deepEqual(Object.keys(meta), ["securitySchemes"], `${client}/${tool.name}`);
        continue;
      }
      assert.equal(meta["openai/outputTemplate"], claudeUri, `${client}/${tool.name} outputTemplate`);
      assert.deepEqual(meta.ui, { resourceUri: claudeUri }, `${client}/${tool.name} ui.resourceUri`);
      assert.ok(meta["openai/toolInvocation/invoking"], `${client}/${tool.name} invoking label`);
      assert.deepEqual(meta.securitySchemes, expectedSchemes, `${client}/${tool.name} securitySchemes`);
    }
  }
});

test("Claude receives the MCP App resource on widget-bearing tools, plus securitySchemes on all", () => {
  const listed = toolsForClient("claude-ai", true) as ToolRecord[];
  for (const tool of listed) {
    const meta = metaOf(tool);
    assert.deepEqual(meta.securitySchemes, expectedSchemes);
    if (!WIDGET_TOOLS.has(tool.name)) {
      // non-widget tools: securitySchemes only, no ui
      assert.equal(meta.ui, undefined, `${tool.name} should have no widget`);
      continue;
    }
    const ui = meta.ui as { resourceUri?: string };
    assert.match(ui.resourceUri ?? "", /^ui:\/\/graffiticode\/widget-mcp\.[a-f0-9]{8}\.html$/);
    assert.equal(meta["ui/resourceUri"], ui.resourceUri);
    assert.equal(meta["openai/resultCanProduceWidget"], undefined, "openai marker replaced by ui.resourceUri for Claude");
  }
});

test("render_item is compact while get_item preserves the legacy raw contract", () => {
  const renderProperties = (renderItemTool.outputSchema.properties ?? {}) as Record<string, unknown>;
  const rawProperties = (getItemTool.outputSchema.properties ?? {}) as Record<string, unknown>;
  assert.equal(renderProperties.src, undefined);
  assert.equal(renderProperties.data, undefined);
  // ...but the item's links ARE part of the compact contract: clients without a
  // widget (ChatGPT, Codex) get _meta.graffiticode stripped, so a link that lived
  // only in the prose summary would be unaddressable for them.
  assert.ok(renderProperties.view_url, "render_item must expose view_url as a field");
  assert.ok(renderProperties.claim_url, "render_item must expose claim_url as a field");
  assert.ok(rawProperties.src);
  assert.ok(rawProperties.data);
});

test("parseHelp rejects valid JSON that is not an array", () => {
  assert.deepEqual(parseHelp('{"user":"not history"}'), []);
  assert.deepEqual(parseHelp("null"), []);
  assert.equal(parseHelp('[{"user":"hello"}]').length, 1);
});

test("a Claude-named client that declares no MCP Apps support gets NO widget", () => {
  // Regression: Claude Code matches the /claude/i name whitelist but declares no
  // extensions (verified in production: host=claude-code v=2.1.219, extensions=[]).
  // Advertising a widget to it made every render_item render "Unable to reach
  // Graffiticode" — the host was promised an app it cannot mount, and never even
  // fetched the app HTML. Without the declaration it must get the text + link
  // fallback instead of a broken card.
  for (const declares of [false, undefined]) {
    for (const tool of toolsForClient("claude-code", declares) as ToolRecord[]) {
      const meta = metaOf(tool);
      assert.equal(meta.ui, undefined, `claude-code/${tool.name} must not advertise a widget`);
      assert.equal(meta["ui/resourceUri"], undefined, `claude-code/${tool.name} leaked ui/resourceUri`);
      // securitySchemes still reaches every client.
      assert.deepEqual(meta.securitySchemes, expectedSchemes);
    }
  }
  // And the same client WITH the declaration keeps the widget.
  const withUi = (toolsForClient("claude-code", true) as ToolRecord[]).filter((t) => WIDGET_TOOLS.has(t.name));
  assert.ok(withUi.length > 0);
  for (const tool of withUi) {
    assert.match((metaOf(tool).ui as { resourceUri?: string }).resourceUri ?? "", /^ui:\/\/graffiticode\/widget-mcp\./);
  }
});

test("the ready summary hides our placeholder name and links instead of dumping URLs", () => {
  const url = "https://app.graffiticode.org/form/ITEM?claim=JWT";

  // The console defaults an omitted name to the literal "unnamed", which made the
  // no-name branch unreachable and printed our placeholder in bold as the title.
  for (const placeholder of [null, "", "  ", "unnamed", "Unnamed", " UNNAMED "]) {
    const s = buildReadySummary(placeholder, "L0173", url);
    assert.ok(s.startsWith("Your item (L0173) is ready"), `"${placeholder}" should read as unnamed, got: ${s}`);
    assert.doesNotMatch(s, /unnamed/i, `"${placeholder}" leaked the placeholder`);
  }

  // A real name is still the title.
  assert.ok(buildReadySummary("Sales chart", "L0173", url).startsWith("**Sales chart** (L0173)"));

  // Markdown link, not a bare URL: these carry a ~250-char claim JWT.
  const s = buildReadySummary("Sales chart", "L0173", url);
  assert.ok(s.includes(`[open the form view](${url})`), s);
  assert.doesNotMatch(s, /view: https/, "URL should not be printed bare");

  // The claim message is appended verbatim and must not repeat "is ready".
  const withClaim = buildReadySummary(null, "L0173", url, "To keep it permanently, [sign in to save it](x).");
  assert.equal(withClaim.match(/is ready/g)?.length, 1, "'is ready' should appear once");
});

test("the generating response puts the real item id in the prose, not a placeholder", () => {
  // Generation is async and there is no list_items tool, so this response is the
  // only record of the handle. A client that renders text and drops
  // structuredContent — the MCP Inspector does exactly this — would otherwise be
  // told to "call render_item(item_id)" with no way to learn the id, leaving an
  // item that can never be reached again.
  for (const op of ["create", "update"] as const) {
    const r = buildGeneratingResponse("ITEM123", "0173", null, op);
    assert.equal(r.item_id, "ITEM123");
    for (const field of ["summary", "message"] as const) {
      assert.ok(String(r[field]).includes('render_item("ITEM123")'), `${op}/${field} must name the id`);
      assert.doesNotMatch(String(r[field]), /render_item\(item_id\)/, `${op}/${field} still has the placeholder`);
    }
  }
  // A named item keeps its name in the summary and still carries the id.
  const named = buildGeneratingResponse("ITEM456", "0166", "Sales table", "create");
  assert.ok(String(named.summary).includes('"Sales table"'));
  assert.ok(String(named.summary).includes('render_item("ITEM456")'));
});

test("client host classification separates the four ways a connection binds to an account", () => {
  // Claude Code must not fall into the claude.ai bucket: it takes an Authorization
  // header, and claude.ai has no header field at all. Production reports these as
  // distinct names (host=claude-code vs host=claude-ai), which is what makes the
  // split possible at all.
  assert.equal(classifyClientHost("claude-code"), "claude-code");
  assert.equal(classifyClientHost("claude-ai"), "claude-app");
  assert.equal(classifyClientHost("claude-desktop"), "claude-app");
  for (const openai of ["ChatGPT", "openai-apps", "codex-mcp-client"]) {
    assert.equal(classifyClientHost(openai), "openai", `${openai} should classify as openai`);
  }
  assert.equal(classifyClientHost("cursor"), "editor");
  assert.equal(classifyClientHost("Visual Studio Code"), "editor");
  // Unnamed or unrecognized clients must land somewhere renderable, never undefined.
  assert.equal(classifyClientHost(undefined), "unknown");
  assert.equal(classifyClientHost("web-sandbox"), "unknown");
});

test("the reconnect hint tells header-capable hosts about the key and never promises absent sign-in", () => {
  // Header-capable hosts point at the page, because only the page can mint a key.
  for (const host of ["claude-code", "editor"] as const) {
    assert.match(reconnectHint(host), /api-key/, `${host} should name the key placeholder`);
    assert.match(reconnectHint(host), /sign-in page issues the key/, `${host} should say where the key comes from`);
  }
  assert.match(reconnectHint("claude-code"), /claude mcp add --transport http/);
  // claude.ai/ChatGPT have no header field, so they must never be told to paste one.
  for (const host of ["claude-app", "openai"] as const) {
    assert.doesNotMatch(reconnectHint(host), /Authorization|api-key/, `${host} has no header field`);
  }
  // Every bucket returns something; an empty hint would append a bare space to the
  // claim message.
  for (const host of ["claude-code", "claude-app", "openai", "editor", "unknown"] as const) {
    assert.ok(reconnectHint(host).trim().length > 0, `${host} hint must be non-empty`);
  }
});

test("free-plan claim fields carry the host bucket and the reconnect hint", () => {
  const auth: AuthContext = { type: "freePlan", sessionId: "sess-1" };
  const fields = buildClaimFields(auth, "tok-abc", "cursor");
  assert.ok(fields);
  // The console keys its connect instructions off `agent`; it must be the coarse
  // bucket, never the raw client name. Not `client=`, which the console already
  // reads app-wide as the item source surface.
  assert.match(fields.claim_url, /[?&]agent=editor(&|$)/);
  assert.doesNotMatch(fields.claim_url, /[?&]client=/);
  assert.match(fields.claim_url, /[?&]src=chat(&|$)/);
  assert.match(fields.claim_url, /[?&]token=tok-abc(&|$)/);
  assert.ok(fields.claim_message.includes(fields.claim_url), "message must carry the link");
  assert.ok(fields.claim_message.includes(reconnectHint("editor")), "message must carry the hint");

  // Three surfaces can offer this claim and each needs its own value: `chat` (the
  // link an agent prints), `widget` (the in-host button, here), and `footer` (the
  // app's /form attribution bar). Collapsing any two hides which one converts.
  assert.match(fields.claim_url_widget, /[?&]src=widget(&|$)/);
  assert.match(fields.claim_url_widget, /[?&]token=tok-abc(&|$)/);
  assert.match(fields.claim_url_widget, /[?&]agent=editor(&|$)/);
  // `footer` belongs to the app page, which mints its own link — this repo must
  // never emit it, or the two render surfaces merge again.
  assert.doesNotMatch(fields.claim_url_widget, /[?&]src=footer/);
  // The chat-facing message must keep the chat attribution, or the fix inverts
  // the very thing it measures.
  assert.doesNotMatch(fields.claim_message, /[?&]src=(widget|footer)/);

  // An unnamed client still gets a well-formed URL rather than agent=undefined.
  const anon = buildClaimFields(auth, "tok-abc");
  assert.match(anon!.claim_url, /[?&]agent=unknown(&|$)/);

  // Authenticated callers are already bound to an account: no claim, no nudge.
  assert.equal(buildClaimFields({ type: "firebase", token: "t" }, "tok-abc", "cursor"), null);
  // No token (unconfigured salt) degrades to no claim fields, not a broken link.
  assert.equal(buildClaimFields(auth, null, "cursor"), null);
});

/**
 * No agent-facing text may name a retired language.
 *
 * `create_item`'s `language` parameter carried the example `'L0166'` for weeks
 * after L0166 was deprecated (2026-08-26) and left the catalog. That was harmless
 * until 2026-09-18, when a session lost mid-conversation meant `list_languages`
 * never returned — and the model, with no catalog to read, called
 * `create_item(L0166)` using the one language id it could see: the example.
 *
 * An example in a schema is not decoration. It is the fallback a model reaches
 * for when everything else fails, so it has to be a language that exists.
 */
test("tool definitions never name a retired language", async () => {
  const { tools } = await import("../src/tools.js");
  const RETIRED = ["L0166", "L0158"];
  const text = JSON.stringify(tools);
  for (const id of RETIRED) {
    assert.ok(!text.includes(id), `a tool definition still names retired language ${id}`);
  }
});

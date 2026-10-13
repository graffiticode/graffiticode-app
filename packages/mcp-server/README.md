# Graffiticode MCP Server Documentation

The Graffiticode MCP server connects AI assistants and applications to a growing catalog of domain-specific tools. Each tool is powered by a Graffiticode language — a specialized DSL optimized for a particular task domain. You interact with these languages entirely through natural language: describe what you want to create, and a language-specific AI generates the result.

You never need to learn or write DSL code. The MCP server is the interface.

The server is operated by Artcompiler.

---

## How It Works

The Graffiticode MCP server is a **thin router**. It exposes seven language-agnostic tools that route your natural language requests to language-specific backends. Each backend has deep knowledge of its language's domain and translates your descriptions into working programs.

```
┌──────────────────────────────────────────────────────────┐
│  Your AI Assistant (Claude, ChatGPT, or any MCP client)  │
│  "Create a concept web assessment about photosynthesis"  │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Graffiticode MCP Server (thin router)                   │
│  Tools: create_item, update_item, render_item, get_item, │
│         get_spec, list_languages, get_language_info      │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Graffiticode API → Language-specific AI backends        │
│  Discover the current catalog with list_languages        │
└──────────────────────────────────────────────────────────┘
```

The workflow is the same regardless of language:

1. **Discover** — Call `list_languages` to see what's available.
2. **Learn** — Call `get_language_info` for details about a specific language.
3. **Create** — Call `create_item` with a language ID and a natural language description.
4. **Retrieve** — Call `render_item` to display the finished item. (`get_item` returns raw source and data for programmatic use.)
5. **Iterate** — Call `update_item` with a natural language description of what to change, then `render_item` again.

### Generation is asynchronous

`create_item` and `update_item` return **immediately** with an `item_id` and `status: "generating"`. Generation typically takes 60–110 seconds. Call `render_item` (or `get_item` for raw data) to wait for the result — it long-polls until the item is `ready` (or `failed`), so you don't need to write your own retry loop.

---

## Connecting to the Server

The server speaks the **Streamable HTTP** transport and is available at:

```
https://mcp.graffiticode.org/mcp
```

### Claude Desktop

Add via **Settings → Connectors** with the URL `https://mcp.graffiticode.org/mcp`. OAuth authentication is handled automatically.

### Claude Code

```json
{
  "mcpServers": {
    "graffiticode": {
      "url": "https://mcp.graffiticode.org/mcp"
    }
  }
}
```

To authenticate with an API key instead of OAuth, add a header:

```json
{
  "mcpServers": {
    "graffiticode": {
      "url": "https://mcp.graffiticode.org/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

### ChatGPT and Other MCP Clients

Any MCP-compatible client can connect using Streamable HTTP transport at the `/mcp` endpoint.

### Authentication

Authentication is **optional**. The server supports three modes:

- **No auth (free plan)** — connect without credentials to try the server. Items you create are scoped to an anonymous workspace, which follows your items across reconnects rather than being tied to a single transport session. You can create items and revise each one up to **5 times**; a shared daily allowance applies across all free-plan users. Once an item is ready, the response carries a `view_url` and a `claim_url`; opening the claim link and signing in transfers **the whole workspace** into a real Graffiticode account. Claim links are valid for **24 hours**, and unclaimed items are removed after **48 hours**.
- **OAuth 2.1** (recommended for interactive clients) — the server implements OAuth 2.1 with PKCE. Clients that support MCP OAuth discovery are guided through the flow automatically.
- **API key** (for programmatic access) — pass your Graffiticode API key as a Bearer token: `Authorization: Bearer gc_xxxxx`

---

## Tools Reference

### list_languages

Discover what Graffiticode languages are available. The catalog is dynamic and grows over time.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `search` | string | No | Match by keyword (e.g. "spreadsheet", "flashcard", "chart") |
| `domain` | string | No | Narrow to a domain (e.g. "assessments", "sheets", "diagrams") |

Returns each language's `id`, `name`, `description`, `domains`, and a `when_to_use` steering note.

Some languages are **vendor-gated** — they target a specific vendor or platform and say so in `when_to_use`. Don't select one unless the user actually named that vendor.

---

### get_language_info

Get detailed authoring information about a specific language.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `language` | string | Yes | Language ID (e.g., "L0169") |

Returns an inline `authoring_guide`, `supported_item_types`, `not_for` (out-of-scope uses), `example_prompts`, a `spec_url`, and a `user_guide_resource` URI you can read for the full reference.

---

### create_item

Create a new item in any Graffiticode language. Describe what you want in natural language — the language-specific AI backend handles everything else.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `language` | string | Yes | Language ID (e.g., "L0169"). Use `list_languages` to discover options. |
| `description` | string | Yes | Natural language description of what to create. |
| `name` | string | No | A friendly name for the item. |

**Returns** an `item_id` and `status: "generating"`. Call `render_item` to await and display the result.

**What makes a good description?** Be specific. Include domain-relevant details, and describe the *end result* you want rather than implementation details. The language-specific AI understands domain terminology.

---

### update_item

Modify an existing item by describing what you want to change. The language is auto-detected from the item.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item_id` | string | Yes | The item ID from a previous call. |
| `modification` | string | Yes | Natural language description of what to change. |

The server maintains conversation history per item, so the language AI has context from previous turns. Like `create_item`, it returns `status: "generating"`.

---

### render_item

Retrieve an item and display it, waiting for generation to finish. This is the **preferred user-facing retrieval tool** — call it after `create_item` or `update_item`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item_id` | string | Yes | The item ID to render. |

Long-polls until the item is `ready` or `failed`, then returns a **compact** result (`item_id`, `status`, `language`, `name`, `view_url`, and a short summary; free-plan items also carry `claim_url`/`claim_message`). The language-private `src` and `data` are kept out of the model transcript while still hydrating the interactive widget in Claude.

---

### get_item

Retrieve an item's raw `src`, `data`, and metadata by its ID. Intended for **programmatic clients**; for normal use prefer `render_item`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item_id` | string | Yes | The item ID to retrieve. |

Long-polls until the item is `ready` or `failed`. Returns the item's data, code, and metadata.

> **`src` and `data` are private to the item's own language.** Don't feed them — or a raw item id — into a request for a different language. Use `get_spec` instead.

---

### get_spec

Get a platform-neutral, plain-English description of an item's content.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item_id` | string | Yes | The item ID to describe. |

This is the **only sanctioned way to move content between languages**. To turn a spreadsheet into flashcards, call `get_spec` on the spreadsheet item, then pass that spec (plus your intent) to `create_item` for the flashcard language.

---

## Resources

Beyond tools, the server exposes MCP resources:

| Resource | URI | What it is |
|---|---|---|
| Language user guide | `graffiticode://language/{id}/user-guide` | The full authoring reference for a language (markdown). |
| Agent skills | `graffiticode://skills/<id>` | Task-oriented skills for agents, discovered at request time from the public [graffiticode-skills](https://github.com/graffiticode/graffiticode-skills) repo — new skills appear without a redeploy. |
| Widget | `ui://graffiticode/claude-form-widget.html` | The MCP Apps widget that renders items inline in Claude. ChatGPT gets no widget — it shows the tool result's text summary and an "Open in Graffiticode" link. |

---

## Available Languages

The language catalog is **dynamic** — call `list_languages` to discover what's currently available, and `get_language_info` for details on any specific language. Each language has its own specification page, source repository, and usage documentation.

Rather than duplicating a table here that goes stale, start with:

```
list_languages()                          # everything
list_languages(search: "assessment")      # by keyword
list_languages(domain: "sheets")          # by domain
```

---

## Rendering Items in Your Application

In **Claude** (web and desktop), items render inline as interactive widgets directly in the chat interface — no setup needed. In **ChatGPT** the result is shown as a text summary with an "Open in Graffiticode" link.

To embed items in your own application, every Graffiticode language has a corresponding React component published on npm as `@graffiticode/<language-id>`. Install that package and render its component with the item's `data` (which `get_item` returns).

---

## Conversation History and Context

The MCP server maintains conversation history for each item. When you call `update_item`, the server passes context from previous interactions to the language-specific AI, so it understands what you've already created and can make precise modifications.

This means you can work iteratively in a natural conversational style:

1. "Create a concept web about the water cycle with Evaporation at the center"
2. "Add Runoff as a connected concept"
3. "Make it use a dark theme"
4. "Add assessment to all the connected concepts"

Each step builds on the previous ones.

---

## Self-Hosting

### Build and run

```bash
git clone https://github.com/graffiticode/graffiticode-mcp-server.git
cd graffiticode-mcp-server
npm install && npm run build
npm start          # Streamable HTTP server on PORT (default 3001)
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `MCP_SERVER_URL` | `https://mcp.graffiticode.org` | Public URL, used for OAuth metadata and discovery |
| `GRAFFITICODE_CONSOLE_URL` | `https://console.graffiticode.org/api` | Console GraphQL endpoint (note the `/api` suffix) |
| `GRAFFITICODE_CONSOLE_BASE_URL` | `https://console.graffiticode.org` | Console host, used to build claim URLs |
| `GRAFFITICODE_API_URL` | `https://api.graffiticode.org` | API host: language templates and code generation |
| `GRAFFITICODE_APP_URL` | `https://app.graffiticode.org` | App host, used to build item view links |
| `GRAFFITICODE_AUTH_URL` | `https://auth.graffiticode.org` | Auth endpoint |
| `GRAFFITICODE_SKILLS_REPO` | `graffiticode/graffiticode-skills` | Public GitHub repo serving agent skills |
| `GRAFFITICODE_SKILLS_REF` | `main` | Git ref for skill discovery |
| `GRAFFITICODE_SKILLS_TTL_MS` | `60000` | Skill catalog cache TTL |
| `FREE_PLAN_NAMESPACE_SALT` | — | HS256 secret for trial-claim JWTs. Must match the console's value. If unset, trial responses still work but omit claim links. |
| `OAUTH_RECONNECT_ENABLED` | `false` | Whether claude.ai/ChatGPT users are told to reconnect their connector and sign in. Off until `/oauth/consent` accepts the email and wallet sign-ins those users actually have (it is Google-only today), because their connector UIs take no API key and pointing them at an unusable button is worse than saying nothing. Affects trial copy only — never auth itself. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | — | Token served verbatim at `/.well-known/openai-apps-challenge` for OpenAI app-directory domain verification. Set only during submission; the route 404s while unset. |
| `INTERNAL_API_KEY` | — | Sent as `X-Internal-API-Key` to the auth service |

### Deployment

Deployed to Google Cloud Run (`mcp-service`, `us-central1`), fronted by Cloudflare:

```bash
npm run gcp:build    # build + deploy via Cloud Build
npm run gcp:logs     # tail logs
```

---

## Support

- **Email:** [support@graffiticode.org](mailto:support@graffiticode.org)
- **Community:** [forum.graffiticode.org](https://forum.graffiticode.org)
- **Bug reports:** [GitHub Issues](https://github.com/graffiticode/graffiticode-mcp-server/issues)
- **About:** [mcp.graffiticode.org/about](https://mcp.graffiticode.org/about)
- **Privacy policy:** [mcp.graffiticode.org/privacy](https://mcp.graffiticode.org/privacy)
- **Terms of service:** [mcp.graffiticode.org/terms](https://mcp.graffiticode.org/terms)

---

## Source Code

The MCP server is open source under the MIT license, copyright Artcompiler.

- **Repository:** [github.com/graffiticode/graffiticode-mcp-server](https://github.com/graffiticode/graffiticode-mcp-server)
- **Skills:** [github.com/graffiticode/graffiticode-skills](https://github.com/graffiticode/graffiticode-skills)

All Graffiticode languages are accessed through the natural language interface provided by this MCP server or the Graffiticode console at [console.graffiticode.org](https://console.graffiticode.org). Direct code authoring is neither required nor recommended.

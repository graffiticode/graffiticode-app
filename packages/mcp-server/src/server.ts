#!/usr/bin/env node

/**
 * Hosted MCP Server for Graffiticode
 *
 * Runs as an HTTP server with Streamable HTTP transport.
 * Users authenticate by passing their Graffiticode API key in the Authorization header.
 *
 * Usage:
 *   node dist/server.js
 *
 * Client config:
 *   {
 *     "mcpServers": {
 *       "graffiticode": {
 *         "url": "http://localhost:3001/mcp",
 *         "headers": {
 *           "Authorization": "Bearer gc_xxxxx"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  tools,
  handleToolCall,
  SERVER_INSTRUCTIONS,
  buildServerInstructions,
  toolsForClient,
  shouldAdvertiseWidget,
  widgetRouteFor,
  isOpenAIClient,
  isWidgetHost,
} from "./tools.js";
import { formatToolResult } from "./tool-result.js";
import { buildChallengeResponse } from "./challenge.js";
import { startSseKeepalive } from "./sse-keepalive.js";
import { FreePlanLimitError, buildFreePlanLimitText } from "./free-plan-limit.js";
import type { AuthContext } from "./api.js";
import { withUpstreamTiming, getCachedFullCatalog, warmCatalog } from "./api.js";
import { watchBadRequests } from "./bad-request-log.js";
import {
  effectiveSession,
  identify,
  logConnect,
  logListed,
  logResource,
  logSessionStarted,
  logToolCall,
  type EventOutcome,
  type SessionMeta,
} from "./events.js";
import { mintSessionToken } from "./session-token.js";
import { deriveSessionNamespace } from "./claim-token.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import {
  generateWidgetHtml,
  widgetResourceUris,
  matchWidgetUri,
  widgetResourceMeta,
  CLAUDE_WIDGET_MIME_TYPE,
} from "./widget/index.js";
import { normalizeLanguageId, isNativeLanguage } from "./widget/languages.js";
import {
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  handleClientRegistration,
  handleAuthorize,
  handleCallback,
  handleToken,
  isOAuthAccessToken,
  resolveOAuthAccessToken,
  buildWwwAuthenticate,
  type OAuthInvalidReason,
} from "./oauth/handlers.js";
import {
  userGuideResourceTemplate,
  matchUserGuideUri,
  readUserGuideResource,
  listSkillResources,
  matchSkillUri,
  readSkillResource,
} from "./resources.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

/**
 * Enumeration requests, mapped to the `what` reported by `mcp_listed`.
 *
 * Resource templates count as resources: a client that asks for templates is
 * asking what user guides exist, which is the same act as listing them.
 */
const LIST_METHODS: Record<string, "tools" | "resources" | "prompts"> = {
  "tools/list": "tools",
  "resources/list": "resources",
  "resources/templates/list": "resources",
  "prompts/list": "prompts",
};

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Graffiticode MCP Server</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3rem; }
  h3 { font-size: 1.1rem; margin-top: 1.5rem; }
  ul { padding-left: 1.5rem; }
  li { margin-bottom: 0.5rem; }
  a { color: #1a73e8; }
  .subtitle { color: #555; font-size: 0.95rem; margin-bottom: 2rem; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p class="subtitle">Graffiticode MCP Server &mdash; Effective Date: July 13, 2026</p>

<h2>Overview</h2>
<p>The Graffiticode MCP Server (&ldquo;the Service&rdquo;) is operated by Artcompiler. This policy describes how the Service collects, uses, and protects information when you connect to it through an MCP-compatible client such as Claude, ChatGPT, or another AI assistant.</p>

<h2>Information We Collect</h2>

<h3>Authentication Credentials</h3>
<p>The Service supports three ways to connect, and each handles credentials differently:</p>
<ul>
  <li><strong>No credentials (free plan)</strong> &mdash; you may connect without signing in. We do not collect any account identity. Your items are scoped to an anonymous session identifier (see <em>Free-plan sessions</em> below).</li>
  <li><strong>API keys</strong> &mdash; passed as a Bearer token and forwarded to the Graffiticode platform to authenticate the request. API keys are not written to our logs.</li>
  <li><strong>OAuth 2.1</strong> &mdash; if you authorize through the OAuth flow, we store an OAuth record so your session can be refreshed without asking you to sign in repeatedly. <strong>That record includes the email address of the Google account you authorized with, together with an access token and a refresh token.</strong> It is persisted through the Graffiticode auth service, not merely held in memory.</li>
</ul>

<h3>Content You Create</h3>
<p>When you use the Service&rsquo;s content tools (<code>create_item</code>, <code>update_item</code>, <code>render_item</code>, <code>get_item</code>, <code>get_spec</code>), the natural language descriptions you provide and the items you create are sent to the Graffiticode platform and stored there. This includes:</p>
<ul>
  <li>Natural language descriptions and modification requests</li>
  <li>Generated code and compiled output data</li>
  <li>Conversation history for iterative editing (stored per item)</li>
  <li>Item metadata (creation and update timestamps, language, name)</li>
</ul>

<h3>Free-plan Sessions</h3>
<p>If you connect without credentials, items you create are namespaced to the session identifier your MCP client established. The Service can mint a one-time <em>claim link</em>, valid for 24 hours, that lets you transfer those items into a real Graffiticode account the first time you sign in. The claim link contains a signed token derived from the session identifier &mdash; it carries no personal data. If you never claim them, free-plan items remain associated only with that anonymous session.</p>

<h3>Usage Analytics</h3>
<p>The Service emits coarse, privacy-preserving analytics events to measure engagement (connections, catalog and documentation reads, tool usage, success rates). These events deliberately exclude personal data:</p>
<ul>
  <li>Sessions and tokens appear only as <strong>one-way hashes</strong>, never in raw form.</li>
  <li>Your prompt text appears only as a <strong>character count</strong> &mdash; never the prompt itself.</li>
  <li>Location is recorded only as a <strong>coarse country</strong> (and, where available, region) derived at our CDN edge. <strong>We do not record your IP address.</strong></li>
  <li>We record the <strong>client kind</strong> (the name your MCP client reports, e.g. &ldquo;claude-ai&rdquo;), which identifies software, not you.</li>
  <li>When your client lists our tools or opens one of our built-in documentation resources, we record that it did so. The only address recorded is one of our own <code>graffiticode://</code> resources; anything else your client requests is not written to our analytics.</li>
        <li>When you search our language catalog, we record the <strong>length</strong> of your search term and how many languages matched — never the search text itself. A domain filter is recorded only when it matches one we publish; anything else is recorded as <code>(invalid)</code>.</li>
  <li>We record the <strong>lifecycle status</strong> a call returned (<code>ready</code>, <code>generating</code>, <code>failed</code>) so we can tell a delivered item from one still being generated. It describes the state of your item, not its contents, and anything outside that published set is recorded as <code>(invalid)</code>.</li>
</ul>
<p>One caveat, stated plainly: when a request fails we record a truncated backend error message so we can debug it. Error text is not intended to carry your content, but we cannot categorically rule out that a backend message quotes part of an input.</p>

<h3>Server Logs</h3>
<p>The Service writes operational logs for debugging &mdash; request timestamps, error messages, and diagnostic warnings. Authorization headers are never logged. As noted above, the client IP address is not recorded in our analytics events.</p>

<h2>How We Use Your Information</h2>
<ul>
  <li>Authenticate your requests and authorize access to your items</li>
  <li>Generate, store, and retrieve content you create through the Service</li>
  <li>Maintain conversation history to support iterative editing of items</li>
  <li>Debug errors and maintain service reliability</li>
  <li>Understand aggregate usage so we can improve the Service</li>
</ul>

<h2>Data Sharing</h2>
<p>We do not sell your personal information. Data reaches the following parties in the course of running the Service:</p>
<ul>
  <li><strong>Graffiticode platform</strong> &mdash; the console and API receive the content you create and the requests you make. This is where code generation happens and where your items live.</li>
  <li><strong>Google Cloud Platform</strong> &mdash; hosts the Service (Cloud Run) and receives its operational and analytics logs (Cloud Logging).</li>
  <li><strong>Firebase Authentication (Google)</strong> &mdash; processes authentication tokens. See Google&rsquo;s privacy policy for details.</li>
  <li><strong>Cloudflare</strong> &mdash; sits in front of the Service as our CDN and edge network, and necessarily handles your connection. Cloudflare is also the source of the coarse country/region signal described above.</li>
  <li><strong>GitHub</strong> &mdash; the Service fetches its public agent-skill catalog from a public GitHub repository at request time. <strong>No user data is sent to GitHub</strong>; GitHub sees only the Service&rsquo;s own outbound requests.</li>
  <li><strong>Legal requirements</strong> &mdash; we may disclose information if required by law or legal process.</li>
</ul>

<h2>Data Retention</h2>
<ul>
  <li><strong>Items and content</strong> &mdash; retained as long as your Graffiticode account is active, or until you delete them.</li>
  <li><strong>OAuth records</strong> &mdash; the stored email, access token, and refresh token persist until the token is revoked or expires. Access tokens are valid for 55 minutes and are rotated on refresh.</li>
  <li><strong>API keys</strong> &mdash; not stored by the Service; forwarded per request and discarded.</li>
  <li><strong>Free-plan claim tokens</strong> &mdash; valid for 24 hours, after which the link expires.</li>
  <li><strong>Server logs</strong> &mdash; retained for up to 90 days for debugging purposes.</li>
</ul>

<h2>Security</h2>
<ul>
  <li>HTTPS/TLS encryption for all data in transit</li>
  <li>OAuth 2.1 with PKCE (S256) for secure authentication flows</li>
  <li>Short-lived tokens with automatic refresh and rotation</li>
  <li>Long-lived API keys are exchanged for short-lived tokens rather than being embedded in render URLs</li>
  <li>Deployment on Google Cloud Run with managed infrastructure security</li>
</ul>

<h2>Your Rights</h2>
<p>You may:</p>
<ul>
  <li>Request access to or deletion of your data by contacting us</li>
  <li>Delete items you&rsquo;ve created through the Graffiticode console at <a href="https://console.graffiticode.org">console.graffiticode.org</a></li>
  <li>Revoke API keys at any time through your Graffiticode account settings</li>
  <li>Disconnect the Service from your MCP client at any time, which stops all further data flow</li>
</ul>

<h2>Changes to This Policy</h2>
<p>We may update this policy from time to time. Changes will be posted to this page with an updated effective date.</p>

<h2>Contact</h2>
<p>For questions about this privacy policy or your data, contact:</p>
<ul>
  <li>Email: <a href="mailto:support@graffiticode.org">support@graffiticode.org</a></li>
  <li>GitHub: <a href="https://github.com/graffiticode/graffiticode-mcp-server">github.com/graffiticode/graffiticode-mcp-server</a></li>
  <li>About this server: <a href="/about">/about</a></li>
</ul>
</body>
</html>`;

const TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Service — Graffiticode MCP Server</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3rem; }
  ul { padding-left: 1.5rem; }
  li { margin-bottom: 0.5rem; }
  a { color: #1a73e8; }
  .subtitle { color: #555; font-size: 0.95rem; margin-bottom: 2rem; }
</style>
</head>
<body>
<h1>Terms of Service</h1>
<p class="subtitle">Graffiticode MCP Server &mdash; Effective Date: July 13, 2026</p>

<h2>Acceptance of Terms</h2>
<p>By connecting to or using the Graffiticode MCP Server ("the Service"), you agree to these Terms of Service. If you do not agree, do not use the Service.</p>

<h2>Description of Service</h2>
<p>The Service provides a Model Context Protocol (MCP) server that enables AI assistants to create, update, and retrieve interactive content using the Graffiticode platform. The Service routes natural language requests to language-specific backends that generate structured output.</p>

<h2>Account and Authentication</h2>
<p>Authentication is optional. You may connect without credentials on the free plan, or authenticate with a Graffiticode API key or through the OAuth 2.1 authorization flow to associate your work with an account. If you do authenticate, you are responsible for keeping your credentials secure and for all activity under your account.</p>
<p>Items created on the free plan are scoped to an anonymous session and can be transferred into an account using a claim link, which is valid for 24 hours. Until claimed, they are not associated with any account and may be removed.</p>

<h2>Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use the Service to generate content that is illegal, harmful, or violates the rights of others</li>
  <li>Attempt to bypass authentication or access other users' data</li>
  <li>Overload the Service with excessive requests intended to degrade performance</li>
  <li>Reverse-engineer, decompile, or attempt to extract the source code of the backend services</li>
  <li>Use the Service in a way that violates any applicable law or regulation</li>
</ul>

<h2>Intellectual Property</h2>
<p><strong>Your Content</strong> &mdash; You retain ownership of the content you create through the Service, including natural language descriptions and the resulting generated items.</p>
<p><strong>Graffiticode Platform</strong> &mdash; The Service, its APIs, language backends, and underlying technology are owned by Artcompiler. Nothing in these terms grants you rights to the platform's intellectual property beyond the right to use the Service as described here.</p>
<p><strong>Open Source</strong> &mdash; The MCP server source code is available under the MIT license at <a href="https://github.com/graffiticode/graffiticode-mcp-server">github.com/graffiticode/graffiticode-mcp-server</a>.</p>

<h2>Availability and Changes</h2>
<p>The Service is provided on an "as-is" basis. We may modify, suspend, or discontinue the Service at any time without notice. We may also update these terms from time to time; continued use after changes constitutes acceptance.</p>

<h2>Limitation of Liability</h2>
<p>To the maximum extent permitted by law, Artcompiler shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service. The Service is provided without warranties of any kind, express or implied.</p>

<h2>Termination</h2>
<p>We may suspend or terminate your access to the Service at any time for violation of these terms or for any other reason at our discretion. You may stop using the Service at any time by revoking your API key or disconnecting the MCP server from your client.</p>

<h2>Governing Law</h2>
<p>These terms are governed by the laws of the State of California, without regard to conflict of law provisions.</p>

<h2>Contact</h2>
<ul>
  <li>Email: <a href="mailto:support@graffiticode.org">support@graffiticode.org</a></li>
  <li>GitHub: <a href="https://github.com/graffiticode/graffiticode-mcp-server">github.com/graffiticode/graffiticode-mcp-server</a></li>
  <li>About this server: <a href="/about">/about</a></li>
  <li>Privacy policy: <a href="/privacy">/privacy</a></li>
</ul>
</body>
</html>`;

const ABOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About — Graffiticode MCP Server</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3rem; }
  h3 { font-size: 1.1rem; margin-top: 1.5rem; }
  ul { padding-left: 1.5rem; }
  li { margin-bottom: 0.5rem; }
  a { color: #1a73e8; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
  pre { background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
  code { background: #f5f5f5; padding: 0.1rem 0.35rem; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  .subtitle { color: #555; font-size: 0.95rem; margin-bottom: 2rem; }
  .endpoint { font-size: 1.05rem; background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 6px; display: inline-block; margin: 0.25rem 0 1rem; }
</style>
</head>
<body>
<h1>About</h1>
<p class="subtitle">Graffiticode MCP Server</p>

<h2>What it is</h2>
<p>Graffiticode MCP is a hosted Model Context Protocol server that lets AI assistants create and edit interactive content through Graffiticode&rsquo;s language family.</p>

<h2>Connect</h2>
<p>Point any MCP-compatible client at:</p>
<p class="endpoint"><code>https://mcp.graffiticode.org/mcp</code></p>
<p>The server speaks the Streamable HTTP transport. A minimal client config looks like:</p>
<pre><code>{
  "mcpServers": {
    "graffiticode": {
      "url": "https://mcp.graffiticode.org/mcp"
    }
  }
}</code></pre>
<p>Authentication is optional. The server accepts:</p>
<ul>
  <li><strong>OAuth 2.1</strong> &mdash; clients that support dynamic registration can complete the standard authorization flow.</li>
  <li><strong>API key</strong> &mdash; pass a Graffiticode API key as <code>Authorization: Bearer &lt;key&gt;</code>.</li>
  <li><strong>No auth (free plan)</strong> &mdash; connect without credentials to try the server. Items you create can be transferred into a real Graffiticode account via a one-time claim link returned in the tool response.</li>
</ul>

<h2>What it can do</h2>
<p>The server exposes a small, fixed set of language-agnostic tools. The catalog of Graffiticode languages they route to grows over time.</p>
<ul>
  <li><code>list_languages</code> &mdash; discover available languages, optionally filtered by keyword (<code>search</code>) or <code>domain</code>.</li>
  <li><code>get_language_info</code> &mdash; fetch a language&rsquo;s authoring guide, supported item types, and example prompts.</li>
  <li><code>create_item</code> &mdash; create a new item in a chosen language from a natural-language description.</li>
  <li><code>update_item</code> &mdash; iteratively edit an existing item. Conversation history is preserved per item.</li>
  <li><code>render_item</code> &mdash; preferred way to retrieve and display a finished item; returns a compact result and renders it inline in Claude.</li>
  <li><code>get_item</code> &mdash; retrieve an item&rsquo;s raw code and data by id (for programmatic clients).</li>
  <li><code>get_spec</code> &mdash; get a platform-neutral English description of an item&rsquo;s content.</li>
</ul>
<p>All <code>create_item</code> and <code>update_item</code> requests are natural language &mdash; a language-specific backend handles code generation. Clients should not attempt to write Graffiticode DSL directly.</p>
<p>Generation takes time, so <code>create_item</code> and <code>update_item</code> return immediately with a status of <code>generating</code>; call <code>render_item</code> to wait for and display the finished result.</p>
<p>An item&rsquo;s <code>src</code> and <code>data</code> are private to its own language. To reuse one item&rsquo;s content in another language, call <code>get_spec</code> and pass the spec to <code>create_item</code> &mdash; never pass a raw item id or its code across languages.</p>

<h2>Resources</h2>
<p>Alongside the tools, the server exposes MCP resources:</p>
<ul>
  <li><strong>Language user guides</strong> &mdash; <code>graffiticode://language/{id}/user-guide</code>, the full authoring reference for a language.</li>
  <li><strong>Agent skills</strong> &mdash; <code>graffiticode://skills/&lt;id&gt;</code>, discovered at request time from the public <a href="https://github.com/graffiticode/graffiticode-skills">graffiticode-skills</a> repo, so new skills appear without a redeploy.</li>
  <li><strong>Inline widget</strong> &mdash; in Claude (MCP Apps), items render as interactive widgets directly in the chat. In ChatGPT the result is shown as a text summary with an &ldquo;Open in Graffiticode&rdquo; link.</li>
</ul>

<h2>When to reach for it</h2>
<p>For human users: when you want an AI assistant to author interactive content that can be embedded, shared, or published.</p>
<p>For agents: call <code>list_languages</code> when a user&rsquo;s request doesn&rsquo;t match a more specific tool you already have. If a language matches, fetch its info and create an item; if nothing matches, this server is the wrong tool.</p>

<h2>Free plan</h2>
<p>The no-auth path lets a user try the server before creating an account. Items created this way live in an anonymous session namespace. Once an item is ready, the response includes a <code>view_url</code> for viewing it and a <code>claim_url</code> the user can open to move the item into a real Graffiticode account on first sign-in. Claim links are valid for 24 hours.</p>

<h2>Operator</h2>
<p>This server is operated by Artcompiler and hosted on Google Cloud Run. Source is available under the MIT license at <a href="https://github.com/graffiticode/graffiticode-mcp-server">github.com/graffiticode/graffiticode-mcp-server</a>.</p>

<h2>Links</h2>
<ul>
  <li><a href="https://console.graffiticode.org">Graffiticode console</a> &mdash; manage your account and items</li>
  <li><a href="/privacy">Privacy policy</a></li>
  <li><a href="/terms">Terms of service</a></li>
  <li>Contact: <a href="mailto:support@graffiticode.org">support@graffiticode.org</a></li>
</ul>
</body>
</html>`;

// Store active transports and servers by session
const transports = new Map<string, StreamableHTTPServerTransport>();
const servers = new Map<string, Server>();

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Coarse, non-PII geo from request headers. We are behind Cloudflare, which
 * injects `CF-IPCountry` (and, on some plans, region) at the edge — so we read
 * country/region only and never touch the raw client IP (`cf-connecting-ip`).
 * Sentinel countries Cloudflare uses for unknown/Tor are dropped.
 */
function geoFromHeaders(headers: IncomingMessage["headers"]): SessionMeta {
  const meta: SessionMeta = {};
  const country = firstHeader(headers["cf-ipcountry"])?.toUpperCase();
  if (country && country !== "XX" && country !== "T1") {
    meta.geoCountry = country;
  }
  const region = firstHeader(headers["cf-region-code"])?.toUpperCase();
  if (region) meta.geoRegion = region;
  return meta;
}

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.graffiticode.org";

// How often to write a comment into an open SSE stream, keeping it under the CDN's
// 100s idle timeout (see src/sse-keepalive.ts). 30s leaves a wide margin; 0 disables.
const SSE_KEEPALIVE_MS = parseInt(process.env.SSE_KEEPALIVE_MS || "30000", 10);

/**
 * Keep an /mcp response alive if it turns out to be an event stream.
 *
 * Distinct from the per-tool-call heartbeat in the CallTool handler, which sends
 * protocol notifications only while a tool is running: this covers every open
 * stream, including the idle standalone `GET /mcp` one that has no tool call
 * behind it and was therefore being cut at ~100s by Cloudflare (524).
 */
function keepSseAlive(res: ServerResponse): void {
  startSseKeepalive(res, SSE_KEEPALIVE_MS);
}

// Machine-readable MCP discovery document. Served at both /mcp.json and
// /.well-known/mcp.json so agents and registries can locate the canonical
// endpoint and tool set without an authenticated call. Trial tokens are NOT
// published here — they are scoped per toolset on the toolset subdomains.
const ROBOTS_TXT = `# Graffiticode MCP server — https://mcp.graffiticode.org
#
# This host is an MCP (Model Context Protocol) endpoint, not a website.
# Directory and catalogue crawlers are welcome: everything served here is
# public by design.
#
# Machine-readable description of this server and the tools it exposes:
#   /  ·  /mcp.json  ·  /.well-known/mcp.json
# Human-readable:
#   /about  ·  /privacy  ·  /terms
# The endpoint itself (Streamable HTTP; POST an \`initialize\` first):
#   /mcp
#
# Please send a User-Agent that names you, ideally with a contact URL —
# "example-crawler/1.0 (+https://example.com/bot)". Clients impersonating
# another product's User-Agent may be challenged.

User-agent: *
Allow: /
Disallow: /oauth/
`;

const MCP_DISCOVERY = {
  mcp_endpoint: `${MCP_SERVER_URL}/mcp`,
  site: MCP_SERVER_URL,
  description:
    "Graffiticode is a universal MCP server of smart tools for AI agents and the people who use them. Each tool is one domain language wrapped by a specialized AI; call list_languages to discover what is available.",
  tools: [
    "create_item",
    "update_item",
    "get_item",
    "render_item",
    "get_spec",
    "list_languages",
    "get_language_info",
  ],
  product_url: "https://graffiticode.org",
  console_url: "https://console.graffiticode.org",
  forum_url: "https://forum.graffiticode.org",
  github_url: "https://github.com/graffiticode",
};

function handleMcpDiscovery(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300",
  });
  res.end(JSON.stringify(MCP_DISCOVERY, null, 2));
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  // Support "Bearer <token>" format
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return authHeader;
}

/**
 * Resolve the bearer credential to whatever should be forwarded to the
 * console as Authorization. OAuth access tokens are exchanged here for a
 * Firebase ID token (we already hold the refresh token in the OAuth store).
 * Anything else is treated as a Graffiticode api key and forwarded verbatim
 * — the console will exchange it to a Firebase ID token before calling
 * api.graffiticode.org. This keeps the api-key exchange logic in one place.
 */
type BearerResolution =
  | { kind: "oauth"; token: string }
  | { kind: "oauth-invalid"; reason: OAuthInvalidReason }
  | { kind: "apikey"; token: string };

async function resolveBearer(bearerToken: string): Promise<BearerResolution> {
  // A bearer minted by us as an OAuth access token (recognizable prefix) is
  // validated as one: expiry/resource/scope/revocation are checked, and an invalid
  // one yields a challenge — it must NEVER silently downgrade to the API-key path.
  if (isOAuthAccessToken(bearerToken)) {
    const resolved = await resolveOAuthAccessToken(bearerToken);
    if (resolved.status === "valid") {
      return { kind: "oauth", token: resolved.firebaseToken };
    }
    return { kind: "oauth-invalid", reason: resolved.reason };
  }
  // Anything without our prefix is treated as a raw Graffiticode api key and
  // forwarded verbatim — the console exchanges it before calling api.graffiticode.
  return { kind: "apikey", token: bearerToken };
}

/**
 * Thrown by the OAuth auth provider's getAuth() when the access token that
 * established the session has since expired or been revoked. Caught in the tool
 * handler to return a structured MCP error carrying `_meta["mcp/www_authenticate"]`,
 * which prompts ChatGPT to re-link the account.
 */
class AuthChallengeError extends Error {
  constructor(public reason: OAuthInvalidReason) {
    super(`OAuth token invalid: ${reason}`);
    this.name = "AuthChallengeError";
  }
}

interface AuthProvider {
  getAuth(): Promise<AuthContext>;
}

/**
 * Did this client declare MCP Apps support during `initialize`?
 *
 * The widget is advertised only to a client that says it can render one — a name
 * whitelist alone is not enough (Claude Code matches the name and declares nothing;
 * see shouldAdvertiseWidget).
 */
function declaresUiExtension(server: Server): boolean {
  const caps = server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined;
  return !!caps?.extensions && EXTENSION_ID in caps.extensions;
}

function createMcpServer(authProvider: AuthProvider, sessionMeta: SessionMeta = {}) {
  // One server instance per transport session, so this is per-session state:
  // the first tool call is what turns a bare connect into a real session.
  let sessionStartLogged = false;
  const server = new Server(
    {
      name: "graffiticode",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        // Lets us emit notifications/message during long tool calls (the
        // keepalive fallback when the client didn't request progress).
        logging: {},
        // Advertise MCP Apps (interactive UI) support. `extensions` is not yet
        // in the SDK's ServerCapabilities type (pending SEP-1724), so cast.
        extensions: {
          [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      } as Record<string, unknown>,
      // Carries the catalog inline when we have one cached, so a clear request
      // can go straight to create_item instead of paying ~14s for two
      // pre-flight discovery calls. Falls back to the bare instructions —
      // which tell the model to call list_languages() — when the cache is cold.
      instructions: buildServerInstructions(getCachedFullCatalog()),
    }
  );

  // List available tools. The widget a tool's _meta.ui.resourceUri points at is
  // host-dependent (ChatGPT needs the Skybridge widget, Claude the MCP-Apps one) —
  // see toolsForClient(). Log the host so the OpenAI matcher can be tuned if a
  // client name doesn't match.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const clientName = server.getClientVersion()?.name;
    // OpenAI/ChatGPT clients (incl. Codex) get no widget — its sandbox can't reliably
    // render ours, and web vs desktop are indistinguishable at the MCP layer, so we
    // give them all the text-link experience. Claude gets the native widget.
    //
    // We gate on the client NAME, but a client also tells us during initialize whether
    // it supports MCP Apps at all, via capabilities.extensions[EXTENSION_ID]. Log both:
    // when a host that is handed widget metadata never declared the extension, the
    // widget cannot mount and the mismatch is the explanation — the name whitelist
    // promised UI to a client that never claimed to render it.
    const clientCaps = server.getClientCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined;
    const declaredExtensions = Object.keys(clientCaps?.extensions ?? {});
    const declaresUi = declaresUiExtension(server);
    // The full client identity, not just the name. Two different Claude surfaces —
    // the terminal CLI and Cowork — both connect as `claude-code`, and the widget
    // decision hinges on telling them apart, so log every field the handshake
    // actually gives us: `title` (a display name a GUI may send where a CLI does
    // not) and the complete capability key set, not only `extensions`. All of it is
    // client-declared product metadata, never user content.
    const info = server.getClientVersion() as
      | { name?: string; version?: string; title?: string }
      | undefined;
    const capKeys = Object.keys((clientCaps ?? {}) as Record<string, unknown>);
    console.log(
      `[widget] tools/list host=${clientName ?? "?"} v=${info?.version ?? "?"} → ${
        widgetRouteFor(clientName, declaresUi) === "mcp-apps" ? "native widget (mcp-apps)"
          : widgetRouteFor(clientName, declaresUi) === "openai" ? "native widget (openai)"
          : "text-link (no widget)"
      } | declares_ui_extension=${declaresUi} extensions=[${declaredExtensions.join(",")}]` +
        ` title=${info?.title ?? "-"} caps=[${capKeys.join(",")}]`
    );
    return {
      tools: toolsForClient(clientName, declaresUi),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Funnel instrumentation: capture metadata only (never raw prompts).
    const start = Date.now();
    const toolArgs = (args ?? {}) as Record<string, unknown>;
    const lang = typeof toolArgs.language === "string" ? toolArgs.language : undefined;
    const description =
      typeof toolArgs.description === "string"
        ? toolArgs.description
        : typeof toolArgs.modification === "string"
        ? toolArgs.modification
        : undefined;
    const descLen = description?.length;
    // Discovery shape, list_languages only. The search STRING never leaves this
    // scope — only its length — so a user's own phrasing can't reach the logs;
    // `domain` is allowlisted downstream by normalizeDomain.
    const searchLen =
      name === "list_languages" && typeof toolArgs.search === "string"
        ? toolArgs.search.length
        : undefined;
    const domain =
      name === "list_languages" && typeof toolArgs.domain === "string"
        ? toolArgs.domain
        : undefined;
    // The item the caller named. create_item has none yet — its id comes back on
    // the result — so the success path prefers the result's id and falls back to
    // this. Kept here so the ERROR path can still say which item a failed
    // update/render was about, which is the half of the lifecycle that explains
    // an abandoned item.
    const argItemId = typeof toolArgs.item_id === "string" ? toolArgs.item_id : undefined;
    let identity: { auth: "freePlan" | "firebase"; session: string } | null = null;
    // Hoisted so the catch below can label an error with the workspace the call
    // reached before it failed — a create can adopt a workspace and then have
    // generation fail, and that failure belongs to the adopted workspace.
    let authCtx: AuthContext | null = null;

    // clientInfo isn't known when the session id is minted (mcp_connect), but
    // it's set by the time any tool runs — backfill it onto the session meta.
    const clientKind = server.getClientVersion()?.name;
    if (clientKind && !sessionMeta.clientKind) sessionMeta.clientKind = clientKind;

    // Keepalive heartbeat. L0175 create_item/update_item legitimately take
    // 60-90s (LLM generation), which exceeds some MCP clients' read timeout —
    // they declare a "retryable server error" even though the call succeeds.
    // The streamable-HTTP transport holds this POST's SSE stream open until we
    // return; emitting a notification every 10s keeps bytes flowing so the
    // client's read timer never fires. `extra.sendNotification` is
    // request-scoped, so the SDK routes it to this POST's stream.
    // Prefer notifications/progress when the client opted in (sent a
    // progressToken); otherwise fall back to a debug log notification, which
    // needs no token and still resets the timer. Fast tools return before the
    // first tick, so this is a no-op for them.
    //
    // The message says how long it has been running, because "Generating…" repeated
    // six times is indistinguishable from a hung call — which is what a user
    // reported seeing on 2026-09-09, describing the render_item cycle as thrashing.
    // Elapsed seconds is the one honest thing this layer knows: it polls a job it
    // does not stream, so it has no token count, no stage and no percentage. Saying
    // "20s" is true; a progress bar would be invented.
    //
    // Every observed client sends a progressToken — claude-code and both Codex
    // names, 49 of 49 calls in the last six hours — so the fallback below is for a
    // client we have not met.
    const progressToken = request.params._meta?.progressToken;
    const startedAt = Date.now();
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      heartbeatTicks += 1;
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      const text = `Generating… ${elapsedS}s`;
      const note: ServerNotification =
        progressToken !== undefined
          ? {
              method: "notifications/progress",
              // `progress` counts SECONDS rather than ticks. A client that renders a
              // bar needs a monotonic number it can scale; seconds is one, and it
              // stays meaningful if the interval ever changes. No `total` is sent —
              // we genuinely do not know how long a generation will take, and a made
              // up total is worse than none.
              params: { progressToken, progress: elapsedS, message: text },
            }
          : {
              method: "notifications/message",
              params: { level: "debug", data: text },
            };
      extra.sendNotification(note).catch(() => {});
    }, 10_000);

    // Latency breakdown. `ms` alone says a call took 19 seconds; it cannot say
    // whether that went on resolving auth, waiting for the console, or our own
    // code — and the first tool call of every organic visit costs 12-20s while
    // the rest cost ~300ms, so which of the three it is decides where to look.
    let authMs: number | undefined;
    let upstream: { ms: number; calls: number } | undefined;
    try {
      const authStart = Date.now();
      const auth = await authProvider.getAuth();
      authMs = Date.now() - authStart;
      authCtx = auth;
      identity = identify(auth);

      // Emitted before the call runs, not after: the decision to ask is the
      // event, and a session whose first request errors still started.
      if (!sessionStartLogged) {
        sessionStartLogged = true;
        logSessionStarted({ ...identity, tool: name, lang }, sessionMeta);
      }

      // Whether this client actually MOUNTS a widget decides what `message` asks
      // the model to do with the item — reproduce its contents, or not. The name
      // alone cannot answer it: `claude-code` passes the Claude whitelist and
      // mounts nothing, and for that client the summary is not a preview of the
      // product, it IS the product.
      const call = await withUpstreamTiming(() => handleToolCall(
        {
          auth,
          clientKind,
          declaresUi: declaresUiExtension(server),
          geoCountry: sessionMeta.geoCountry,
        },
        name,
        args as Record<string, unknown>
      ) as Promise<Record<string, unknown>>);
      upstream = call.timing;
      const result = call.result;

      // A handled generation error returns status:"failed" rather than throwing.
      const outcome: EventOutcome = result.status === "failed" ? "generation_failed" : "ok";
      logToolCall({
        ...identity,
        session: effectiveSession(auth, identity.session),
        tool: name,
        outcome,
        ms: Date.now() - start,
        lang,
        item: typeof result.item_id === "string" ? result.item_id : argItemId,
        // What the result actually SAID, not just that it didn't throw. A
        // render_item that polls out at 45s returns status:"generating" with no
        // item — a success by `outcome` and a wasted 45s to the user. See the
        // `status` field on ToolEvent.
        status: typeof result.status === "string" ? result.status : undefined,
        descLen,
        searchLen,
        domain,
        authMs,
        upstreamMs: upstream?.ms,
        upstreamCalls: upstream?.calls,
        procUptimeS: Math.round(process.uptime()),
        // How many languages the catalog actually offered back. A zero here on a
        // non-empty search is the signal the other two fields exist to find.
        results: Array.isArray(result.languages) ? result.languages.length : undefined,
        progress: progressToken !== undefined,
        err: outcome === "generation_failed" ? String(result.error ?? "") : undefined,
        meta: sessionMeta,
      });

      // Drop the _meta hydration payload (src/data/claim) for surfaces that render
      // no widget. Only the hydration key is stripped — auth-control _meta
      // (mcp/www_authenticate) still reaches every client.
      //
      // This gate is the CLIENT FAMILY, deliberately NOT shouldAdvertiseWidget().
      // In Claude Desktop the tool call and the app can run on DIFFERENT connections:
      // production logs show create_item/render_item arriving on the `claude-code`
      // connection while `claude-ai` fetches the app HTML seconds later. Keying this
      // on the executing connection's declared capability stripped the hydration the
      // sibling connection's app needed, and the app mounted with nothing to render —
      // it never even imported a language bundle. Hydration is small, hidden from the
      // model transcript, and harmless to a client that ignores it, so any
      // Claude-family client keeps it.
      // OpenAI is included for the same reason, from the other direction: ChatGPT's
      // component reads the payload off `window.openai.toolResponseMetadata` (falling
      // back to `toolOutput._meta`), so stripping hydration would hand it a mounted
      // widget with nothing to draw — the blank-panel failure, reintroduced.
      const clientName = server.getClientVersion()?.name;
      const stripHydration = !isWidgetHost(clientName) && !isOpenAIClient(clientName);
      return formatToolResult(result, { stripHydration });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (identity) {
        logToolCall({
          ...identity,
          session: authCtx ? effectiveSession(authCtx, identity.session) : identity.session,
          tool: name,
          outcome: "error",
          ms: Date.now() - start,
          lang,
          item: argItemId,
          descLen,
          searchLen,
          domain,
          authMs,
          upstreamMs: upstream?.ms,
          upstreamCalls: upstream?.calls,
          procUptimeS: Math.round(process.uptime()),
          progress: progressToken !== undefined,
          err: message,
          meta: sessionMeta,
        });
      }
      // Auth failure discovered mid-invocation: return the runtime MCP challenge so
      // the host (ChatGPT) prompts the user to re-link. `_meta["mcp/www_authenticate"]`
      // must survive to every client, so it is set here directly (never passed through
      // the widget-stripping formatToolResult path).
      if (error instanceof AuthChallengeError) {
        return {
          content: [
            {
              type: "text",
              text: "Your Graffiticode session has expired. Please reconnect your account to continue.",
            },
          ],
          isError: true,
          _meta: { "mcp/www_authenticate": [buildWwwAuthenticate(error.reason)] },
        };
      }
      // A Graffiticode free-plan refusal: name it as ours and say not to retry,
      // so it can't be mistaken for the host's own limit (see free-plan-limit.ts).
      if (error instanceof FreePlanLimitError) {
        return {
          content: [{ type: "text", text: buildFreePlanLimitText(error) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    } finally {
      clearInterval(heartbeat);
    }
  });

  // List available resources (the Claude MCP App widget, plus skills
  // discovered at request time from the public graffiticode-skills repo).
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Array<Record<string, unknown>> = [];
    // Advertise the widget resource ONLY to widget hosts (Claude). Non-widget hosts
    // (ChatGPT/OpenAI) get a UI-free surface — nothing for the submission "Scan Tools"
    // step to discover as linked UI.
    if (shouldAdvertiseWidget(server.getClientVersion()?.name, declaresUiExtension(server))) {
      const uris = widgetResourceUris();
      resources.push({
        uri: uris.mcp,
        name: "Graffiticode Form Widget",
        mimeType: CLAUDE_WIDGET_MIME_TYPE,
        description: "Interactive item widget for MCP Apps hosts such as Claude",
        _meta: widgetResourceMeta(),
      });
    }
    // Skills are best-effort: a GitHub outage must not break resource listing.
    try {
      resources.push(...(await listSkillResources()));
    } catch (err) {
      console.error(
        `[skills] list failed: ${(err as Error)?.message ?? err}`,
      );
    }
    return { resources };
  });

  // Advertise per-language user-guide resources as a URI template
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [userGuideResourceTemplate],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    const widgetKind = matchWidgetUri(uri);
    if (widgetKind === "mcp") {
      // Marks how far the host got: reading the app HTML is the step before the
      // sandbox mounts and imports the per-language bundle. If a failed render
      // logs this, the app was delivered and died in the sandbox; if it doesn't,
      // the host never asked for the app at all.
      console.log(
        `[widget] resources/read host=${server.getClientVersion()?.name ?? "?"} uri=${uri}`
      );
      return {
        contents: [
          {
            uri,
            mimeType: CLAUDE_WIDGET_MIME_TYPE,
            text: generateWidgetHtml(MCP_SERVER_URL),
            _meta: widgetResourceMeta(),
          },
        ],
      };
    }

    // Retired ChatGPT card pointers are intentionally not served. ChatGPT's
    // production contract has no widget; a reconnect/metadata refresh clears
    // stale pointers without reintroducing the broken template path.
    if (widgetKind === "openai") {
      throw new Error(`Resource retired: ${uri}`);
    }

    const skillId = matchSkillUri(uri);
    if (skillId) {
      return { contents: [await readSkillResource(uri, skillId)] };
    }

    const langId = matchUserGuideUri(uri);
    if (langId) {
      const auth = await authProvider.getAuth();
      const content = await readUserGuideResource({ auth, uri, langId });
      return { contents: [content] };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS headers. `mcp-protocol-version` is sent by spec-compliant clients
  // (2025-06-18+) on every request after initialize; omitting it from the
  // allow-list makes the preflight fail for browser-based clients (e.g. the MCP
  // Inspector connecting directly from localhost). `mcp-session-id` must also be
  // exposed so the browser client can read it off the initialize response —
  // otherwise the session id is invisible to JS and the next request 404s.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Free-Plan-Session, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Favicon
  if (url.pathname === "/favicon.ico") {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const faviconPath = join(__dirname, "..", "favicon.ico");
      const faviconData = readFileSync(faviconPath);
      res.writeHead(200, {
        "Content-Type": "image/x-icon",
        "Content-Length": faviconData.length.toString(),
        "Cache-Control": "public, max-age=86400",
      });
      res.end(faviconData);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // Per-language widget bundles. The widget loads these at render time to render
  // an item natively, instead of iframing the /form renderer. Served from our own
  // origin, which the widget resource declares in `_meta.ui.csp.resourceDomains`.
  //
  // These are ES modules, and module scripts are ALWAYS fetched in CORS mode (unlike
  // classic scripts) from an opaque, host-specific sandbox origin — so the
  // `Access-Control-Allow-Origin: *` set above is load-bearing, not incidental.
  const langBundle = url.pathname.match(/^\/widget\/lang\/([A-Za-z0-9]+)\.mjs$/);
  if (langBundle) {
    const langId = normalizeLanguageId(langBundle[1]);
    if (!isNativeLanguage(langId)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Unknown language bundle");
      return;
    }
    try {
      const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "widget", "lang", `${langId}.mjs`);
      const bundle = readFileSync(bundlePath);
      // Revalidate rather than cache immutably: the URL is stable across deploys,
      // so `immutable` would pin a stale component bundle after an `npm update` of
      // the language package. The ETag makes the repeat fetch a cheap 304.
      const etag = `"${createHash("sha256").update(bundle).digest("hex").slice(0, 16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": bundle.length.toString(),
        "Cache-Control": "public, max-age=0, must-revalidate",
        ETag: etag,
      });
      res.end(bundle);
    } catch (err) {
      console.error(`[widget] bundle read failed for ${langId}: ${(err as Error)?.message ?? err}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Bundle not built");
    }
    return;
  }

  // Widget beacon: the only way to see whether the component ran.
  //
  // A widget failing in a chat is invisible. The CSP declares no `connectDomains`
  // (deliberately — nothing else needs the network), so the page cannot report
  // home; nobody has a devtools console open in ChatGPT; and the host renders no
  // error of its own. On 2026-09-17 a freshly connected ChatGPT client read the
  // widget HTML and fetched L0180.mjs with a 200 and then painted NOTHING — and
  // there was no way to tell whether our script had run, thrown, or never
  // executed at all.
  //
  // A dynamic `import()` is the one outbound call the CSP already permits, which
  // is how the language bundles load. So the page imports this, and the access
  // log becomes the trace: `boot` says the script ran, `mounted` that a component
  // drew, `empty`/`error` that it did not and why.
  const beacon = url.pathname.match(/^\/widget\/beacon\/([a-z]+)\.mjs$/);
  if (beacon) {
    const stage = beacon[1];
    const lang = (url.searchParams.get("lang") || "-").slice(0, 8);
    const why = (url.searchParams.get("why") || "").slice(0, 200);
    console.log(`[widget] beacon stage=${stage} lang=${lang}${why ? ` why=${why}` : ""}`);
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    // Must parse as a module: a failed import would be swallowed by the caller's
    // catch and the beacon would look fine while reporting nothing.
    res.end("export default 1;\n");
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // robots.txt. Returned 404 to ~10 requests a week, and a 404 is ambiguous —
  // some directory crawlers read it as "unknown, back off". This host is an MCP
  // endpoint whose whole surface is public by design, and being indexed by
  // catalogue aggregators is distribution we want, so say so explicitly.
  //
  // The User-Agent note is the policy the edge actually enforces: a WAF rule
  // challenges a client impersonating another product's UA. Honest crawlers —
  // agent-tools.cloud, mcp-reputation-scanner and the rest — are untouched, and
  // it costs nothing to tell the next one where the line is.
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(ROBOTS_TXT);
    return;
  }

  // About
  if (url.pathname === "/about") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ABOUT_HTML);
    return;
  }

  // Privacy policy
  if (url.pathname === "/privacy") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PRIVACY_HTML);
    return;
  }

  // Terms of service
  if (url.pathname === "/terms") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TERMS_HTML);
    return;
  }

  // OpenAI app-directory domain-verification challenge. OpenAI fetches this from
  // the root of the registered MCP host (mcp.graffiticode.org; the /mcp path is
  // ignored). Inert (404) until OPENAI_APPS_CHALLENGE_TOKEN is set mid-submission.
  if (url.pathname === "/.well-known/openai-apps-challenge") {
    const { status, headers, body } = buildChallengeResponse(
      process.env.OPENAI_APPS_CHALLENGE_TOKEN,
    );
    res.writeHead(status, headers);
    res.end(body);
    return;
  }

  // OAuth 2.1 Endpoints

  // Protected Resource Metadata (RFC 9728). Serve both the bare well-known path
  // and the path-scoped variant: for a resource at `${host}/mcp`, RFC 9728 tells
  // clients to insert the well-known label before the resource path and request
  // `/.well-known/oauth-protected-resource/mcp`. Both return identical metadata.
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    handleProtectedResourceMetadata(req, res);
    return;
  }

  // Authorization Server Metadata (RFC 8414)
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    handleAuthServerMetadata(req, res);
    return;
  }

  // Machine-readable MCP discovery document (canonical endpoint + tool set).
  // Also served at the host root so `/` is a pointer to the canonical entry
  // (and a healthy 200 for health checks) rather than a bare 404.
  if (url.pathname === "/" || url.pathname === "/mcp.json" || url.pathname === "/.well-known/mcp.json") {
    handleMcpDiscovery(res);
    return;
  }

  // Dynamic Client Registration (RFC 7591)
  if (url.pathname === "/oauth/register" && req.method === "POST") {
    await handleClientRegistration(req, res);
    return;
  }

  // Authorization Endpoint
  if (url.pathname === "/oauth/authorize" && req.method === "GET") {
    await handleAuthorize(req, res);
    return;
  }

  // OAuth Callback (from consent page). POST is the real path — the consent page
  // submits the Google ID token in a form body so it never appears in a URL (query
  // strings land in CDN/Cloud Run access logs, browser history, and Referer headers).
  // GET is kept so a consent page deployed before that change still works; it logs a
  // warning and can be removed once the console rollout has landed.
  if (url.pathname === "/oauth/callback" && (req.method === "POST" || req.method === "GET")) {
    await handleCallback(req, res);
    return;
  }

  // Token Endpoint
  if (url.pathname === "/oauth/token" && req.method === "POST") {
    await handleToken(req, res);
    return;
  }

  // MCP endpoint (Streamable HTTP)
  if (url.pathname === "/mcp") {
    watchBadRequests(req, res);
    const bearerToken = extractBearerToken(req);

    // Transport-level per-request auth check. Validate an OAuth bearer BEFORE reusing
    // or creating a session so an expired/revoked token yields a 401 + WWW-Authenticate
    // challenge on every request — not a silently reused dead session. (API keys and
    // the no-bearer free-plan path skip this and are handled downstream.) A store
    // outage must not crash the request: on an unexpected error we skip the fast
    // 401 and let the per-invocation getAuth() surface a clean error instead.
    if (bearerToken && isOAuthAccessToken(bearerToken)) {
      let resolved: Awaited<ReturnType<typeof resolveOAuthAccessToken>> | null = null;
      try {
        resolved = await resolveOAuthAccessToken(bearerToken);
      } catch (err) {
        console.error(`[oauth] entry-level token check failed: ${(err as Error)?.message ?? err}`);
      }
      if (resolved && resolved.status === "invalid") {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": buildWwwAuthenticate(resolved.reason),
        });
        res.end(JSON.stringify({ error: "invalid_token", error_description: resolved.reason }));
        return;
      }
    }

    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session. Started before handleRequest
      // because a GET opens a long-lived stream the call doesn't return from until
      // the client disconnects; the helper no-ops until the stream actually exists.
      keepSseAlive(res);
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // A session id we do not hold: 404, as the MCP spec requires, so the client starts a new
    // session by itself. Sessions live in memory, so every deploy or restart forgets them all;
    // without this the request fell through to the SDK, which answered 400 "Server not
    // initialized", and Claude.ai read that as a dead connector and made the user reconnect by
    // hand. (`initialize` carries no session id, so it never lands here.)
    if (sessionId && req.method !== "DELETE") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      return;
    }

    // Handle DELETE for session termination
    if (req.method === "DELETE") {
      if (sessionId && transports.has(sessionId)) {
        transports.delete(sessionId);
        servers.delete(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "session terminated" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    // Build the auth provider:
    //   - bearer present  → resolve OAuth or pass api key through to console
    //   - bearer absent   → free-plan: forward calls with X-Free-Plan-Session
    //
    // We don't 401 invalid api keys here anymore; the console rejects them
    // (verifyToken fails, then getCredentialsForApiKey throws), and the
    // GraphQL error path surfaces a clean message.
    let authProvider: AuthProvider;
    if (bearerToken) {
      // Re-resolve on EVERY getAuth() (called per tool invocation) rather than
      // caching the resolved token at session start — so a mid-session OAuth expiry
      // or revocation is caught, not masked by a stale cached identity.
      authProvider = {
        async getAuth() {
          const resolved = await resolveBearer(bearerToken);
          if (resolved.kind === "oauth-invalid") {
            throw new AuthChallengeError(resolved.reason);
          }
          return {
            type: "firebase",
            token: resolved.token,
            source: resolved.kind === "oauth" ? "oauth" : "raw",
          };
        },
      };
    } else {
      // No bearer → free-plan. The auth provider reads the MCP session id
      // lazily from the transport, which sets it during the initialize POST.
      const transportRef: { current: StreamableHTTPServerTransport | null } = { current: null };
      // Signed workspace handle the console hands back once it knows which
      // workspace this caller is actually operating in. It supersedes the
      // transport session id from then on, so subsequent calls — including
      // create_item, which names no existing item — land in that workspace
      // instead of starting a fresh one. Lives as long as the transport does;
      // clients whose transport dies every call (ChatGPT) still get the
      // per-request adoption the console does on its own.
      let workspace: string | null = null;
      // Signed token for this transport session, minted once and reused. It is
      // what we present until (and unless) the console hands back a workspace
      // handle, so even the very first call of a session is attested rather than
      // a self-asserted uuid the console has to take on faith.
      let sessionToken: string | null = null;
      let sessionTokenFor: string | null = null;

      authProvider = {
        async getAuth() {
          const sid = transportRef.current?.sessionId;
          if (!sid) {
            throw new Error(
              "Free-plan session not yet initialized. Send an MCP `initialize` request first."
            );
          }
          if (!workspace && sessionTokenFor !== sid) {
            sessionToken = await mintSessionToken(sid);
            sessionTokenFor = sid;
          }
          return {
            type: "freePlan",
            // Precedence: the console's workspace handle wins over our own
            // session token, which wins over the bare uuid (the last only when
            // the salt is unconfigured — see mintSessionToken).
            sessionId: workspace ?? sessionToken ?? sid,
            onWorkspace: (token: string) => { workspace = token; },
          };
        },
      };
      // Stash the holder so we can populate it once the transport exists.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (authProvider as any).__transportRef = transportRef;
    }

    // Coarse geo from the Cloudflare edge (country/region only, never the IP).
    // Shared by reference with the per-session server so the tool handler can
    // backfill clientKind onto the same object after the initialize handshake.
    const sessionMeta: SessionMeta = geoFromHeaders(req.headers);

    // Set when the transport mints a session id, cleared when the matching
    // mcp_connect goes out. See the onmessage wrapper below for why the event
    // can't be emitted at the point the id is minted.
    let pendingConnectSession: string | null = null;

    // Create new transport and server for new session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        transports.set(newSessionId, transport);
        servers.set(newSessionId, server);
        pendingConnectSession = newSessionId;
      }
    });

    // For the free-plan auth provider we just built, point its closure
    // reference at the live transport so getAuth() can read sessionId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transportRef = (authProvider as any).__transportRef as
      | { current: StreamableHTTPServerTransport | null }
      | undefined;
    if (transportRef) {
      transportRef.current = transport;
    }

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        servers.delete(sid);
      }
    };

    const server = createMcpServer(authProvider, sessionMeta);
    await server.connect(transport);

    // Emit mcp_connect from the initialize MESSAGE, not from the transport's
    // onsessioninitialized hook.
    //
    // The transport awaits that hook BEFORE dispatching the initialize message
    // to the server, so at that point the handshake hasn't happened and
    // server.getClientVersion() is necessarily empty — which is why every
    // mcp_connect ever emitted carried no client_kind and probes (connects that
    // never became a tool call) were unattributable. The message itself is the
    // only place clientInfo exists this early: it arrives in the initialize
    // request params. Wrapping onmessage — set by server.connect() just above —
    // reads it there and keeps the event's population identical (one connect per
    // completed initialize POST, with the session id already minted).
    //
    // Stamping sessionMeta also means the rest of the session inherits the kind,
    // making the tool handler's backfill a no-op rather than the sole source.
    //
    // The same wrapper carries the rest of the session's funnel: `tools/list`
    // and `resources/read` are not tool calls, so they emitted nothing at all,
    // which left a connect that never converted indistinguishable from a
    // directory probe. Both stages live here rather than in the request
    // handlers because this transport instance is reused for every later POST
    // on the session (see the existing-session branch above), so one hook sees
    // every message.
    const forwardMessage = transport.onmessage;

    // Enumerations already reported, so a host that re-lists on every turn
    // counts as one catalog load rather than one per turn.
    const listed = new Set<string>();

    // The single identity expression for every event this transport emits.
    // Connect, list and read must agree on the session key or the report can't
    // join them back into one session.
    const identityFor = (sid: string) =>
      identify(
        bearerToken
          ? { type: "firebase", token: bearerToken }
          : { type: "freePlan", sessionId: sid }
      );

    transport.onmessage = (message, extra) => {
      // Instrumentation is best-effort and must never cost us a message.
      try {
        if (pendingConnectSession && isInitializeRequest(message)) {
          const sid = pendingConnectSession;
          pendingConnectSession = null;
          const kind = (message.params as { clientInfo?: { name?: unknown } } | undefined)
            ?.clientInfo?.name;
          if (typeof kind === "string" && kind && !sessionMeta.clientKind) {
            sessionMeta.clientKind = kind;
          }
          // Fix the transport's own key now, while the uuid is still what we
          // present. Free-plan tool calls later present the console's workspace
          // handle instead, moving `session` out from under the connect; `tns`
          // is what keeps the two joinable. Nothing to add for a bearer session,
          // whose key is the token hash and already stable.
          if (!bearerToken) sessionMeta.transportNamespace = deriveSessionNamespace(sid);
          logConnect(identityFor(sid), sessionMeta);
          // Whether a widget is offered is decided per session from what THIS initialize
          // declared — and a client that re-initializes after a 404 may reuse its cached tool
          // list and never call tools/list, which is the only other place this was logged.
          // Client-declared product metadata only, never user content.
          const caps = ((message.params as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ?? {});
          const ext = Object.keys((caps.extensions as Record<string, unknown> | undefined) ?? {});
          console.log(
            `[widget] initialize host=${typeof kind === "string" ? kind : "?"} declares_ui_extension=${ext.includes(EXTENSION_ID)}` +
              ` extensions=[${ext.join(",")}] caps=[${Object.keys(caps).join(",")}]`
          );
        } else {
          const method = (message as { method?: string }).method;
          const sid = transport.sessionId;
          if (method && sid) {
            const what = LIST_METHODS[method];
            if (what) {
              if (!listed.has(what)) {
                listed.add(what);
                logListed({ ...identityFor(sid), what }, sessionMeta);
              }
            } else if (method === "resources/read") {
              const uri = (message as { params?: { uri?: unknown } }).params?.uri;
              if (typeof uri === "string") {
                logResource({ ...identityFor(sid), uri }, sessionMeta);
              }
            }
          }
        }
      } catch {
        // ignore
      }
      forwardMessage?.(message, extra);
    };

    // Covers the initialize POST's stream too — cheap, and one rule for every
    // /mcp response rather than a GET-only special case.
    keepSseAlive(res);
    await transport.handleRequest(req, res);
    return;
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// handleRequest is async, so a rejection it doesn't catch becomes an unhandled
// rejection — which terminates the process under Node's default policy. Several
// routes await network calls (the OAuth store talks to the auth service), and a 403
// or an outage there was enough to take the instance down for every user: the
// service runs pinned at a single instance, so one bad callback is a full outage.
// Answer 500 and keep serving instead.
/**
 * Warm the catalog from inside a request, not at startup. Cloud Run allocates CPU only while
 * a request is in flight, so a fetch started at boot runs starved: on 2026-09-30 the startup
 * warm-up failed on every new instance (`warm failed after 26586ms`, its own 25s abort never
 * firing), and until listLanguages gained per-caller deadlines, every list_languages call
 * waited on it. Started here, the first request of an instance kicks it off with CPU behind
 * it. Re-armed while nothing is cached, so a failed warm-up is retried by a later request
 * rather than leaving every session's instructions without the catalog.
 */
let catalogWarming: Promise<void> | null = null;
function warmCatalogOnRequest(): void {
  if (catalogWarming || getCachedFullCatalog()) return;
  catalogWarming = warmCatalog({ type: "freePlan", sessionId: "request-warm" }).finally(() => {
    catalogWarming = null;
  });
}

const httpServer = createServer((req, res) => {
  warmCatalogOnRequest();
  handleRequest(req, res).catch((err) => {
    console.error(`[http] unhandled error for ${req.method} ${req.url}: ${(err as Error)?.stack ?? err}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  });
});

httpServer.listen(PORT, () => {
  // The catalog is warmed by the first request, not here — see warmCatalogOnRequest.
  console.log(`Graffiticode MCP Server (hosted) running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  MCP:     http://localhost:${PORT}/mcp`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`\nOAuth 2.1 Endpoints:`);
  console.log(`  Metadata:     http://localhost:${PORT}/.well-known/oauth-authorization-server`);
  console.log(`  Register:     http://localhost:${PORT}/oauth/register`);
  console.log(`  Authorize:    http://localhost:${PORT}/oauth/authorize`);
  console.log(`  Token:        http://localhost:${PORT}/oauth/token`);
  console.log(`\nAvailable tools:`);
  tools.forEach(tool => {
    console.log(`  - ${tool.name}`);
  });
  console.log(`\nFor Claude Desktop: Add via Settings > Connectors with URL:`);
  console.log(`  ${MCP_SERVER_URL}/mcp`);
  console.log(`\nFor API key auth (legacy):`);
  console.log(JSON.stringify({
    mcpServers: {
      "graffiticode": {
        url: `http://localhost:${PORT}/mcp`,
        headers: {
          Authorization: "Bearer <your-api-key>"
        }
      }
    }
  }, null, 2));
  console.log(`\nFor free-plan (no auth) access:`);
  console.log(JSON.stringify({
    mcpServers: {
      "graffiticode": {
        url: `http://localhost:${PORT}/mcp`
      }
    }
  }, null, 2));
});

# Privacy Policy

**Graffiticode MCP Server**
**Effective Date: July 13, 2026**

> This document is the source-of-truth twin of the `/privacy` page served by the
> MCP server (`PRIVACY_HTML` in `src/server.ts`). Change both together.

## Overview

The Graffiticode MCP Server ("the Service") is operated by Artcompiler. This policy describes how the Service collects, uses, and protects information when you connect to it through an MCP-compatible client such as Claude, ChatGPT, or another AI assistant.

## Information We Collect

### Authentication Credentials

The Service supports three ways to connect, and each handles credentials differently:

- **No credentials (free plan)** — you may connect without signing in. We do not collect any account identity. Your items are scoped to an anonymous session identifier (see _Free-plan sessions_ below).
- **API keys** — passed as a Bearer token and forwarded to the Graffiticode platform to authenticate the request. API keys are not written to our logs.
- **OAuth 2.1** — if you authorize through the OAuth flow, we store an OAuth record so your session can be refreshed without asking you to sign in repeatedly. **That record includes the email address of the Google account you authorized with, together with an access token and a refresh token.** It is persisted through the Graffiticode auth service, not merely held in memory.

### Content You Create

When you use the Service's content tools (`create_item`, `update_item`, `get_item`, `get_spec`), the natural language descriptions you provide and the items you create are sent to the Graffiticode platform and stored there. This includes:

- Natural language descriptions and modification requests
- Generated code and compiled output data
- Conversation history for iterative editing (stored per item)
- Item metadata (creation and update timestamps, language, name)

### Free-plan Sessions

If you connect without credentials, items you create are namespaced to the session identifier your MCP client established. The Service can mint a one-time _claim link_, valid for 24 hours, that lets you transfer those items into a real Graffiticode account the first time you sign in. The claim link contains a signed token derived from the session identifier — it carries no personal data. If you never claim them, free-plan items remain associated only with that anonymous session.

### Usage Analytics

The Service emits coarse, privacy-preserving analytics events to measure engagement (connections, catalog and documentation reads, tool usage, success rates). These events deliberately exclude personal data:

- Sessions and tokens appear only as **one-way hashes**, never in raw form.
- Your prompt text appears only as a **character count** — never the prompt itself.
- Location is recorded only as a **coarse country** (and, where available, region) derived at our CDN edge. **We do not record your IP address.**
- We record the **client kind** (the name your MCP client reports, e.g. "claude-ai"), which identifies software, not you.
- When your client lists our tools or opens one of our built-in documentation resources, we record that it did so. The only address recorded is one of our own `graffiticode://` resources; anything else your client requests is not written to our analytics.
- When you search our language catalog, we record the **length** of your search term and how many languages matched — never the search text itself. A domain filter is recorded only when it matches one we publish; anything else is recorded as `(invalid)`.
- We record the **lifecycle status** a call returned (`ready`, `generating`, `failed`) so we can tell a delivered item from one still being generated. It describes the state of your item, not its contents, and anything outside that published set is recorded as `(invalid)`.

One caveat, stated plainly: when a request fails we record a truncated backend error message so we can debug it. Error text is not intended to carry your content, but we cannot categorically rule out that a backend message quotes part of an input.

### Server Logs

The Service writes operational logs for debugging — request timestamps, error messages, and diagnostic warnings. Authorization headers are never logged. As noted above, the client IP address is not recorded in our analytics events.

## How We Use Your Information

- Authenticate your requests and authorize access to your items
- Generate, store, and retrieve content you create through the Service
- Maintain conversation history to support iterative editing of items
- Debug errors and maintain service reliability
- Understand aggregate usage so we can improve the Service

## Data Sharing

We do not sell your personal information. Data reaches the following parties in the course of running the Service:

- **Graffiticode platform** — the console and API receive the content you create and the requests you make. This is where code generation happens and where your items live.
- **Google Cloud Platform** — hosts the Service (Cloud Run) and receives its operational and analytics logs (Cloud Logging).
- **Firebase Authentication (Google)** — processes authentication tokens. See Google's privacy policy for details.
- **Cloudflare** — sits in front of the Service as our CDN and edge network, and necessarily handles your connection. Cloudflare is also the source of the coarse country/region signal described above.
- **GitHub** — the Service fetches its public agent-skill catalog from a public GitHub repository at request time. **No user data is sent to GitHub**; GitHub sees only the Service's own outbound requests.
- **Legal requirements** — we may disclose information if required by law or legal process.

## Data Retention

- **Items and content** — retained as long as your Graffiticode account is active, or until you delete them.
- **OAuth records** — the stored email, access token, and refresh token persist until the token is revoked or expires. Access tokens are valid for 55 minutes and are rotated on refresh.
- **API keys** — not stored by the Service; forwarded per request and discarded.
- **Free-plan claim tokens** — valid for 24 hours, after which the link expires.
- **Server logs** — retained for up to 90 days for debugging purposes.

## Security

- HTTPS/TLS encryption for all data in transit
- OAuth 2.1 with PKCE (S256) for secure authentication flows
- Short-lived tokens with automatic refresh and rotation
- Long-lived API keys are exchanged for short-lived tokens rather than being embedded in render URLs
- Deployment on Google Cloud Run with managed infrastructure security

## Your Rights

You may:

- Request access to or deletion of your data by contacting us
- Delete items you've created through the Graffiticode console at [console.graffiticode.org](https://console.graffiticode.org)
- Revoke API keys at any time through your Graffiticode account settings
- Disconnect the Service from your MCP client at any time, which stops all further data flow

## Changes to This Policy

We may update this policy from time to time. Changes will be posted to this document with an updated effective date.

## Contact

For questions about this privacy policy or your data, contact:

- Email: support@graffiticode.org
- GitHub: [github.com/graffiticode/graffiticode-mcp-server](https://github.com/graffiticode/graffiticode-mcp-server)

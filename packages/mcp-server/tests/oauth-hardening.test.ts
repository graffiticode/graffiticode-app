import assert from "node:assert/strict";
import test from "node:test";
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  isOAuthAccessToken,
  buildWwwAuthenticate,
  redirectUrisError,
  evaluateTokenValidity,
  accessTokenExpiry,
} from "../src/oauth/handlers.js";

const RESOURCE = "https://mcp.graffiticode.org/mcp";
const NOW = 1_000_000_000_000;

test("OAuth access tokens are distinguishable from raw API keys", () => {
  assert.equal(isOAuthAccessToken(`${OAUTH_ACCESS_TOKEN_PREFIX}abc`), true);
  // A raw Graffiticode API key must NOT be mistaken for an OAuth token.
  assert.equal(isOAuthAccessToken("gc_live_deadbeef"), false);
  assert.equal(isOAuthAccessToken("random-bearer"), false);
  // Refresh-token prefix is not an access-token prefix.
  assert.equal(isOAuthAccessToken(`${OAUTH_REFRESH_TOKEN_PREFIX}abc`), false);
});

test("WWW-Authenticate challenge points at protected-resource metadata with invalid_token", () => {
  const header = buildWwwAuthenticate("expired");
  assert.match(header, /^Bearer /);
  assert.match(header, /resource_metadata="https:\/\/mcp\.graffiticode\.org\/\.well-known\/oauth-protected-resource"/);
  assert.match(header, /error="invalid_token"/);
  assert.match(header, /expired/i);
});

test("redirectUrisError rejects empty/missing and non-https, accepts valid https", () => {
  assert.match(redirectUrisError(undefined) ?? "", /non-empty/);
  assert.match(redirectUrisError([]) ?? "", /non-empty/);
  assert.match(redirectUrisError(["not a url"]) ?? "", /Invalid redirect_uri/);
  assert.match(redirectUrisError(["http://evil.example/cb"]) ?? "", /must be https/);
  // ChatGPT's connector callback shape is accepted.
  assert.equal(redirectUrisError(["https://chatgpt.com/connector/oauth/abc123"]), null);
  // localhost tolerated for local dev.
  assert.equal(redirectUrisError(["http://localhost:8080/cb"]), null);
});

test("a freshly issued token is valid even though the store drops access_token_expires_at", () => {
  // Regression: the auth service persists an allowlist of fields that excludes
  // access_token_expires_at, and mapTokenResponse doesn't read it back — so every
  // entry loaded from the store has it undefined. A strict numeric check rejected
  // EVERY OAuth token as expired on first use: the client 401'd, refreshed, 401'd
  // again, and silently fell back to an anonymous free-plan session.
  const justIssued = { resource: RESOURCE, scope: "graffiticode", created_at: NOW - 1_000 };
  assert.equal(evaluateTokenValidity(justIssued, RESOURCE, NOW), null);

  // The derived lifetime is the same 55 minutes advertised as expires_in.
  assert.equal(accessTokenExpiry(justIssued), justIssued.created_at + 55 * 60 * 1000);
  assert.equal(evaluateTokenValidity(justIssued, RESOURCE, NOW + 54 * 60_000), null);
  assert.equal(evaluateTokenValidity(justIssued, RESOURCE, NOW + 56 * 60_000), "expired");

  // An explicit expiry still wins when present (e.g. once the auth service stores it).
  assert.equal(accessTokenExpiry({ access_token_expires_at: 42, created_at: NOW }), 42);
});

test("evaluateTokenValidity enforces expiry, audience, and scope", () => {
  const valid = {
    access_token_expires_at: NOW + 60_000,
    resource: RESOURCE,
    scope: "graffiticode",
    created_at: NOW,
  };
  assert.equal(evaluateTokenValidity(valid, RESOURCE, NOW), null);

  // Expired access token.
  assert.equal(
    evaluateTokenValidity({ ...valid, access_token_expires_at: NOW - 1 }, RESOURCE, NOW),
    "expired",
  );
  // Pre-hardening entry: no explicit expiry AND created long ago — still forced to
  // relink, which was the original intent of the strict check.
  assert.equal(
    evaluateTokenValidity(
      { ...valid, access_token_expires_at: undefined, created_at: NOW - 24 * 60 * 60_000 },
      RESOURCE,
      NOW,
    ),
    "expired",
  );
  // Neither field usable: nothing to trust, treat as expired.
  assert.equal(
    evaluateTokenValidity(
      { ...valid, access_token_expires_at: undefined, created_at: undefined as unknown as number },
      RESOURCE,
      NOW,
    ),
    "expired",
  );
  // Wrong audience.
  assert.equal(
    evaluateTokenValidity({ ...valid, resource: "https://evil.example/mcp" }, RESOURCE, NOW),
    "resource",
  );
  // Missing required scope.
  assert.equal(
    evaluateTokenValidity({ ...valid, scope: "" }, RESOURCE, NOW),
    "scope",
  );
});

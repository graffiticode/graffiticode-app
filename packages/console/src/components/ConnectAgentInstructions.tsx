import Link from "next/link";
import React from "react";
import CopyButton from "./CopyButton";

/**
 * "Connect your agent to this account" — shown once a trial user has claimed.
 *
 * They are already connected; what's missing is that the connection is anonymous,
 * so everything they make next lands back in a trial workspace with another claim
 * link. What it takes to fix that depends entirely on the host, which is why this
 * is keyed by host rather than being one set of instructions.
 *
 * The `host` values mirror `classifyClientHost` in the MCP server
 * (graffiticode-mcp-server/src/tools.ts) and arrive on the claim link as `client=`.
 * The MCP server owns the taxonomy — the two repos can't import from each other, so
 * adding a bucket means adding it there first. An unrecognized value is treated as
 * "unknown", which renders the generic instructions plus the host picker.
 */
export type ClientHost = "claude-code" | "claude-app" | "openai" | "editor" | "unknown";

const HOSTS: ClientHost[] = ["claude-code", "editor", "claude-app", "openai", "unknown"];

export const HOST_LABELS: Record<ClientHost, string> = {
  "claude-code": "Claude Code",
  editor: "Cursor / VS Code",
  "claude-app": "Claude desktop or web",
  openai: "ChatGPT / Codex",
  unknown: "Another agent",
};

export function parseClientHost(value: unknown): ClientHost {
  return typeof value === "string" && (HOSTS as string[]).includes(value)
    ? (value as ClientHost)
    : "unknown";
}

// Hosts whose config file takes an Authorization header. These are the ones an API
// key is any use to; claude.ai and ChatGPT connector UIs have no header field, so
// offering them a key would be offering something they cannot paste anywhere.
export function hostTakesApiKey(host: ClientHost): boolean {
  return host === "claude-code" || host === "editor" || host === "unknown";
}

const MCP_ENDPOINT =
  process.env.NEXT_PUBLIC_MCP_ENDPOINT || "https://mcp.graffiticode.org/mcp";

const KEY_PLACEHOLDER = "<your-api-key>";

function claudeCodeCommand(key: string): string {
  return [
    "claude mcp add --transport http graffiticode",
    MCP_ENDPOINT,
    `--header "Authorization: Bearer ${key}"`,
  ].join(" ");
}

function editorConfig(key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        graffiticode: {
          url: MCP_ENDPOINT,
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 border border-gray-300 bg-gray-50 px-3 py-2 text-left">
      <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-800">
        {text}
      </pre>
      <CopyButton value={text} />
    </div>
  );
}

export default function ConnectAgentInstructions({
  host,
  onHostChange,
  apiKey,
  onCreateKey,
  creatingKey,
  keyError,
}: {
  host: ClientHost;
  onHostChange: (host: ClientHost) => void;
  apiKey?: { id: string; token: string } | null;
  onCreateKey: () => void;
  creatingKey: boolean;
  keyError?: string | null;
}) {
  const key = apiKey?.token || KEY_PLACEHOLDER;
  const needsKey = hostTakesApiKey(host);

  return (
    <div className="w-full text-left">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Connect your agent</h2>
      <p className="text-sm text-gray-600 mb-3">
        Your agent is still working anonymously — anything it makes next won&rsquo;t land in this
        account until you connect it.
      </p>

      {needsKey && (
        <>
          {apiKey ? (
            <p className="text-xs text-gray-500 mb-2">
              Your new key is in the snippet below. It is shown only once — copy it somewhere safe.
            </p>
          ) : (
            <div className="mb-3">
              <button
                type="button"
                className="rounded-none border border-gray-900 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
                onClick={onCreateKey}
                disabled={creatingKey}
              >
                {creatingKey ? "Creating key…" : "Create an API key"}
              </button>
              {keyError && <p className="text-xs text-red-700 mt-2">{keyError}</p>}
            </div>
          )}
        </>
      )}

      {host === "claude-code" && (
        <>
          <p className="text-sm text-gray-600 mb-2">Run this in your terminal:</p>
          <Snippet text={claudeCodeCommand(key)} />
        </>
      )}

      {(host === "editor" || host === "unknown") && (
        <>
          <p className="text-sm text-gray-600 mb-2">
            {host === "editor"
              ? "Add the header to the graffiticode entry in your MCP config:"
              : "Most agents take a remote MCP server in a config file like this:"}
          </p>
          <Snippet text={editorConfig(key)} />
        </>
      )}

      {(host === "claude-app" || host === "openai") && (
        // No header field in either connector UI, and /oauth/consent is Google-only
        // today, so there is genuinely nothing this user can paste. Say that plainly
        // rather than inventing a step — and give them the option that does work.
        <div className="border border-gray-300 px-3 py-2 text-sm text-gray-600">
          <p className="mb-2">
            {HOST_LABELS[host]} connectors don&rsquo;t take an API key yet, so new items there will
            keep starting out anonymous — save each one with the link your assistant prints.
          </p>
          <p>
            To have items save automatically today, connect from Claude Code, Cursor, or VS Code with
            an API key from{" "}
            <Link className="underline" href="/settings">
              Settings
            </Link>
            .
          </p>
        </div>
      )}

      <div className="mt-3 text-xs text-gray-500">
        Using something else?{" "}
        <select
          className="border border-gray-300 bg-white px-1 py-0.5 text-xs"
          value={host}
          onChange={(e) => onHostChange(parseClientHost(e.target.value))}
        >
          {HOSTS.map((h) => (
            <option key={h} value={h}>
              {HOST_LABELS[h]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Convert an internal handler result into an MCP CallToolResult.
 *
 * `summary` becomes chat-facing text AND stays in structuredContent; `_meta`
 * remains widget-only and is never copied into either. Keeping this seam pure
 * makes the privacy and response-shape contract easy to test without starting the
 * HTTP server.
 *
 * The summary used to be moved OUT of structuredContent, on the reasoning that a
 * field rendered as text need not also be a field. That assumed every client shows
 * the text block. Claude Code and Cowork do not: given a tool with an
 * `outputSchema`, they surface `structuredContent` and drop `content[0].text`,
 * which is a reading the spec invites — it says a structured result SHOULD mirror
 * itself in the text block, and ours carried something else entirely. So the item's
 * content and its markdown link, both of which live only in the summary, reached
 * those models not at all: what arrived was four identity fields and a bare
 * `view_url`, and the answer the user got was "I made a thing" with nothing to
 * click. Duplicating a few hundred bytes is the cheap side of that trade.
 *
 * `stripHydration` drops ONLY the widget-hydration payload from `_meta` — the
 * `graffiticode` key (src, compiled data, claim fields), which is useless to a host
 * that renders no widget. It is passed for OpenAI/ChatGPT clients so that payload
 * never leaves the server for a surface that can't use it (data minimization — the
 * model transcript is already compact either way, since `_meta` is host-facing).
 *
 * Crucially it does NOT strip authorization-control metadata: an
 * `_meta["mcp/www_authenticate"]` challenge must reach every client (it is what
 * prompts ChatGPT to re-link the account), so only the hydration key is removed.
 */

// _meta keys that carry widget hydration and must be withheld from non-widget hosts.
const HYDRATION_META_KEYS = new Set(["graffiticode"]);

export function formatToolResult(
  result: Record<string, unknown>,
  opts: { stripHydration?: boolean } = {},
): Record<string, unknown> {
  const { _meta, ...structuredContent } = result;
  const { summary } = result;
  const response: Record<string, unknown> = {
    structuredContent,
    content: [
      {
        type: "text",
        text:
          typeof summary === "string"
            ? summary
            : JSON.stringify(structuredContent, null, 2),
      },
    ],
  };

  if (_meta !== undefined) {
    const meta = opts.stripHydration
      ? Object.fromEntries(
          Object.entries(_meta as Record<string, unknown>).filter(
            ([k]) => !HYDRATION_META_KEYS.has(k),
          ),
        )
      : (_meta as Record<string, unknown>);
    // Only attach _meta if something survived (an all-hydration _meta becomes empty
    // for non-widget hosts — omit it rather than ship `{}`).
    if (Object.keys(meta).length > 0) response._meta = meta;
  }

  return response;
}

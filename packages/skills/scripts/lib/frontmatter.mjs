// Shared SKILL.md frontmatter reader and the caps that bound it.
//
// Extracted so the validator and the packager read a skill exactly the same
// way. They must not drift: validate is the gate that says "safe to ship", and
// a packager that parsed differently could zip up something the gate would have
// rejected — which is the one failure this whole seam exists to prevent.
//
// Parsing is spec-compliant YAML via js-yaml, deliberately STRICTER than the
// MCP server's own lenient reader. See the header of validate-skills.mjs for
// why the strictest consumer sets the bar.

import yaml from "js-yaml";

// Claude Code caps SKILL.md frontmatter. Skills here are consumed both by the
// MCP server and by a local install into ~/.claude/skills/, so the stricter
// consumer sets the budget. WARN sits below MAX because the description is where
// capability advertising accumulates — you want to know you are near the ceiling
// while adding the capability, not after it silently truncates.
export const NAME_MAX = 64;
export const DESC_MAX = 1024;
export const DESC_WARN = 900;

/**
 * Parse a SKILL.md into its frontmatter mapping and body.
 *
 * Returns `{ ok: false, error }` rather than throwing, because both callers
 * collect every problem before exiting — a parse failure is one finding among
 * several, not a reason to abandon the run.
 *
 * @param {string} raw  the file's full text
 * @returns {{ok: true, fm: object, body: string} | {ok: false, error: string}}
 */
export function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) {
    return { ok: false, error: "does not begin with a `---` frontmatter delimiter" };
  }
  const end = raw.indexOf("\n---\n", 3);
  if (end === -1) {
    return { ok: false, error: "frontmatter is not closed by a `---` line" };
  }

  let fm;
  try {
    fm = yaml.load(raw.slice(4, end + 1));
  } catch (e) {
    // The whole reason this script exists.
    return {
      ok: false,
      error: `frontmatter is not valid YAML — the server would drop this skill from resources/list: ${e.message.split("\n")[0]}`,
    };
  }
  if (fm === null || typeof fm !== "object") {
    return { ok: false, error: "frontmatter did not parse to a mapping" };
  }

  return { ok: true, fm, body: raw.slice(end + 5) };
}

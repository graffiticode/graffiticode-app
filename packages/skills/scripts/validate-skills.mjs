#!/usr/bin/env node
// Pre-deploy validation. A push to the default branch is a live deploy, so this
// is the only gate between an edit and every connected MCP client.
//
// It parses frontmatter with a spec-compliant YAML parser, which is deliberately
// STRICTER than the MCP server's own frontmatter reader — the server is lenient
// and will happily serve, say, a bare `key: value` colon inside an unquoted
// description that real YAML rejects. These skills are also installed straight
// into ~/.claude/skills/, and that path does use a real YAML parser. The
// strictest consumer sets the bar, so a skill that only survives the lenient one
// is a bug that hides on the MCP path and surfaces on the install path.
//
// Run: npm run validate

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Shared with the packager so the gate and the artifact read a skill the same
// way — see the header of lib/frontmatter.mjs.
import { parseFrontmatter, NAME_MAX, DESC_MAX, DESC_WARN } from "./lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const errors = [];
const warnings = [];
const err = (skill, msg) => errors.push(`${skill}: ${msg}`);
const warn = (skill, msg) => warnings.push(`${skill}: ${msg}`);

const dirs = readdirSync(ROOT)
  .filter((d) => !d.startsWith(".") && statSync(join(ROOT, d)).isDirectory())
  // `dist` is build output, not a skill. It is gitignored, so the MCP server
  // (which reads the repo over the GitHub API) never sees it — but this script
  // reads the filesystem, where a local `npm run package` leaves it behind.
  .filter((d) => d !== "scripts" && d !== "node_modules" && d !== "dist")
  .sort();

const skills = dirs.map((id) => {
  const served = existsSync(join(ROOT, id, "SKILL.md"));
  const draft = existsSync(join(ROOT, id, "SKILL.md.draft"));
  return { id, served, draft, path: join(ROOT, id, served ? "SKILL.md" : "SKILL.md.draft") };
});

const servedIds = new Set(skills.filter((s) => s.served).map((s) => s.id));
const allIds = new Set(skills.map((s) => s.id));

for (const skill of skills) {
  const { id, served, draft } = skill;

  if (!served && !draft) {
    err(id, "directory contains neither SKILL.md nor SKILL.md.draft");
    continue;
  }

  const raw = readFileSync(skill.path, "utf8");

  // --- frontmatter ---------------------------------------------------------
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    err(id, parsed.error);
    continue;
  }
  const { fm, body } = parsed;

  // --- name ----------------------------------------------------------------
  const name = fm.name;
  if (typeof name !== "string" || name.trim() === "") {
    err(id, "frontmatter is missing a non-empty `name`");
  } else {
    if (name !== id) {
      // The directory name is the skill id and the resource URI. A mismatch
      // advertises the skill under a name that does not address it.
      err(id, `frontmatter name "${name}" does not match its directory — the directory name is the skill id and the resource URI`);
    }
    if (name.length > NAME_MAX) err(id, `name is ${name.length} chars, over the ${NAME_MAX} cap`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) err(id, `name "${name}" is not lowercase-kebab-case`);
  }

  // --- description ---------------------------------------------------------
  const desc = fm.description;
  if (typeof desc !== "string" || desc.trim() === "") {
    err(id, "frontmatter is missing a non-empty `description` — this is the routing surface; without it agents cannot decide to fire the skill");
  } else {
    const n = desc.length;
    if (n > DESC_MAX) {
      err(id, `description is ${n} chars, over the ${DESC_MAX} cap`);
    } else if (n >= DESC_WARN) {
      warn(id, `description is ${n}/${DESC_MAX} chars — only ${DESC_MAX - n} left. The next capability added here will not fit; tighten it in the same change.`);
    }
  }

  // --- body ----------------------------------------------------------------
  if (body.trim() === "") err(id, "has frontmatter but no body");

  // Enforces the repo's own invariant: capabilities are named as jobs in the
  // user's or vendor's vocabulary, never by Graffiticode language ID, which the
  // catalog is free to renumber or deprecate underneath us.
  const ids = [...new Set((body.match(/\bL0\d{3}\b/g) ?? []))];
  if (ids.length) {
    const msg = `hardcodes language ID(s) ${ids.join(", ")} — describe the capability as a job and route on the language's own description/when_to_use`;
    served ? err(id, msg) : warn(id, `${msg} (fix before promoting this draft)`);
  }

  // --- cross-skill references ----------------------------------------------
  // Dangling refs have bitten this repo before (see commit 042c666). The subtle
  // case is a reference to a directory that exists but is held as a draft: it is
  // dangling to every client, because the server skips a dir with no SKILL.md.
  const backticked = new Set([...body.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]));
  for (const ref of backticked) {
    if (ref === id || !allIds.has(ref)) continue;
    if (!servedIds.has(ref)) {
      err(id, `references \`${ref}\`, which is not served (held as a draft) — the reference is dangling for every client`);
    }
  }
  for (const m of body.matchAll(/`([a-z0-9][a-z0-9-]*)`\s+skill\b/g)) {
    const ref = m[1];
    if (ref !== id && !allIds.has(ref)) {
      err(id, `references a \`${ref}\` skill, which does not exist in this repo`);
    }
  }

  // --- house style ---------------------------------------------------------
  if (!/^## Guardrails\s*$/m.test(body)) {
    warn(id, "has no `## Guardrails` section — every skill here ends with one, and it is where the hard negatives live");
  }
}

// --- README stays in sync ---------------------------------------------------
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
for (const { id } of skills) {
  if (!new RegExp("^\\|\\s*`" + id + "`\\s*\\|", "m").test(readme)) {
    err("README.md", `has no table row for \`${id}\``);
  }
}
for (const m of readme.matchAll(/^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|/gm)) {
  if (!allIds.has(m[1])) err("README.md", `lists \`${m[1]}\`, which is not a directory in this repo`);
}

// --- report -----------------------------------------------------------------
const served = skills.filter((s) => s.served);
const held = skills.filter((s) => !s.served);
console.log(`\nChecked ${served.length} served skill(s): ${served.map((s) => s.id).join(", ")}`);
if (held.length) console.log(`Held, not served: ${held.map((s) => s.id).join(", ")}`);

for (const w of warnings) console.log(`\n  warn  ${w}`);
for (const e of errors) console.log(`\n  FAIL  ${e}`);

if (errors.length) {
  console.log(`\n${errors.length} error(s). Not safe to push — main is a live deploy.\n`);
  process.exit(1);
}
console.log(`\nOK${warnings.length ? ` (${warnings.length} warning(s))` : ""}\n`);

#!/usr/bin/env node
// Package this repo's served skills as an OpenAI plugin ZIP.
//
// The submission runbook has always said "the exact file tree matches what was
// tested locally" and has never been able to prove it: every ZIP uploaded to the
// portal so far was assembled by hand and not kept. This script makes the
// artifact a pure function of one commit, so its SHA-256 answers the question.
//
// The shipped tree matches this repo's tree: skills at the top level. The MCP
// server discovers them there at request time over the GitHub API, and OpenAI's
// portal expects the same structure (each skill as a root-level directory
// containing SKILL.md).
//
// Run: npm run package [-- --flags]

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { writeZip } from "./lib/zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Documented OpenAI submission limits. Every one of these has an error message
// naming the field, the actual value and the limit — an unactionable rejection
// at the portal costs a review cycle.
const LIMITS = {
  name: 64,
  version: 64,
  description: 1024,
  authorName: 120,
  displayName: 30,
  shortDescription: 30,
  longDescription: 4000,
  defaultPrompts: 3,
  defaultPromptChars: 128,
  entries: 5000,
  compressedBytes: 100 * 1000 * 1000,
  uncompressedBytes: 512 * 1024 * 1024,
  pathSegments: 20,
};

// The portal rejects an unlisted category, and the error is unfixable without
// knowing the allowed set — so we print it.
const CATEGORIES = [
  "Productivity",
  "Education",
  "Developer Tools",
  "Business",
  "Creative",
  "Lifestyle",
  "Research",
];

// semver.org's official regex. A hand-rolled \d+\.\d+\.\d+ accepts "v1.0.0" and
// "1.0", both of which a strict validator rejects — and the v-prefix is exactly
// the mistake someone makes coming from git tags.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ref: "origin/main",
    fetch: true,
    out: null,
    version: null,
    schema: "portable",
    dryRun: false,
    keepStaging: false,
    dev: false,
    noApp: false,
    skillsOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--ref": opts.ref = next(); break;
      case "--no-fetch": opts.fetch = false; break;
      case "--out": opts.out = next(); break;
      case "--version": opts.version = next(); break;
      case "--schema": opts.schema = next(); break;
      case "--dev": opts.dev = true; break;
      case "--no-app": opts.noApp = true; break;
      case "--skills-only": opts.skillsOnly = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--keep-staging": opts.keepStaging = true; break;
      case "-h":
      case "--help": help(); process.exit(0); break;
      default: usage(`unknown flag: ${a}`);
    }
  }
  if (opts.schema !== "native" && opts.schema !== "portable") {
    usage(`--schema must be "native" or "portable", got "${opts.schema}"`);
  }
  return opts;
}

function help() {
  console.log(`graffiticode plugin packager

  npm run package -- [flags]

  --ref <ref>      git ref to build from            (default: origin/main)
  --no-fetch       skip \`git fetch origin\`          (default: fetch)
  --out <path>     output path override
  --version <sv>   override the version from the ref
  --schema <s>     portable | native                (default: portable)
  --dev            build as <name>-v2, a sibling identity for workspace testing
  --no-app         omit .app.json, so the client talks to mcp.json directly
  --skills-only    output only skill directories (for OpenAI portal skills upload)
  --dry-run        build and hash, write nothing
  --keep-staging   leave the temp dir and print its path
  -h, --help

exit: 0 ok · 1 validation/limit failure · 2 usage · 3 environment`);
}

function usage(msg) {
  console.error(`usage error: ${msg}`);
  console.error(`run with --help for the flag list`);
  process.exit(2);
}

function envFail(msg) {
  console.error(`environment error: ${msg}`);
  process.exit(3);
}

// --- git ---------------------------------------------------------------------

const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

const gitBuffer = (args) =>
  execFileSync("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

/**
 * Resolve a ref to a full SHA. Everything downstream uses the SHA, never the
 * symbolic name — otherwise a push landing mid-build could change the inputs
 * between two reads and produce an archive matching no single commit.
 */
function resolveRef(ref, doFetch) {
  try {
    git(["--version"]);
  } catch {
    envFail("git is not on PATH");
  }
  let fetched = false;
  if (doFetch) {
    try {
      git(["fetch", "--quiet", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
      fetched = true;
    } catch (e) {
      envFail(`git fetch origin failed: ${String(e.stderr || e.message).trim()}\n  (use --no-fetch to build from the local ref)`);
    }
  }
  let sha;
  try {
    sha = git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  } catch {
    envFail(`cannot resolve ref "${ref}" to a commit`);
  }
  return { sha, fetched };
}

function readBlob(sha, path) {
  try {
    // stderr is swallowed on purpose: a missing blob is a case this script
    // reports itself, and git's own "exists on disk, but not in <sha>" line
    // printed above our message reads like a second, unrelated failure.
    return execFileSync("git", ["cat-file", "blob", `${sha}:${path}`], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// --- the validation gate -----------------------------------------------------

/**
 * Run the REF'S OWN validator against an extraction of that ref.
 *
 * Deliberately a subprocess rather than an import: the validator's 19 checks are
 * about repo correctness (README sync, dangling cross-skill refs, L0xxx leakage)
 * and the packager needs exactly one bit out of them — may I ship. Importing
 * them piecemeal is how the two code paths drift until validate passes and the
 * ZIP carries something it would have rejected. Running the ref's copy also
 * means rebuilding an old ref applies the rules that shipped with it.
 */
function validateRef(sha, keepStaging) {
  const staging = mkdtempSync(join(tmpdir(), "gc-plugin-validate-"));
  const repo = join(staging, "repo");
  mkdirSync(repo);

  const archive = gitBuffer(["archive", sha]);
  spawnSync("tar", ["-x", "-C", repo], { input: archive });

  // The validator imports js-yaml, and Node's ESM resolver walks up from the
  // IMPORTING file — so an extracted copy would never find this repo's
  // node_modules. Without the symlink you get an opaque ERR_MODULE_NOT_FOUND
  // that reads like a broken build rather than a missing link.
  const realModules = join(ROOT, "node_modules");
  if (!existsSync(join(realModules, "js-yaml"))) {
    envFail("node_modules/js-yaml is missing — run `npm ci` first");
  }
  symlinkSync(realModules, join(repo, "node_modules"), "dir");

  const script = join(repo, "scripts", "validate-skills.mjs");
  if (!existsSync(script)) {
    envFail(`ref ${sha.slice(0, 10)} has no scripts/validate-skills.mjs to validate with`);
  }
  const res = spawnSync(process.execPath, [script], { stdio: "inherit" });

  if (!keepStaging) rmSync(staging, { recursive: true, force: true });
  else console.log(`  staging kept: ${staging}`);

  return res.status === 0;
}

// --- discovery ---------------------------------------------------------------

/**
 * The served skills of a ref: every top-level directory holding a SKILL.md.
 *
 * This is definitional, not a denylist. scripts/, README.md, CLAUDE.md,
 * package.json and .github/ are excluded because they do not match the shape,
 * and `forms` is excluded because its file is SKILL.md.draft — the same held-not-
 * served mechanism the MCP server uses, so promoting it with `git mv` ships it
 * automatically and no list here needs editing.
 */
function discoverSkills(sha) {
  const files = git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
  const served = [];
  const held = [];
  for (const f of files) {
    const m = /^([^/]+)\/SKILL\.md$/.exec(f);
    if (m) {
      // OpenAI's skill discovery ignores dot-prefixed directories, so shipping
      // one would be a silently dead entry rather than a skill.
      if (!m[1].startsWith(".")) served.push(m[1]);
      continue;
    }
    const d = /^([^/]+)\/SKILL\.md\.draft$/.exec(f);
    if (d) held.push(d[1]);
  }
  return { served: served.sort(), held: held.sort() };
}

// --- manifest ----------------------------------------------------------------

/**
 * Build under a sibling identity that cannot shadow the published plugin.
 *
 * A test build and the public listing both answer to "Graffiticode", and the
 * handle resolves to whichever the client prefers — observed 2026-09-17, where
 * the published v1 shadowed a workspace install that had already been disabled
 * (disabling is not uninstalling, and an admin-policy install cannot be removed
 * by a member at all). Nothing inside the package breaks that tie; only a
 * different name does.
 *
 * `-v2` rather than `-dev`: the collision is with v1 specifically, and the build
 * being installed beside it IS version 2. It stays a separate identity from the
 * submission, which ships as plain `graffiticode` — a version number belongs in
 * the version field, not in the name a listing carries forever.
 */
function altIdentity(meta) {
  return {
    ...meta,
    name: `${meta.name}-v2`,
    interface: { ...meta.interface, displayName: `${meta.interface.displayName}-v2` },
  };
}

function buildPluginObject(meta, version) {
  // The top-level description is DERIVED from longDescription rather than stored
  // twice: one string cannot drift from itself. If longDescription ever exceeds
  // the 1024 description cap, the limit check below is the signal to add an
  // explicit override rather than silently truncate.
  return {
    name: meta.name,
    version,
    description: meta.interface?.longDescription,
    author: meta.author,
    interface: meta.interface,
    mcpServers: meta.mcpServers,
    apps: meta.apps,
  };
}

function serializeNative(o) {
  const out = { name: o.name, version: o.version, description: o.description, author: o.author, interface: o.interface };
  // A path, not an inline object: the file is also what a host that discovers
  // mcp.json by convention will find.
  if (o.mcpServers) out.mcpServers = "./mcp.json";
  if (o.apps) out.apps = "./.app.json";
  return out;
}

function serializePortable(o) {
  // The portable schema is `additionalProperties: false`, so everything
  // OpenAI-specific lives under the extension key — including the server
  // reference. The mcp.json file ships either way, for convention discovery.
  const openai = { interface: o.interface };
  if (o.mcpServers) openai.mcpServers = "./mcp.json";
  if (o.apps) openai.apps = "./.app.json";
  return {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: o.name,
    version: o.version,
    description: o.description,
    author: o.author,
    extensions: { "com.openai": openai },
  };
}

// Length caps are enforced on CODE POINTS. Byte length and UTF-16 length differ
// for the em dashes and curly apostrophes in the listing copy, and which one the
// portal counts is undocumented — so we also warn whenever the byte length would
// fail a cap that code points pass, surfacing the ambiguity before it bites.
const cp = (s) => [...s].length;

function checkText(label, value, cap, { required = true, singleLine = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) err(`${label} is missing`);
    return;
  }
  if (typeof value !== "string") {
    err(`${label} must be a string, got ${typeof value}`);
    return;
  }
  const n = cp(value);
  if (n > cap) err(`${label} is ${n} chars, over the ${cap} cap`);
  else if (n >= cap * 0.9) warn(`${label} is ${n} chars, within 10% of the ${cap} cap`);
  if (n <= cap && Buffer.byteLength(value) > cap) {
    warn(`${label} is ${n} code points but ${Buffer.byteLength(value)} bytes — over the ${cap} cap if the portal counts bytes`);
  }
  if (singleLine && /[\r\n]/.test(value)) err(`${label} must be a single line`);
  if (singleLine && value !== value.trim()) err(`${label} has leading or trailing whitespace`);
}

function validatePlugin(o, skills, entries, totalBytes) {
  // --- identity -------------------------------------------------------------
  checkText("name", o.name, LIMITS.name);
  if (typeof o.name === "string" && o.name !== "" && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.name)) {
    err(`name "${o.name}" must start with a letter or digit and contain only letters, digits, _ or -`);
  }
  if (typeof o.version !== "string" || !SEMVER.test(o.version)) {
    err(`version "${o.version}" is not strict semver (e.g. 2.1.0 — no "v" prefix, all three parts)`);
  } else if (o.version.length > LIMITS.version) {
    err(`version is ${o.version.length} chars, over the ${LIMITS.version} cap`);
  }
  checkText("description (derived from interface.longDescription)", o.description, LIMITS.description);
  if (!o.author || typeof o.author !== "object") err("author is missing");
  else checkText("author.name", o.author.name, LIMITS.authorName);

  // --- interface ------------------------------------------------------------
  const i = o.interface;
  if (!i || typeof i !== "object") {
    err("interface is missing");
  } else {
    checkText("interface.displayName", i.displayName, LIMITS.displayName, { singleLine: true });
    checkText("interface.shortDescription", i.shortDescription, LIMITS.shortDescription, { singleLine: true });
    checkText("interface.longDescription", i.longDescription, LIMITS.longDescription);
    if (!CATEGORIES.includes(i.category)) {
      err(`interface.category "${i.category}" is not an allowed category — one of: ${CATEGORIES.join(", ")}`);
    }
    if (i.defaultPrompt !== undefined) {
      if (!Array.isArray(i.defaultPrompt)) {
        err("interface.defaultPrompt must be an array of strings");
      } else {
        if (i.defaultPrompt.length > LIMITS.defaultPrompts) {
          err(`interface.defaultPrompt has ${i.defaultPrompt.length} entries, over the ${LIMITS.defaultPrompts} cap`);
        }
        i.defaultPrompt.forEach((p, n) => checkText(`interface.defaultPrompt[${n}]`, p, LIMITS.defaultPromptChars, { singleLine: true }));
      }
    }
  }

  // --- apps -----------------------------------------------------------------
  if (o.apps) {
    for (const [alias, entry] of Object.entries(o.apps)) {
      const id = entry?.id;
      if (typeof id !== "string" || !/^(asdk_app_|connector_|templated_apps_)/.test(id)) {
        err(`apps.${alias}.id "${id}" must start with asdk_app_, connector_ or templated_apps_`);
      }
      if (o.mcpServers && !(alias in o.mcpServers)) {
        warn(`apps.${alias} names no server in mcpServers — the alias should match`);
      }
    }
  }

  // --- skills ---------------------------------------------------------------
  if (skills.length === 0) err("no top-level directory has a SKILL.md — nothing to package");
  const seen = new Map();
  for (const s of skills) {
    if (!s.fm.name) err(`skills/${s.id}/SKILL.md frontmatter is missing \`name\``);
    if (!s.fm.description) err(`skills/${s.id}/SKILL.md frontmatter is missing \`description\``);
    const skillName = typeof s.fm.name === "string" ? s.fm.name : s.id;
    // The exact join character between plugin name and skill name is
    // undocumented, so budget one for it and stay conservative.
    const combined = cp(o.name ?? "") + 1 + cp(skillName);
    if (combined > LIMITS.name) {
      err(`plugin name + skill name "${o.name}" + "${skillName}" is ${combined} chars, over the ${LIMITS.name} cap`);
    }
    const key = skillName.normalize("NFC").toLowerCase();
    if (seen.has(key)) err(`skill names "${seen.get(key)}" and "${skillName}" collide after Unicode/case normalization`);
    else seen.set(key, skillName);
  }

  // --- paths ----------------------------------------------------------------
  const paths = new Map();
  for (const e of entries) {
    const p = e.path;
    if (p.includes("\\")) err(`path "${p}" must use forward slashes`);
    if (p.startsWith("/")) err(`path "${p}" must be relative`);
    const segs = p.split("/");
    if (segs.some((s) => s === "..")) err(`path "${p}" contains a ".." segment`);
    if (segs.some((s) => s === "")) err(`path "${p}" contains an empty segment`);
    if (segs.some((s) => s !== s.trim())) err(`path "${p}" has a segment with leading or trailing whitespace`);
    if (segs.length > LIMITS.pathSegments) err(`path "${p}" has ${segs.length} segments, over the ${LIMITS.pathSegments} cap`);
    const key = p.normalize("NFC").toLowerCase();
    if (paths.has(key)) err(`paths "${paths.get(key)}" and "${p}" collide after Unicode/case normalization`);
    else paths.set(key, p);
  }

  // --- archive --------------------------------------------------------------
  if (entries.length > LIMITS.entries) err(`${entries.length} entries, over the ${LIMITS.entries} cap`);
  if (totalBytes > LIMITS.uncompressedBytes) err(`${totalBytes} uncompressed bytes, over the ${LIMITS.uncompressedBytes} cap`);
}

// --- main --------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { sha, fetched } = resolveRef(opts.ref, opts.fetch);
  const short = sha.slice(0, 10);

  console.log("graffiticode plugin packager");
  console.log(`  ref          ${opts.ref} -> ${short}${opts.fetch ? `  (fetched: ${fetched ? "yes" : "no"})` : "  (fetch skipped)"}`);

  const head = git(["rev-parse", "HEAD"]).trim();
  if (head !== sha) {
    console.log(`  NOTE         your working tree is at ${head.slice(0, 10)}; this build uses ${short}.`);
    console.log("               They differ — the artifact does not contain what you are looking at.");
  }

  // Version comes from the ref's package.json, so the number that identifies a
  // submission lands in a reviewable diff next to the change that motivated it.
  const pkgBlob = readBlob(sha, "package.json");
  if (!pkgBlob) envFail(`ref ${short} has no package.json`);
  const pkgVersion = JSON.parse(pkgBlob.toString("utf8")).version;
  const version = opts.version ?? pkgVersion;
  console.log(`  version      ${version}  (${opts.version ? "CLI OVERRIDE — not from the ref" : "package.json @ ref"})`);
  if (opts.version) console.log("               note: an overridden version is not reproducible from the ref alone");
  console.log(`  schema       ${opts.schema}${opts.dev ? "  (-v2 identity — will not shadow the published plugin)" : ""}`);

  const metaBlob = readBlob(sha, "plugin.meta.json");
  if (!metaBlob) envFail(`ref ${short} has no plugin.meta.json — the listing copy the manifest is built from`);
  const metaHash = createHash("sha256").update(metaBlob).digest("hex");
  let meta;
  try {
    meta = JSON.parse(metaBlob.toString("utf8"));
  } catch (e) {
    envFail(`plugin.meta.json @ ${short} is not valid JSON: ${e.message}`);
  }
  console.log(`  listing      plugin.meta.json  sha256:${metaHash.slice(0, 12)}…`);
  console.log();

  console.log(`validating ${short} against its own scripts/validate-skills.mjs`);
  if (!validateRef(sha, opts.keepStaging)) {
    console.error(`\nrefusing to package: validation failed against ${short}`);
    process.exit(1);
  }
  console.log();

  const { served, held } = discoverSkills(sha);
  const skills = served.map((id) => {
    const bytes = readBlob(sha, `${id}/SKILL.md`);
    const parsed = parseFrontmatter(bytes.toString("utf8"));
    if (!parsed.ok) {
      err(`skills/${id}/SKILL.md: ${parsed.error}`);
      return { id, bytes, fm: {} };
    }
    return { id, bytes, fm: parsed.fm };
  });

  // Dropping the app binding is a diagnostic, not a preference.
  //
  // A registered app carries a REVIEWED SNAPSHOT of tool metadata — `_meta`, the
  // linked UI resource, its CSP — captured at Scan Tools. Our published app was
  // scanned before OpenAI clients were served a widget at all, so a plugin bound
  // to it calls the live server (the item really is created) and still shows no
  // inline render, because the marker lives in the snapshot. Without the
  // binding, mcp.json is the whole connection and there is no snapshot in the
  // path to be stale.
  const baseMeta = opts.dev ? altIdentity(meta) : meta;
  const plugin = buildPluginObject(opts.noApp ? { ...baseMeta, apps: undefined } : baseMeta, version);
  const serialized = opts.schema === "portable" ? serializePortable(plugin) : serializeNative(plugin);
  const pluginJson = Buffer.from(JSON.stringify(serialized, null, 2) + "\n", "utf8");

  // A plugin with no server is skills-only: the portal lists it, and there is
  // nothing to invoke by name. Verified 2026-09-17 — an install without this
  // listed correctly and `@graffiticode` was not found.
  const mcpJson = plugin.mcpServers
    ? Buffer.from(
        JSON.stringify(
          { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: plugin.mcpServers },
          null,
          2,
        ) + "\n",
        "utf8",
      )
    : null;

  // Bind to the registered app. An id is what a client connects to — it carries
  // the OAuth config, the verified domain and the review history that a bare URL
  // in mcp.json does not. Only shipped when an id exists: the documented
  // validator rejects a plugin.json that references .app.json when the file is
  // absent.
  const appJson = plugin.apps
    ? Buffer.from(JSON.stringify({ apps: plugin.apps }, null, 2) + "\n", "utf8")
    : null;

  const entries = opts.skillsOnly
    ? skills.map((s) => ({ path: `${s.id}/SKILL.md`, bytes: s.bytes }))
    : [
        { path: "plugin.json", bytes: pluginJson },
        ...(mcpJson ? [{ path: "mcp.json", bytes: mcpJson }] : []),
        ...(appJson ? [{ path: ".app.json", bytes: appJson }] : []),
        ...skills.map((s) => ({ path: `${s.id}/SKILL.md`, bytes: s.bytes })),
      ];
  const totalBytes = entries.reduce((n, e) => n + e.bytes.length, 0);

  validatePlugin(plugin, skills, entries, totalBytes);

  if (errors.length) {
    for (const w of warnings) console.log(`  warn  ${w}`);
    for (const e of errors) console.log(`  FAIL  ${e}`);
    console.error(`\n${errors.length} error(s). Nothing written.`);
    process.exit(1);
  }

  const zip = writeZip(entries);
  const hash = createHash("sha256").update(zip).digest("hex");

  console.log(`manifest (${entries.length} entries, ${totalBytes.toLocaleString()} bytes uncompressed, stored)`);
  const width = Math.max(...entries.map((e) => e.path.length));
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`  ${e.path.padEnd(width)}  ${e.bytes.length.toLocaleString().padStart(8)}`);
  }
  console.log();
  // Printed every build so a regression is visible in the log rather than inside
  // a binary: `forms` staying out is an assertion, not a footnote.
  if (held.length) console.log(`excluded: ${held.join(", ")} (SKILL.md.draft — held, not served)`);
  console.log("          scripts/, package.json, package-lock.json, README.md, CLAUDE.md,");
  console.log("          plugin.meta.json, .github/, .gitignore");
  console.log();

  for (const w of warnings) console.log(`  warn  ${w}`);
  if (warnings.length) console.log();

  if (opts.dryRun) {
    console.log("dry-run — nothing written (sha256 is the real artifact hash)");
    console.log(`  size    ${zip.length.toLocaleString()} bytes`);
    console.log(`  sha256  ${hash}`);
    return;
  }

  // A non-default ref gets the short SHA in its filename, so an experimental
  // build cannot silently overwrite the release artifact at the same path.
  const suffix = `${opts.dev ? "-v2" : ""}${opts.noApp ? "-noapp" : ""}${opts.skillsOnly ? "-skills" : ""}${opts.ref === "origin/main" ? "" : `+${sha.slice(0, 7)}`}`;
  const out = opts.out ?? join(ROOT, "dist", `graffiticode-plugin-${version}${suffix}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip);
  writeFileSync(`${out}.sha256`, `${hash}  ${out.split("/").pop()}\n`);

  console.log(`artifact  ${out}`);
  console.log(`  size    ${zip.length.toLocaleString()} bytes`);
  console.log(`  sha256  ${hash}`);
  console.log();
  console.log("record this sha256 in docs/openai-submission.md §2 alongside the upload.");
}

main();

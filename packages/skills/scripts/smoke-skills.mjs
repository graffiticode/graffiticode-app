#!/usr/bin/env node
// Post-deploy smoke test. Asks the live MCP server what it is actually serving
// and compares it to what is in this working tree.
//
// The check that earns its keep is the description comparison. `resources/read`
// returns raw markdown and never parses frontmatter, so a skill with broken YAML
// still reads back perfectly — it just quietly stops appearing (or updating) in
// `resources/list`, which is the surface agents route on. Only comparing the
// *listed* description against the local one catches that.
//
// Run: npm run smoke        (after pushing to the default branch)

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.GRAFFITICODE_MCP_URL ?? "https://mcp.graffiticode.org/mcp";
// Measured: a fresh push took ~3.5 minutes to go live. The server's cache TTL is
// only ~60s, so GitHub's raw-CDN propagation is the dominant term — budget for it.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 420_000);
const PROTOCOL = "2025-06-18";

// The server caches its GitHub reads (~60s TTL, stale-while-revalidate), so a
// fresh push is legitimately not live yet. Retry rather than fail — but bound it,
// because "still stale after four minutes" is a real failure, not slow cache.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let session = null;
let nextId = 1;

async function rpc(method, params, { notify = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (session) headers["Mcp-Session-Id"] = session;

  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) body.id = nextId++;

  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status} ${res.statusText}`);

  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (notify) return null;

  const text = await res.text();
  // Streamable HTTP replies as either application/json or an SSE frame.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;

  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`${method} → ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg.result;
}

// --- what this working tree says --------------------------------------------
const local = readdirSync(ROOT)
  .filter((d) => !d.startsWith(".") && statSync(join(ROOT, d)).isDirectory())
  .filter((d) => existsSync(join(ROOT, d, "SKILL.md")))
  .sort()
  .map((id) => {
    const text = readFileSync(join(ROOT, id, "SKILL.md"), "utf8");
    const end = text.indexOf("\n---\n", 3);
    const fm = yaml.load(text.slice(4, end + 1));
    // Trim: a `description: >` folded scalar carries a trailing newline that the
    // server strips. Comparing untrimmed reports every folded description as a
    // mismatch forever.
    return { id, text, uri: `graffiticode://skills/${id}`, name: fm.name, description: fm.description.trim() };
  });

// --- what the server says ----------------------------------------------------
async function probe() {
  const failures = [];

  await rpc("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "graffiticode-skills-smoke", version: "1.0.0" },
  });
  await rpc("notifications/initialized", undefined, { notify: true });

  const listed = new Map(
    ((await rpc("resources/list")).resources ?? [])
      .filter((r) => r.uri.startsWith("graffiticode://skills/"))
      .map((r) => [r.uri, r]),
  );

  for (const skill of local) {
    const entry = listed.get(skill.uri);

    // Absent from the listing = the server could not parse or reach it. To an
    // agent, this skill does not exist.
    if (!entry) {
      failures.push(`${skill.id}: not in resources/list — the server is not serving it at all`);
      continue;
    }

    if ((entry.description ?? "").trim() !== skill.description) {
      failures.push(
        `${skill.id}: served description does not match local frontmatter ` +
          `(served ${entry.description?.length ?? 0} chars, local ${skill.description.length}). ` +
          `Either the cache is still warm, or the frontmatter failed to parse and the server is holding the previous value.`,
      );
    }
    if (entry.name !== skill.name) {
      failures.push(`${skill.id}: served name "${entry.name}" ≠ local name "${skill.name}"`);
    }

    const read = await rpc("resources/read", { uri: skill.uri });
    const servedText = read.contents?.[0]?.text ?? "";
    if (servedText !== skill.text) {
      failures.push(`${skill.id}: served body differs from local SKILL.md (served ${servedText.length} chars, local ${skill.text.length})`);
    }
  }

  for (const uri of listed.keys()) {
    if (!local.some((s) => s.uri === uri)) {
      failures.push(`${uri}: served, but no such skill in this working tree`);
    }
  }

  return failures;
}

// --- poll until live matches local, or give up -------------------------------
console.log(`\nSmoke-testing ${URL}`);
console.log(`Expecting ${local.length} skill(s): ${local.map((s) => s.id).join(", ")}\n`);

const deadline = Date.now() + TIMEOUT_MS;
let attempt = 0;
let failures = [];

while (Date.now() < deadline) {
  attempt++;
  session = null;
  try {
    failures = await probe();
  } catch (e) {
    failures = [`transport: ${e.message}`];
  }

  if (!failures.length) {
    console.log(`Live server matches this working tree (attempt ${attempt}).\n`);
    process.exit(0);
  }

  const left = Math.round((deadline - Date.now()) / 1000);
  if (left <= 0) break;
  console.log(`  attempt ${attempt}: ${failures.length} mismatch(es); retrying (${left}s left, cache TTL is ~60s)`);
  await sleep(Math.min(15_000, Math.max(1_000, deadline - Date.now())));
}

console.log(`\nStill mismatched after ${attempt} attempt(s) — past the cache window, so this is real:\n`);
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log("");
process.exit(1);

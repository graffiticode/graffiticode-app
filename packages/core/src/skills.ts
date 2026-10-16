// Agent skills, shared by the MCP server (graffiticode://skills/<id>) and the
// REST API (GET /v1/skills). Moved from packages/mcp-server/src/resources.ts.
// ---------------------------------------------------------------------------
// Skills — discovered and read at request time from a public GitHub repo, so
// adding a skill to packages/skills makes it available without rebuilding
// or redeploying this server. Each top-level directory in the repo is one
// skill (`<id>/SKILL.md`); the directory name is the skill id.
// ---------------------------------------------------------------------------

// The skills live in graffiticode-app's packages/skills (moved from the
// graffiticode-skills repo, 2026-10-16). Read from the default branch at
// request time, so a merged skill edit is live without a redeploy.
const SKILLS_REPO =
  process.env.GRAFFITICODE_SKILLS_REPO || "graffiticode/graffiticode-app";
const SKILLS_REF = process.env.GRAFFITICODE_SKILLS_REF || "main";
// The directory within the repository holding one directory per skill ("" for
// a repository of skills alone).
const SKILLS_PATH = (process.env.GRAFFITICODE_SKILLS_SUBDIR ?? "packages/skills").replace(/^\/+|\/+$/g, "");
const SKILLS_CACHE_TTL_MS = Number(
  process.env.GRAFFITICODE_SKILLS_TTL_MS || "60000",
);


export interface SkillEntry {
  id: string; // directory name, e.g. "graffiticode-render"
  name: string; // frontmatter `name`, falling back to id
  description: string; // frontmatter `description` (folded to one line)
  text: string; // full SKILL.md markdown
}

interface SkillCache {
  skills: SkillEntry[];
  expires: number;
}

let skillCache: SkillCache | null = null;
let skillCacheInflight: Promise<SkillEntry[]> | null = null;

// Minimal YAML-frontmatter reader for the two fields we surface. Handles plain
// inline values and `>`/`|` block scalars (folded to a single spaced line,
// which is what we want for resource listings).
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return {};
  const lines = block[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s?(.*)$/);
    if (!kv) continue;
    const key = kv[1] as "name" | "description";
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(lines[j])) break; // dedent → next key
        collected.push(lines[j].trim());
      }
      i = j - 1;
      value = collected.join(" ").replace(/\s+/g, " ").trim();
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    out[key] = value;
  }
  return out;
}

async function fetchSkillMarkdown(id: string): Promise<string | null> {
  const rawUrl = `https://raw.githubusercontent.com/${SKILLS_REPO}/${SKILLS_REF}/${SKILLS_PATH ? `${SKILLS_PATH}/` : ""}${encodeURIComponent(
    id,
  )}/SKILL.md`;
  const res = await fetch(rawUrl, {
    headers: { "User-Agent": "graffiticode-app" },
  });
  if (res.status === 404) return null; // directory without a SKILL.md — skip
  if (!res.ok) {
    throw new Error(`raw fetch ${res.status} for ${id}/SKILL.md`);
  }
  return await res.text();
}

async function fetchSkillCatalog(): Promise<SkillEntry[]> {
  const listUrl = `https://api.github.com/repos/${SKILLS_REPO}/contents/${SKILLS_PATH}?ref=${encodeURIComponent(
    SKILLS_REF,
  )}`;
  const res = await fetch(listUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "graffiticode-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub contents API ${res.status} for ${SKILLS_REPO}/${SKILLS_PATH}`);
  }
  const entries = (await res.json()) as Array<{ type: string; name: string }>;
  const dirs = entries.filter((e) => e.type === "dir");
  const skills = await Promise.all(
    dirs.map(async (d): Promise<SkillEntry | null> => {
      const text = await fetchSkillMarkdown(d.name);
      if (text == null) return null;
      const { name, description } = parseFrontmatter(text);
      return {
        id: d.name,
        name: name || d.name,
        description: description || "",
        text,
      };
    }),
  );
  return skills.filter((s): s is SkillEntry => s !== null);
}

// Stale-while-revalidate: serve a non-expired cache immediately; when stale,
// return the stale copy and refresh in the background; only the very first
// call (no cache yet) awaits the fetch. Concurrent refreshes are deduped, and
// a failed refresh falls back to the last known-good catalog.
export async function getSkillCatalog(): Promise<SkillEntry[]> {
  if (skillCache && Date.now() < skillCache.expires) {
    return skillCache.skills;
  }
  if (!skillCacheInflight) {
    skillCacheInflight = fetchSkillCatalog()
      .then((skills) => {
        skillCache = { skills, expires: Date.now() + SKILLS_CACHE_TTL_MS };
        return skills;
      })
      .catch((err) => {
        console.error(
          `[skills] catalog refresh failed: ${err?.message ?? err}`,
        );
        if (skillCache) return skillCache.skills; // serve stale on error
        throw err;
      })
      .finally(() => {
        skillCacheInflight = null;
      });
  }
  if (skillCache) return skillCache.skills; // stale-while-revalidate
  return skillCacheInflight;
}


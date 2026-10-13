/**
 * MCP resource handlers for the hosted server.
 *
 * Exposes each Graffiticode language's full user-guide markdown as a
 * per-language resource URI. The inline envelope returned by
 * get_language_info is typically enough for authoring; clients fetch the
 * full guide through ReadResource for deeper reference.
 */

import { getLanguageInfo, type AuthContext } from "./api.js";

export const USER_GUIDE_URI_TEMPLATE = "graffiticode://language/{id}/user-guide";
export const USER_GUIDE_MIME_TYPE = "text/markdown";

// ---------------------------------------------------------------------------
// Skills — discovered and read at request time from a public GitHub repo, so
// adding a skill to graffiticode-skills makes it available without rebuilding
// or redeploying this server. Each top-level directory in the repo is one
// skill (`<id>/SKILL.md`); the directory name is the skill id.
// ---------------------------------------------------------------------------

const SKILLS_REPO =
  process.env.GRAFFITICODE_SKILLS_REPO || "graffiticode/graffiticode-skills";
const SKILLS_REF = process.env.GRAFFITICODE_SKILLS_REF || "main";
const SKILLS_CACHE_TTL_MS = Number(
  process.env.GRAFFITICODE_SKILLS_TTL_MS || "60000",
);

export const SKILL_MIME_TYPE = "text/markdown";
const SKILL_URI_PREFIX = "graffiticode://skills/";
const SKILL_URI_PATTERN = /^graffiticode:\/\/skills\/([A-Za-z0-9._-]+)$/;

interface SkillEntry {
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
  const rawUrl = `https://raw.githubusercontent.com/${SKILLS_REPO}/${SKILLS_REF}/${encodeURIComponent(
    id,
  )}/SKILL.md`;
  const res = await fetch(rawUrl, {
    headers: { "User-Agent": "graffiticode-mcp-server" },
  });
  if (res.status === 404) return null; // directory without a SKILL.md — skip
  if (!res.ok) {
    throw new Error(`raw fetch ${res.status} for ${id}/SKILL.md`);
  }
  return await res.text();
}

async function fetchSkillCatalog(): Promise<SkillEntry[]> {
  const listUrl = `https://api.github.com/repos/${SKILLS_REPO}/contents?ref=${encodeURIComponent(
    SKILLS_REF,
  )}`;
  const res = await fetch(listUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "graffiticode-mcp-server",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub contents API ${res.status} for ${SKILLS_REPO}`);
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
async function getSkillCatalog(): Promise<SkillEntry[]> {
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

export async function listSkillResources(): Promise<
  Array<{ uri: string; name: string; description: string; mimeType: string }>
> {
  const skills = await getSkillCatalog();
  return skills.map((s) => ({
    uri: `${SKILL_URI_PREFIX}${s.id}`,
    name: s.name,
    description: s.description,
    mimeType: SKILL_MIME_TYPE,
  }));
}

export function matchSkillUri(uri: string): string | null {
  const match = uri.match(SKILL_URI_PATTERN);
  return match ? match[1] : null;
}

export async function readSkillResource(
  uri: string,
  id: string,
): Promise<{ uri: string; mimeType: string; text: string }> {
  const skills = await getSkillCatalog();
  const skill = skills.find((s) => s.id === id);
  if (!skill) {
    throw new Error(`Skill not found: ${id}`);
  }
  return { uri, mimeType: SKILL_MIME_TYPE, text: skill.text };
}

export const userGuideResourceTemplate = {
  uriTemplate: USER_GUIDE_URI_TEMPLATE,
  name: "Graffiticode Language User Guide",
  description:
    "Agent-facing authoring guide (markdown) for a Graffiticode language. " +
    "Substitute {id} with a language ID like L0166.",
  mimeType: USER_GUIDE_MIME_TYPE,
};

const USER_GUIDE_URI_PATTERN = /^graffiticode:\/\/language\/L(\d+)\/user-guide$/i;

export function matchUserGuideUri(uri: string): string | null {
  const match = uri.match(USER_GUIDE_URI_PATTERN);
  return match ? match[1] : null;
}

export async function readUserGuideResource(options: {
  auth: AuthContext;
  uri: string;
  langId: string;
}): Promise<{ uri: string; mimeType: string; text: string }> {
  const { auth, uri, langId } = options;
  const info = await getLanguageInfo({ auth, language: langId });
  if (!info) {
    throw new Error(`Language not found: L${langId}`);
  }
  return {
    uri,
    mimeType: USER_GUIDE_MIME_TYPE,
    text: info.usageGuide ?? "",
  };
}

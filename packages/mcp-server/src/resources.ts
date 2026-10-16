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

import { getSkillCatalog } from "@graffiticode-app/core/skills";

export const SKILL_MIME_TYPE = "text/markdown";
const SKILL_URI_PREFIX = "graffiticode://skills/";
const SKILL_URI_PATTERN = /^graffiticode:\/\/skills\/([A-Za-z0-9._-]+)$/;

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

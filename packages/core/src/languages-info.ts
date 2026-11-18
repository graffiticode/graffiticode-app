/**
 * Language registry for Graffiticode
 *
 * Language specs are fetched dynamically from l{langId}.graffiticode.org/spec.html.
 * Agent-facing authoring envelope (authoringGuide, supportedItemTypes,
 * examplePrompts) and the full usage-guide markdown are fetched from the
 * language server by getLanguageServerDoc().
 */

import { findLanguageById, isLanguageOffered, listLanguages as listLangs, type Language } from "./lib/languages.js";
import { installedProfile } from "./profile/current.js";
import { languageServerOrigin, resolveHosts } from "./profile/hosts.js";
import { getLanguageScope, getLanguageServerDoc } from "./lib/language-server-client.js";

export type { Language };

export interface ExamplePrompt {
  prompt: string;
  produces?: string;
  notes?: string;
}

export interface LanguageScopeInfo {
  summary: string;
  inScope: string[];
  outOfScope: string[];
}

export interface LanguageInfo extends Language {
  examples: string[];
  reactComponent: {
    package: string;
    component: string;
    styleImport?: string;
  };
  specUrl: string;
  authoringGuide: string | null;
  supportedItemTypes: string[];
  examplePrompts: ExamplePrompt[];
  usageGuide: string | null;
  scope: LanguageScopeInfo | null;
}

export { listLangs as listLanguages };

/**
 * Get detailed info for a specific language
 * Fetches spec from language server dynamically
 */
export async function getLanguageInfo(id: string): Promise<LanguageInfo | null> {
  // Normalize language ID (remove "L" prefix if present)
  const langId = id.replace(/^L/i, "");

  // Find base language info
  // A language the installation doesn't offer has no detail to give here
  // (discovery), though its existing items still resolve by id elsewhere.
  const baseLang = findLanguageById(langId);
  if (!baseLang || !isLanguageOffered(langId)) {
    return null;
  }

  const specUrl = `${languageServerOrigin(resolveHosts(installedProfile()?.profile ?? null, process.env), langId)}/spec.html`;

  const [{ envelope, usageGuide }, scope] = await Promise.all([
    getLanguageServerDoc(langId),
    getLanguageScope(langId),
  ]);

  return {
    ...baseLang,
    longDescription: envelope?.description ?? undefined,
    examples: [],
    reactComponent: {
      package: `@graffiticode/l${langId}`,
      component: "Form",
      styleImport: `@graffiticode/l${langId}/style.css`,
    },
    specUrl,
    authoringGuide: envelope?.authoring_guide ?? null,
    supportedItemTypes: envelope?.supported_item_types ?? [],
    examplePrompts: envelope?.example_prompts ?? [],
    usageGuide: usageGuide ?? null,
    scope: scope
      ? { summary: scope.summary, inScope: scope.in_scope, outOfScope: scope.out_of_scope }
      : null,
  };
}

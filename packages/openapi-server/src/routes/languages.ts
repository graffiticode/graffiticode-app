// GET /languages, /languages/{id}, /languages/{id}/guide — MCP's
// list_languages and get_language_info, and its user-guide resource.
import type { Hono } from "hono";
import { listLanguages, getLanguageInfo } from "@graffiticode-app/core/languages-info";
import { isDiscoverable } from "@graffiticode-app/core/discovery";
import { ApiProblem, notFound } from "../problems.js";
import { bareLanguageId, cached, decodeCursor, encodeCursor, json, languageId } from "../http.js";
import { publicBase } from "../spec.js";
import type { Validate } from "../app.js";

const language = (l: any) => ({
  id: languageId(l.id),
  name: l.name,
  description: l.description,
  ...(l.routingHint ? { when_to_use: l.routingHint } : {}),
  domains: l.domains ?? [],
});

export function languageRoutes(app: Hono, validate: Validate) {
  app.get("/languages", async (c) => {
    const { query } = validate(c, "list_languages");
    const offset = decodeCursor(query.cursor);
    if (offset < 0) throw new ApiProblem(400, "invalid_cursor", "Invalid cursor", { detail: "Use next_cursor from a previous page." });
    const all = (await listLanguages({ search: query.search?.trim() || undefined, domain: query.domain }))
      .filter((l: any) => !l.internal && isDiscoverable(l.id))
      .filter((l: any) => !query.domain || l.domains?.includes(query.domain));
    const page = all.slice(offset, offset + query.limit);
    const next = offset + query.limit < all.length ? encodeCursor(offset + query.limit) : null;
    return cached(c, json({ data: page.map(language), next_cursor: next }), "application/json", 300);
  });

  const info = async (id: string) => {
    const found = await getLanguageInfo(bareLanguageId(id));
    if (!found) throw notFound(`Language ${languageId(id)}`);
    return found;
  };

  app.get("/languages/:id", async (c) => {
    const { path } = validate(c, "get_language_info");
    const i = await info(path.id);
    return cached(c, json({
      ...language(i),
      authoring_guide: i.authoringGuide ?? null,
      supported_item_types: i.supportedItemTypes ?? [],
      not_for: i.scope?.outOfScope ?? [],
      example_prompts: i.examplePrompts ?? [],
      guide_url: `${publicBase()}/languages/${languageId(i.id)}/guide`,
      spec_url: i.specUrl,
    }), "application/json", 300);
  });

  app.get("/languages/:id/guide", async (c) => {
    const { path } = validate(c, "get_language_guide");
    const i = await info(path.id);
    if (!i.usageGuide) throw notFound(`A user guide for ${languageId(i.id)}`);
    return cached(c, i.usageGuide, "text/markdown; charset=utf-8", 300);
  });
}

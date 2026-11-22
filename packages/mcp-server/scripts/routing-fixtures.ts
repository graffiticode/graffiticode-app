// Items the routing eval serves from render_item, built with the server's own description
// code (src/item-content.ts, describeItem), so a fixture reads the way a real survey does.
import { describeItem } from "../src/item-content.js";
import type { FixtureItem } from "./routing-surface.js";

export function surveyFixture(
  itemId: string,
  { name, title, ideas, minChoices, maxChoices }: { name: string; title: string; ideas: string[]; minChoices: number; maxChoices: number },
): FixtureItem {
  const survey = { name, title, ideas: ideas.map((text, i) => ({ id: `i${i + 1}`, text })), minChoices, maxChoices };
  const content = describeItem("L0182", { data: { survey } } as any);
  if (!content || content.kind !== "prose") throw new Error(`no survey description for ${itemId}`);
  return { item_id: itemId, status: "ready", language: "L0182", name: title, summary: content.text };
}

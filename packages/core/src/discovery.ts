// Which languages discovery shows (MCP's list_languages, REST GET
// /v1/languages). Moved from the MCP server so both front doors agree. Hidden
// languages stay usable by id: info and creation still answer for them.

/**
 * The oldest language `list_languages` will show. Everything below it is either
 * not a content-authoring target at all — `L0000` (root), `L0003` (primitives
 * demo), `L0010`/`L0013` (internal composition-planning and thumbnail dialects)
 * — or superseded: `L0158` is Learnosity's own catalog entry marking it legacy
 * in favour of `L0176`.
 *
 * The low ids sort first, so an agent asking what Graffiticode does met them
 * before the real catalog, and the funnel logs show real ChatGPT users doing
 * exactly that: `list_languages` → `get_language_info(L0000)` →
 * `get_language_info(L0010)` → gone, without ever creating anything.
 *
 * A FLOOR rather than a deny-list because ids are issued in order, so the next
 * language is discoverable the day it ships without an edit here. The cost is
 * that it is coarse — it cuts by age, not by whether a language still earns its
 * place — so it takes exceptions.
 */
const MIN_DISCOVERABLE_LANGUAGE = 166;

/**
 * Working languages below the floor that stay discoverable anyway.
 *
 * `L0159` (flashcards, match and memory) is one the product actively sells:
 * `SERVER_INSTRUCTIONS` names flashcards, and the live ChatGPT listing indexes
 * on the word. Hiding it would have left the directory recruiting people for a
 * capability discovery couldn't reach.
 *
 * L0152 (map questions), L0153 (area model) and L0154 (magic square) are also
 * working languages and are deliberately NOT here — they are below the floor
 * and stay hidden.
 */
const BELOW_FLOOR_KEEP = new Set(["0159"]);

/**
 * Languages above the floor that are hidden anyway — the floor's other exception.
 *
 * `L0172` (FigJam boards) generates real output, but landing it in FigJam takes a
 * human wiring up the Figma side; an agent that picks it hands the user something
 * they can't finish from chat. `L0174` (forms) is unfinished. `L0171` (Venn
 * diagrams) was withdrawn from discovery on 2026-08-25.
 *
 * All are hidden from discovery only. `get_language_info` and `create_item` still
 * answer for them, the same way they do for the sub-floor ids, so anything that
 * already holds the id keeps working.
 */
const ABOVE_FLOOR_HIDE = new Set(["0171", "0172", "0174"]);

/** Catalog ids are bare, zero-padded and numeric ("0166"); anything else can't be compared to the floor. */
export function isDiscoverable(id: string): boolean {
  if (ABOVE_FLOOR_HIDE.has(id)) return false;
  if (BELOW_FLOOR_KEEP.has(id)) return true;
  const n = Number(id);
  return Number.isFinite(n) && n >= MIN_DISCOVERABLE_LANGUAGE;
}

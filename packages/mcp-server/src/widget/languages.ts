/**
 * The language registry: the single source of truth for which languages the
 * widget renders natively.
 *
 * Consumed by both `scripts/build-widget.mjs` (which bundles one ESM module per
 * native language into `dist/widget/lang/<id>.mjs`) and the runtime handlers in
 * `server.ts` that serve those bundles.
 *
 * npm is the source of truth for component versions: `pkg` is resolved from
 * node_modules at build time and the version is pinned in package.json. Shipping
 * a language upgrade is `npm update <pkg>` → rebuild → deploy, so it passes a
 * build before it reaches users. Adding a language is: `npm i -D <pkg>`, then one
 * entry here.
 */

export interface NativeLanguage {
  /** Canonical language id, e.g. "L0166". */
  id: string;
  /** npm package exporting the presentational `Form` component. */
  pkg: string;
  /**
   * Which model the Form renders from — l0000-view's `formModel`. A package that
   * exports `formModel` (l0179-view >= 0.3.4) is read directly and overrides this;
   * this is the fallback for one that predates the export (l0166).
   *
   * `"live"` (default): a controlled Form, which must see its own edits come back.
   * `"loaded"`: an uncontrolled Form that seeds itself from the model once and owns
   * its editing state after. L0166's spreadsheet Form (which L0179 injects) is one:
   * its TableEditor rebuilds the whole ProseMirror grid and puts the caret back in
   * A1 whenever `interaction.cells` changes identity, and its own cell `update`
   * produces a fresh `cells` on every commit. Fed live, the grid re-seeds on every
   * caret move — it visibly jitters and swallows what was typed (ChatGPT desktop,
   * 2026-10-06).
   */
  formModel?: "live" | "loaded";
}

/**
 * Every language the catalog lists renders natively. There is no "non-renderable"
 * tier: each language ships a React `Form` view, so if `list_languages` returns it,
 * it belongs here. A listed language with no entry silently degrades to the content
 * card, which reads as a broken render rather than a deliberate one.
 *
 * This replaces an earlier `NON_RENDERABLE_LANGUAGES` set that exempted
 * L0158/L0176/L0177/L0170 on the theory that vendor-script, spec-emitting and
 * data-provider languages had nothing to show. They do — each has a `Form` in its
 * repo's `packages/view`. That set was also never imported anywhere, so it
 * documented a policy the code did not implement.
 *
 * The props contract is uniform across all of these: each package exports
 * `Form: ({ state })` (the `FormProps` from `@graffiticode/l0000-view`) plus a
 * `./style.css` subpath, which is exactly what `entrySource()` in
 * `scripts/build-widget.mjs` generates against.
 *
 * VERIFICATION DEBT: the eight added 2026-09-01 build, but none has been seen
 * rendering a real item by a person. That is the bar this file previously set, after
 * L0169 was added on the strength of a clean build and then did NOT mount in
 * production — it fell through to the content card, having paid for a 0.3MB bundle
 * and the empty-mount grace period first. jsdom does not clear that bar either: it
 * cannot render L0173 at all, so a failure there proves nothing. Treat every entry
 * after L0179 below as unverified until someone has watched it render.
 *
 * L0180 has now cleared that bar: it was watched rendering a real item in ChatGPT.
 * What that sighting also showed is that DRAWING is not the whole bar — it drew its
 * options and then would not select one, because the widget's `mount()` gave the
 * Form an `apply` that notified React of nothing. Fixed in `scripts/build-widget.mjs`
 * and pinned by `tests/widget-native-mount.test.ts`. The lesson generalizes to every
 * entry here: "it mounted" and "it works" are different claims, and only the second
 * one matters for an interactive language.
 */
export const NATIVE_LANGUAGES: NativeLanguage[] = [
  { id: "L0166", pkg: "@graffiticode/l0166", formModel: "loaded" },
  // L0173 renders charts; L0179 supersedes L0166 and needed its own bundle, since
  // the DEPRECATED dialect rendered natively while its live replacement fell back
  // to a static preview — the wrong way round for the language 8 of 17 recent
  // items were authored in. Same `({ state })` Form contract as l0166.
  { id: "L0173", pkg: "@graffiticode/l0173" },
  // formModel comes from the package itself (l0179-view >= 0.3.4 exports it).
  { id: "L0179", pkg: "@graffiticode/l0179-view" },

  // Added 2026-09-01. The first three were on npm already; the five `-view`
  // packages were built in their own repos but had never been pushed, which was
  // the only thing blocking them.
  { id: "L0159", pkg: "@graffiticode/l0159" },
  // L0169 left 2026-10-04. It never mounted in production (added and reverted 2026-08-31,
  // then re-added only because the catalog listed it), and it is deprecated for L0183, which
  // renders natively below. Its items now get the content card, the fallback they were
  // already landing on after a failed mount — minus the 0.3MB bundle and the grace period.
  { id: "L0170", pkg: "@graffiticode/l0170" },
  // L0175 has a published base package too (`@graffiticode/l0175`), but that one is
  // the COMPILER: no `Form`, no `style.css`, so pointing at it fails the build. The
  // view is always the `-view` package, as with L0179.
  { id: "L0175", pkg: "@graffiticode/l0175-view" },
  { id: "L0176", pkg: "@graffiticode/l0176-view" },
  { id: "L0177", pkg: "@graffiticode/l0177-view" },
  { id: "L0178", pkg: "@graffiticode/l0178-view" },
  { id: "L0180", pkg: "@graffiticode/l0180-view" },
  // L0181 flashcards (replaces L0159's). Before this entry a deck rendered as its raw JSON in
  // ChatGPT while the quiz it was studied from rendered natively. Flip/advance is pinned by
  // `tests/widget-native-mount.test.ts`.
  { id: "L0181", pkg: "@graffiticode/l0181-view" },
  // L0184 charts (succeeds L0173, which stays for its existing items). 0.2.1 or later:
  // 0.2.0's bundle lost its ECharts registration to tree-shaking and drew nothing.
  { id: "L0184", pkg: "@graffiticode/l0184-view" },
  // L0185 fetch and shape data (succeeds L0170, which stays for its existing items). Read-only:
  // a record table or a JSON tree of the transformed data; the Form never calls `apply`.
  { id: "L0185", pkg: "@graffiticode/l0185-view" },
  // L0186 FigJam boards (succeeds L0172, which stays for its existing items). Read-only: an SVG
  // preview of the board, one tab per page; the plugin, not the widget, draws into FigJam.
  { id: "L0186", pkg: "@graffiticode/l0186-view" },

  // L0014 authors TransLaTeX rule sets. It is INTERNAL: the catalog does not list it, so
  // nothing routes a request to it. It is here for an item rendered by id, where the
  // content card would show nothing useful. Its Form is a read-only report of the rule set's
  // test corpus (pass / fail / captured per case) and never calls `apply`, so mounting it
  // is the whole bar. `tests/l0014-widget-mount.test.ts` pins that against the built bundle.
  { id: "L0014", pkg: "@graffiticode/l0014-view" },

  // L0182 surveys. Read-only: the Form displays the set of ideas and the response, and never
  // calls `apply`, so drawing both is the whole bar — pinned by `tests/widget-native-mount.test.ts`.
  { id: "L0182", pkg: "@graffiticode/l0182-view" },

  // L0183 concept webs (supersede L0169). Interactive: placing an answer is a `response`
  // action whose cells the package's exported `reduce` folds into `interaction.cells`, which
  // `scripts/build-widget.mjs` now honours. Scoring runs in the browser from `validation`, so
  // Check works with no network. Pinned by `tests/widget-native-mount.test.ts`.
  { id: "L0183", pkg: "@graffiticode/l0183-view" },
];

/** Normalize `0166` / `l0166` / `L0166` to `L0166`. */
export function normalizeLanguageId(lang: string): string {
  const digits = lang.replace(/^[lL]/, "");
  return `L${digits}`;
}

export function isNativeLanguage(lang: string): boolean {
  const id = normalizeLanguageId(lang);
  return NATIVE_LANGUAGES.some((l) => l.id === id);
}

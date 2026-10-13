/**
 * Bundle the widget browser entries.
 *
 * Two kinds of output:
 *
 * 1. `dist/widget/widget.bundle.js` — the widget entry (`src/widget/browser/entry.ts`),
 *    a self-contained IIFE inlined into the resource HTML by `generateWidgetHtml()`.
 *    It picks the host adapter (ext-apps / window.openai) at runtime, so one bundle
 *    serves both hosts. tsc does not compile browser/*.ts (they need DOM libs and
 *    must be a browser bundle).
 *
 * 2. `dist/widget/lang/<id>.mjs` — one ES module per natively-renderable language
 *    (see `src/widget/languages.ts`), served over HTTP and loaded by the widget at
 *    render time. Each bundle owns its React copy and exposes a uniform API:
 *
 *      export const styles: string              // the component's CSS
 *      export function mount(el, data): void    // render the item into `el`
 *
 *    That seam keeps the widget language-agnostic — it never imports React, and
 *    per-language quirks (differing `Form` props, reducers) are absorbed here.
 *    React is bundled IN, not externalized: a bare `react` specifier in a
 *    standalone module is unresolvable in a browser without an import map.
 *
 * Runs after `tsc` as part of `npm run build` (it reads the compiled registry).
 */
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let NATIVE_LANGUAGES;
try {
  ({ NATIVE_LANGUAGES } = await import("../dist/widget/languages.js"));
} catch (err) {
  console.error(
    "Could not load the compiled language registry from dist/widget/languages.js.\n" +
      'Run "tsc" first (npm run build does this).'
  );
  throw err;
}

/**
 * Force ONE React into every language bundle.
 *
 * The language packages declare `react`/`react-dom` as direct DEPENDENCIES
 * rather than peers — all of l0151/0154/0155/0159/0169/0170/0172 and
 * l0179-view do. npm is then free to nest a private copy under the package,
 * and esbuild faithfully bundles both, at which point hooks resolve against a
 * null dispatcher and mounting dies with
 * `Cannot read properties of null (reading 'useState')`. L0169 failed exactly
 * this way; L0179 escaped it only because npm happened to hoist its copy, which
 * is luck rather than a guarantee — the same install on a different day can
 * nest it.
 *
 * Aliasing at bundle time fixes every package at once and keeps working when a
 * new one is added, without waiting on eight republishes to move react to
 * peerDependencies. That is still the right fix in the packages; this makes the
 * build correct meanwhile, and harmless afterwards.
 *
 * react-dom/client is listed explicitly: esbuild aliases a bare specifier, and
 * the entry template imports the subpath.
 */
const reactPath = (spec) => fileURLToPath(import.meta.resolve(spec));
const REACT_ALIAS = {
  react: reactPath("react"),
  "react-dom": reactPath("react-dom"),
  "react-dom/client": reactPath("react-dom/client"),
  "react/jsx-runtime": reactPath("react/jsx-runtime"),
};

const SHARED = {
  bundle: true,
  platform: "browser",
  target: ["chrome100", "firefox100", "safari15"],
  minify: true,
  legalComments: "none",
  alias: REACT_ALIAS,
};

// The unified widget entry (both hosts; picks the adapter at runtime).
await build({
  ...SHARED,
  entryPoints: ["src/widget/browser/entry.ts"],
  outfile: "dist/widget/widget.bundle.js",
  format: "iife",
});
console.log("Bundled dist/widget/widget.bundle.js");

/**
 * The per-language entry, generated in memory.
 *
 * The state store is reproduced here rather than imported: the language packages
 * export only `Form`/`View`, and `View` is the network shell we are deliberately
 * not using (it reads `?id=`/`?access_token=` off the URL and round-trips
 * `/compile`). What we DO have to reproduce faithfully is the half of `View` that
 * is not networking: `state.apply` is a React `useReducer` dispatch, so applying an
 * action re-renders the Form.
 *
 * That is load-bearing, not incidental. Every `Form` in the family is CONTROLLED —
 * l0180 keeps the candidate's answer in `state.data.response` and renders ✓/✗ and
 * "Correct — 1 / 1 points" from `data.response` + `data.validation` on the next
 * render. An `apply` that mutates a closure and notifies nobody (what this built
 * before) leaves the component holding its first render forever: a click selects
 * nothing, and no assessment ever scores. It looked like a missing feature and was
 * a missing `setState`.
 *
 * Language-specific edit semantics are reproduced only where the package EXPORTS its
 * reducer as `reduce` — the same hook l0000-view's `View` takes, consulted first and
 * returning `undefined` for anything it does not claim. L0183 exports one, because its
 * placements must land in `interaction.cells`, not on the top level. A package that
 * keeps its reducer un-exported (l0166's `view.jsx`) still gets only the generic merge. Neither is the `/compile` round trip `View`
 * performs on `update`/`response`, which is what re-derives server-computed data
 * (l0166 formula results); the widget's CSP declares no `connectDomains`, so any
 * language whose feedback is computed upstream rather than in the browser still
 * renders inertly. l0180 is not one of those: it ships its own scorer.
 *
 * Checking is the host's, as in l0000-view's `View` (>= 0.3.0): a package that exports `score`
 * gets l0000-view's CheckBar under its Form. Check is a toggle — it shows the score and lays
 * `showValidationUI: true` over what the Form sees, and pressing it again hides both, as does the
 * learner's next change to the model; an `update`/`response` that changes nothing (L0179 reports
 * both on a caret move) keeps it. CheckBar itself stays disabled until `score` says `complete`. The
 * Forms draw right and wrong from that flag, or from the program's `instant-feedback true`, and
 * nothing else — without this bar an L0183 or L0179 item here could never be checked.
 *
 * `unwrapEnvelope` mirrors the package's `View`: the item's `data(id)` payload is an
 * envelope `{ data, errors }`, and Form expects the UNWRAPPED inner data. Without
 * this, Form receives the envelope, sees no `type`/`interaction`, and renders raw
 * JSON instead of the chart/spreadsheet.
 */
function entrySource(pkg, formModel = "live") {
  return `
import { createElement, Fragment, useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckBar } from "@graffiticode/l0000-view";
import * as lang from ${JSON.stringify(pkg)};
import css from ${JSON.stringify(pkg + "/style.css")};

// The generic half of l0000-view's reducer. \`focus\` is a named field rather than a
// merge; every other action merges. Unknown types merge too — l0000 logs and drops
// them, but a dropped action here is a click that does nothing, and merging is the
// behaviour this build already had for them.
const Form = lang.Form;
// Namespace access rather than a named import: most packages export no \`reduce\`, and a
// named import of a missing export is a build error.
const langReduce = lang["reduce"];
const langScore = lang["score"];
const reducer = (data, action) => {
  const claimed = typeof langReduce === "function" ? langReduce(data, action) : undefined;
  if (claimed !== undefined) return claimed;
  const { type, args } = action;
  switch (type) {
    case "init": return { ...args };
    case "focus": return { ...data, focus: args };
    default: return { ...data, ...args };
  }
};

// Same shape check the package's View uses (view.jsx unwrapEnvelope).
function unwrapEnvelope(resp) {
  if (resp && typeof resp === "object" && !Array.isArray(resp) && ("data" in resp || "errors" in resp)) {
    return { data: resp.data, errors: Array.isArray(resp.errors) ? resp.errors : [] };
  }
  return { data: resp, errors: [] };
}

// Counts the learner's real changes, which is what clears a check.
const CHANGES = new Set(["update", "response"]);
// l0000-view's \`formModel\` (see src/widget/languages.ts): under "loaded" the Form keeps
// rendering the model it was mounted with, while edits still update the live model that
// scoring reads. The widget's only external load is the mount itself.
// The package's own export wins (l0179-view >= 0.3.4 declares it); the registry entry is the
// fallback for a package that predates the export.
const FORM_MODEL = lang["formModel"] === "loaded" || lang["formModel"] === "live"
  ? lang["formModel"]
  : ${JSON.stringify(formModel)};

// Structural equality, as l0000-view's View uses it: an action that changes nothing must
// return the SAME state, or every caret move hands the Form a new model identity — which
// an uncontrolled Form like L0179's grid reads as "re-seed", and a re-seed reports the
// caret move again.
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length &&
    ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};

const tracked = (prev, action) => {
  const data = reducer(prev.data, action);
  if (data === prev.data || deepEqual(data, prev.data)) return prev;
  return {
    data,
    renderData: FORM_MODEL === "live" || action.type === "init" ? data : prev.renderData,
    changes: prev.changes + (CHANGES.has(action.type) ? 1 : 0),
  };
};

// \`apply\` is the useReducer dispatch, exactly as in l0000-view's View — that is what
// makes the controlled Forms re-render, and with them score.
function Root({ initialData, errors }) {
  const [{ data, renderData, changes }, apply] = useReducer(tracked, {
    data: initialData,
    renderData: initialData,
    changes: 0,
  });
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [changes]);
  // Scored from the live model, which under "loaded" is not what the Form renders.
  const result = useMemo(
    () => (typeof langScore === "function" && errors.length === 0 ? langScore(data) : undefined),
    [data, errors],
  );
  const shown = checked && result ? { ...renderData, showValidationUI: true } : renderData;
  const state = useMemo(() => ({ data: shown, errors, apply }), [shown, errors]);
  const form = createElement(Form, { state });
  if (!result) return form;
  return createElement(
    Fragment,
    null,
    form,
    createElement(CheckBar, { result, checked, onToggle: () => setChecked((c) => !c) }),
  );
}

export const styles = css;

export function mount(el, raw) {
  const { data, errors } = unwrapEnvelope(raw);
  createRoot(el).render(createElement(Root, { initialData: data ?? {}, errors }));
}
`;
}

/**
 * Keep only the woff2 source of an inlined `@font-face`.
 *
 * A view built in Vite library mode inlines every font it references, and KaTeX declares each
 * face three times (woff2, woff, ttf). A browser uses the first format it supports, and every
 * browser the hosts run in supports woff2, so the other two are never used — but the widget
 * imports the stylesheet as a string, so all of it is shipped and parsed before anything draws.
 * For L0159 and L0181 that was 1.09 MB of their ~1.47 MB stylesheets. A face with no woff2
 * source is left alone.
 */
export function woff2Only(css) {
  // A source is `url(...) format(...)`; a data URL holds `;` but never `)`, so match whole
  // sources rather than splitting the declaration on `;`.
  const SOURCE = /url\([^)]*\)\s*format\(["']([\w-]+)["']\)/g;
  return css.replace(new RegExp(`src:(?:${SOURCE.source}\\s*,?\\s*)+`, "g"), (decl) => {
    const woff2 = [...decl.matchAll(SOURCE)].filter((m) => m[1] === "woff2").map((m) => m[0]);
    return woff2.length ? `src:${woff2.join(",")}` : decl;
  });
}

const WOFF2_ONLY = {
  name: "woff2-only",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => ({
      contents: woff2Only(await readFile(args.path, "utf8")),
      loader: "text",
    }));
  },
};

await mkdir("dist/widget/lang", { recursive: true });

await Promise.all(
  NATIVE_LANGUAGES.map(({ id, pkg, formModel }) =>
    build({
      ...SHARED,
      stdin: {
        contents: entrySource(pkg, formModel),
        resolveDir: process.cwd(),
        sourcefile: `${id}-entry.js`,
        loader: "js",
      },
      outfile: `dist/widget/lang/${id}.mjs`,
      format: "esm",
      loader: { ".css": "text" },
      plugins: [WOFF2_ONLY],
      define: { "process.env.NODE_ENV": '"production"' },
    }).then(() => console.log(`Bundled dist/widget/lang/${id}.mjs`))
  )
);

/**
 * Language bundles ship woff2 fonts only. `scripts/build-widget.mjs` strips the woff and ttf
 * fallbacks a Vite library build inlines (KaTeX in L0159 and L0181: 1.09 MB no browser used).
 * Asserted on the built bundles, since that is what a host loads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "dist/widget/lang";

test("no language bundle inlines a woff or ttf font", () => {
  const bundles = readdirSync(DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(bundles.length > 0, "no bundles built");
  for (const f of bundles) {
    const js = readFileSync(`${DIR}/${f}`, "utf8");
    assert.doesNotMatch(js, /data:font\/(woff|ttf|otf);/, `${f} still inlines a non-woff2 font`);
  }
});

test("the KaTeX faces keep their woff2 source", () => {
  const js = readFileSync(`${DIR}/L0181.mjs`, "utf8");
  assert.equal(js.match(/data:font\/woff2;/g)?.length, 20);
});

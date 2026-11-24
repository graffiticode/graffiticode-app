import { test } from "node:test";
import assert from "node:assert/strict";
import { withCompiledData } from "../src/lib/spec-generation-service.js";

const SRC = "author-embed …..";
const BAR_CHART = "24f76ba0-24af-4be4-aacf-c31c6efd33e3";

test("a dialect that derives nothing gets a byte-identical prompt", () => {
  assert.equal(withCompiledData(SRC, { title: "x" }), SRC);
  assert.equal(withCompiledData(SRC, undefined), SRC);
});

test("the paths block is unchanged", () => {
  const out = withCompiledData(SRC, { paths: { a: "config.a" } });
  assert.equal(out, `${SRC}\n\n<COMPILED_PATHS>\nThe compiler resolved each config key this design sets to its exact destination path. These are authoritative — reproduce them verbatim and never derive a path from a property name.\n${JSON.stringify({ a: "config.a" }, null, 2)}\n`);
});

// The reproduction: allow-templates [BAR-CHART] compiled, but its reference never reached the prompt.
test("the resolved picker, with its template references, reaches the prompt", () => {
  const compiled = {
    complete: true,
    warnings: [],
    paths: { "question-type-groups": "config.dependencies.question_editor_api.init_options.question_type_groups" },
    group_defaults: false,
    question_type_groups: [{ reference: "chart", name: "Charts", template_references: [BAR_CHART] }],
    picker_templates: [{ reference: BAR_CHART, name: "Bar chart", type: "simplechart", group: "chart" }],
  };
  const out = withCompiledData(SRC, compiled);
  assert.match(out, /<COMPILED_PICKER>/);
  assert.ok(out.includes(BAR_CHART));
  assert.ok(out.includes('"group_defaults": false'));
  assert.ok(out.includes("Bar chart"));
  assert.doesNotMatch(out, /<COMPILED_HOLES>/);
});

test("an incomplete design carries its holes, and no picker it did not emit", () => {
  const hole = "The question-picker restriction is unsatisfiable: …";
  const out = withCompiledData(SRC, { complete: false, warnings: [hole], paths: {} });
  assert.match(out, /<COMPILED_HOLES>/);
  assert.ok(out.includes(hole));
  assert.doesNotMatch(out, /<COMPILED_PICKER>/);
});

test("warnings of a complete design are not presented as holes", () => {
  assert.equal(withCompiledData(SRC, { complete: true, warnings: ["No item bank specified"] }), SRC);
});

test("a directive that reads compiled blocks needs compiled data", async () => {
  const { directiveNeedsCompiledData, SpecDataUnavailableError } = await import("../src/lib/spec-generation-service.js");
  assert.equal(directiveNeedsCompiledData("Copy from the `<COMPILED_PICKER>` block."), true);
  assert.equal(directiveNeedsCompiledData("Describe the content."), false);
  assert.equal(directiveNeedsCompiledData(null), false);
  const err = new SpecDataUnavailableError("0177", "t1");
  assert.equal(err.retryable, true);
  assert.equal(err.code, "SPEC_DATA_UNAVAILABLE");
  assert.match(err.message, /retry get_spec/);
});

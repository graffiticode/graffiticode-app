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

// --- generateSpec / getSpec with mocked dependencies: a failed or missing compile must stop
// generation before the model call, and nothing may be cached. ---
import { generateSpec, SPEC_DEPS, SpecCompileFailedError, SpecDataUnavailableError as Unavailable, compiledFailure } from "../src/lib/spec-generation-service.js";
import { getSpec, GET_SPEC_DEPS } from "../src/spec.js";

const DIRECTIVE = "Copy from the `<COMPILED_PICKER>` block.";
const ENVELOPE = { data: null, errors: [{ message: "Error: stage 0's compiler didn't answer", code: "compile-response-lost" }] };

function mocked(compiled: any) {
  const calls = { model: 0 };
  const deps: typeof SPEC_DEPS = {
    ...SPEC_DEPS,
    getApiTask: (async () => ({ lang: "0177", code: {} })) as any,
    getApiData: (async () => compiled) as any,
    getLanguageLexicon: (async () => ({})) as any,
    getLanguageHints: (async () => ({})) as any,
    readDialectInstructions: (async () => "instructions") as any,
    getLanguageSpecDirective: (async () => DIRECTIVE) as any,
    callClaudeForSpec: (async () => { calls.model++; return { content: "an unrestricted recipe" }; }) as any,
    anthropicCredentialsConfigured: (() => true) as any,
  };
  return { deps, calls };
}

test("a failed compile envelope is recognised, with its diagnostics", () => {
  assert.deepEqual(compiledFailure(ENVELOPE), ENVELOPE.errors);
  assert.deepEqual(compiledFailure({ data: null }), ["the compile returned no data"]);
  assert.equal(compiledFailure({ group_defaults: false, warnings: [] }), null);
});

test("generateSpec rejects a failed compile envelope before calling the model", async () => {
  const { deps, calls } = mocked(ENVELOPE);
  await assert.rejects(generateSpec({ auth: {}, taskId: "t1" }, deps), (err: any) => {
    assert.ok(err instanceof SpecCompileFailedError);
    assert.equal(err.code, "SPEC_COMPILE_FAILED");
    assert.deepEqual(err.diagnostics, ENVELOPE.errors);
    assert.match(err.message, /compiler didn't answer/);
    return true;
  });
  assert.equal(calls.model, 0);
});

test("generateSpec rejects missing compiled data before calling the model", async () => {
  const { deps, calls } = mocked(null);
  await assert.rejects(generateSpec({ auth: {}, taskId: "t1" }, deps), (err: any) => err instanceof Unavailable && err.retryable === true);
  assert.equal(calls.model, 0);
});

test("generateSpec proceeds with a good compile, and the picker reaches the model", async () => {
  const compiled = { complete: true, warnings: [], group_defaults: false, question_type_groups: [{ reference: "chart", name: "Charts", template_references: [BAR_CHART] }] };
  const { deps, calls } = mocked(compiled);
  let user = "";
  deps.callClaudeForSpec = (async (args: any) => { calls.model++; user = args.user; return { content: "recipe" }; }) as any;
  const out = await generateSpec({ auth: {}, taskId: "t1" }, deps);
  assert.equal(out.spec, "recipe");
  assert.equal(calls.model, 1);
  assert.ok(user.includes(BAR_CHART));
});

for (const [label, compiled] of [["failed envelope", ENVELOPE], ["missing data", null]] as const) {
  test(`getSpec neither generates nor caches on a ${label}`, async () => {
    const { deps, calls } = mocked(compiled);
    let cached = 0;
    await assert.rejects(getSpec({ auth: {}, id: "item-1" }, {
      ...GET_SPEC_DEPS,
      getItem: (async () => ({ taskId: "t1" })) as any,
      generateSpec: ((args: any) => generateSpec(args, deps)) as any,
      cacheSpec: (async () => { cached++; }) as any,
    }));
    assert.equal(calls.model, 0);
    assert.equal(cached, 0);
  });
}

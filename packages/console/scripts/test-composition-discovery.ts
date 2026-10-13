// Verifies the AST-walk logic in src/lib/composition-discovery.ts using
// hand-built nodePools. The walker is pure scan-only now — schema fetching
// happens in the basis runtime at compile time.
// Run: npx tsx scripts/test-composition-discovery.ts

import { resolveUpstreams } from "../src/lib/composition-discovery";

let failures = 0;
function assertEqual(label: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}\n    expected: ${e}\n    got:      ${a}`);
  }
}

async function assertThrows(label: string, fn: () => Promise<any>, messageSubstring: string) {
  try {
    await fn();
    failures++;
    console.log(`  ✗ ${label}: expected throw, got success`);
  } catch (e: any) {
    if (String(e.message).includes(messageSubstring)) {
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.log(`  ✗ ${label}: wrong error\n    expected substring: ${messageSubstring}\n    got: ${e.message}`);
    }
  }
}

async function main() {
  console.log("\nresolveUpstreams");

  // 1: empty pool
  {
    const result = await resolveUpstreams({ root: 1, "1": { tag: "PROG", elts: [] } });
    assertEqual("empty pool returns no upstreams", result.upstreams, []);
  }

  // 2: data {} no upstream hint
  {
    const pool = {
      root: 5,
      "1": { tag: "RECORD", elts: [] },
      "2": { tag: "DATA", elts: [1] },
      "5": { tag: "EXPRS", elts: [2] },
    };
    const result = await resolveUpstreams(pool);
    assertEqual("data {} produces no upstream", result.upstreams, []);
    assertEqual("data {} ast unchanged", result.ast["2"], pool["2"]);
  }

  // 3: single data use "0166"
  {
    const pool = {
      root: 10,
      "3": { tag: "STR", elts: ["0166"] },
      "5": { tag: "USE", elts: [3] },
      "7": { tag: "DATA", elts: [5] },
      "9": { tag: "EXPRS", elts: [7] },
      "10": { tag: "PROG", elts: [9] },
    };
    const result = await resolveUpstreams(pool);
    assertEqual("single use → ['0166']", result.upstreams, ["0166"]);
    assertEqual("STR child untouched (still lang id)", result.ast["3"].elts[0], "0166");
    assertEqual("USE node untouched", result.ast["5"], pool["5"]);
    assertEqual("DATA node untouched", result.ast["7"], pool["7"]);
  }

  // 4: two data use calls preserve scan order
  {
    const pool: any = {
      root: 20,
      "1": { tag: "STR", elts: ["0167"] },
      "2": { tag: "USE", elts: [1] },
      "3": { tag: "DATA", elts: [2] },
      "4": { tag: "STR", elts: ["0159"] },
      "5": { tag: "USE", elts: [4] },
      "6": { tag: "DATA", elts: [5] },
      "20": { tag: "EXPRS", elts: [3, 6] },
    };
    const result = await resolveUpstreams(pool);
    assertEqual("two uses → ['0167','0159']", result.upstreams, ["0167", "0159"]);
    assertEqual("first STR untouched", result.ast["1"].elts[0], "0167");
    assertEqual("second STR untouched", result.ast["4"].elts[0], "0159");
  }

  // 5: invalid lang id → error
  {
    const pool = {
      root: 10,
      "3": { tag: "STR", elts: ["not-a-lang"] },
      "5": { tag: "USE", elts: [3] },
      "7": { tag: "DATA", elts: [5] },
      "10": { tag: "EXPRS", elts: [7] },
    };
    await assertThrows(
      "invalid lang id → error",
      () => resolveUpstreams(pool),
      "must be a language id"
    );
  }

  // 6: use without surrounding data → ignored
  {
    const pool = {
      root: 10,
      "3": { tag: "STR", elts: ["0166"] },
      "5": { tag: "USE", elts: [3] },
      "10": { tag: "EXPRS", elts: [5] },
    };
    const result = await resolveUpstreams(pool);
    assertEqual("USE without DATA parent is ignored", result.upstreams, []);
  }

  console.log(failures === 0 ? "\nAll tests passed.\n" : `\n${failures} test(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

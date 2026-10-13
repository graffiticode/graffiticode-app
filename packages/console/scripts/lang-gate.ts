/**
 * Run a language's corpus gate on the examples about to be embedded.
 *
 * WHY THIS EXISTS. Whatever reaches training_examples is retrieved by every later generation, so a
 * bad example teaches its mistake to everything after it. A language can ship a gate — an npm
 * script named `check-corpus` that compiles each program and checks what it draws (L0186: lines
 * through other nodes, waypoints inside nodes, lines that double back). Run by hand it was
 * skipped as easily as remembered; the embedding script now runs it on exactly the rows it is
 * about to write, and writes nothing when it fails.
 *
 * WHERE THE GATE IS. In the language's checkout beside this one: the monorepo layout
 * (`../../graffiticode/languages/l{lang}`) first, then the old sibling-repo layout
 * (`../../l{lang}`). A language without a `check-corpus` script has no gate and passes through.
 * The gate compiles with the language's built code, so build the language first; a gate that
 * cannot run counts as a failure, never a pass.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where a language's checkout may be, in order. */
export function gateDirs(langCode: string): string[] {
  return [
    path.resolve(__dirname, `../../graffiticode/languages/l${langCode}`),
    path.resolve(__dirname, `../../l${langCode}`),
  ];
}

/** The checkout whose package.json has a `check-corpus` script, or null when the language has no gate. */
export function findCorpusGate(langCode: string): string | null {
  for (const dir of gateDirs(langCode)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.scripts?.["check-corpus"]) return dir;
    } catch {
      // not this one
    }
  }
  return null;
}

export interface GateResult {
  /** True when the gate ran and every program passed. */
  ok: boolean;
  /** The gate's own report (stdout + stderr). */
  output: string;
  dir: string;
}

/**
 * Run the gate in `dir` on `examples` (each `{ label, code }`). The examples go to a temp file in
 * the `[{n, code}]` form the gate reads; the file is removed afterwards.
 */
export function runCorpusGate(dir: string, examples: { label: string; code: string }[]): GateResult {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-gate-")), "examples.json");
  fs.writeFileSync(file, JSON.stringify(examples.map((e) => ({ n: e.label, code: e.code }))));
  try {
    const r = spawnSync("npm", ["run", "-s", "check-corpus", "--", file, "--quiet"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
    return { ok: r.status === 0, output, dir };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

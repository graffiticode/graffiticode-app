/**
 * Load an API route's real source with stand-in dependencies, for tests at
 * the route boundary. The route is transpiled as written; every module it
 * imports must be supplied, so an unexpected import fails loudly.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ts = createRequire(path.join(consoleRoot, 'package.json'))('typescript');

export function loadRoute(relPath: string, deps: Record<string, unknown>, env: Record<string, string> = {}) {
  const source = readFileSync(path.join(consoleRoot, relPath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} as any };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    new Function('require', 'module', 'exports', js)((name: string) => {
      if (!(name in deps)) throw new Error(`${relPath} imports ${name}, which the test didn't supply`);
      return deps[name];
    }, mod, mod.exports);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return mod.exports.default as (req: any, res: any) => Promise<unknown>;
}

/** A response recorder. */
export function response() {
  const res: any = { code: 0, body: undefined as any };
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res as { code: number; body: any; status(code: number): any; json(body: unknown): any };
}

/** A Firestore stand-in with one users document, recording updates. */
export function fakeUsersDb(user: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const doc = {
    get: async () => ({ exists: true, data: () => user }),
    update: async (u: Record<string, unknown>) => { updates.push(u); },
    set: async (u: Record<string, unknown>) => { updates.push(u); },
  };
  return { db: { collection: () => ({ doc: () => doc }) }, updates };
}

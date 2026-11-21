// Browser code takes its installation settings from /api/config only
// (installations plan, P3, slice 2). A build-time NEXT_PUBLIC_* value would
// bake one installation into a bundle every installation shares, a built-in
// host would point any installation at Graffiticode's services, and core's
// built-in catalog and plan terms know nothing of the installation's policy.
//
// Checked over the browser's module graph, not over directories: from every
// page route (the console's pages and the app's routes, other than API
// routes), through every value import (relative, "@/", core, auth-react,
// dynamic import()), into core. A module only API routes or servers reach
// isn't browser code; one a page reaches is, wherever it lives. In the app
// (App Router), a module is browser code from its "use client" boundary on:
// a server component (a layout without the directive) isn't, but the client
// modules it imports are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const PACKAGES = new URL('../../..', import.meta.url).pathname;
const at = (p: string) => join(PACKAGES, p);

const ENTRY_DIRS = ['console/src/pages', 'app/src/app'];
const NOT_BROWSER = /\/pages\/api\/|\/app\/api\/|\/server\/|\.(test|spec)\.|instrumentation\.ts$|\/_document\.tsx$/;

// What remains, and why each is allowed. Everything else must come from
// /api/config.
const ALLOWED: Record<string, { hosts?: string; nextPublic?: string }> = {
  // This build's own copy, shown only without a profile (InstallationCopy).
  'console/src/components/AboutCopy.tsx': { hosts: "the built-in about page, shown only without a profile" },
  // The server resolver's built-in hosts, and the server's firebase key. In a
  // browser, configFromEnv refuses before reaching either (config.ts).
  'core/src/profile/hosts.ts': { hosts: 'server resolver defaults; unreachable in a browser' },
  'core/src/config.ts': { nextPublic: 'server-side firebase key; unreachable in a browser' },
};

// The core modules browser code may import. A new one is a review: it must
// take hosts only from coreConfig() (which a browser configures from
// /api/config) and carry no built-in installation values.
const CORE_FOR_BROWSER = new Set([
  'core/src/config.ts',
  'core/src/lib/api.ts',
  'core/src/lib/connectable.ts',
  'core/src/lib/write-errors.ts',
  'core/src/profile/public-config.ts',
]);

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');

function* files(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(at(dir)); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(at(p)).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(e)) yield p;
  }
}

function resolveFile(base: string): string | null {
  const noJs = base.replace(/\.js$/, '');
  for (const c of [base, `${noJs}.ts`, `${noJs}.tsx`, join(noJs, 'index.ts'), join(noJs, 'index.tsx')]) {
    if (/\.(ts|tsx)$/.test(c) && existsSync(at(c)) && statSync(at(c)).isFile()) return c;
  }
  return null;
}

// The module a specifier names, as a path under packages/, or null for a
// package outside this repo (react, firebase, ...).
function resolve(from: string, spec: string): string | null {
  const pkg = from.split('/')[0];
  if (spec.startsWith('.')) return resolveFile(join(dirname(from), spec));
  if (spec.startsWith('@/')) return resolveFile(join(pkg, 'src', spec.slice(2)));
  if (spec.startsWith('@graffiticode-app/core/')) return resolveFile(join('core/src', spec.slice('@graffiticode-app/core/'.length)));
  if (spec === '@graffiticode/auth-react') return 'auth-react/src/index.ts';
  if (spec === '@graffiticode/auth-react/server') return 'auth-react/src/server/index.ts';
  return null;
}

// Value imports only: `import type` and `export type` are erased.
function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2]);
  return out;
}

const isClientBoundary = (p: string) => /^\s*['"]use client['"]/.test(readFileSync(at(p), 'utf8'));
// Pages Router pages are all browser code; App Router modules from "use client" on.
const isBrowserEntry = (p: string) => p.startsWith('console/') || isClientBoundary(p);

const entries = ENTRY_DIRS.flatMap(d => [...files(d)]).filter(p => !NOT_BROWSER.test(`/${p}`));
const reached = new Set<string>();
const serverSeen = new Set<string>();
const importsOf = new Map<string, string[]>();
const queue: [string, boolean][] = entries.map(p => [p, isBrowserEntry(p)]);
while (queue.length) {
  const [p, browser] = queue.pop()!;
  if (NOT_BROWSER.test(`/${p}`)) continue;
  const deps = () => valueImports(stripComments(readFileSync(at(p), 'utf8')))
    .map(s => resolve(p, s)).filter((x): x is string => !!x);
  if (browser) {
    if (reached.has(p)) continue;
    reached.add(p);
    const d = deps();
    importsOf.set(p, d);
    queue.push(...d.map(x => [x, true] as [string, boolean]));
  } else {
    // A server component: not browser code, but a client module it imports is.
    if (serverSeen.has(p)) continue;
    serverSeen.add(p);
    queue.push(...deps().map(x => [x, isClientBoundary(x)] as [string, boolean]));
  }
}
const browserModules = [...reached].sort();
const importersOf = (p: string) => [...importsOf].filter(([, d]) => d.includes(p)).map(([f]) => f);
// BROWSER_GRAPH_WHY=<path>,... prints what reaches a module, for diagnosis.
if (process.env.BROWSER_GRAPH_WHY) {
  for (const p of process.env.BROWSER_GRAPH_WHY.split(',')) console.log(`${p} <- ${importersOf(p).join(', ')}`);
}
const source = (p: string) => stripComments(readFileSync(at(p), 'utf8'));

test("the browser's module graph is found, into core", () => {
  assert.ok(browserModules.length > 80, `only ${browserModules.length} modules`);
  for (const p of ['console/src/pages/_app.tsx', 'console/src/pages/specs/[id].tsx', 'console/src/components/gallery.tsx', 'console/src/lib/catalog.ts', 'app/src/components/FormHarness.tsx', 'auth-react/src/AuthProviders.tsx', 'core/src/lib/api.ts', 'core/src/config.ts']) {
    assert.ok(reached.has(p), `${p} isn't reached`);
  }
  assert.ok(!browserModules.some(p => p.includes('/pages/api/')), 'API routes are not browser code');
  assert.ok(!reached.has('core/src/profile/brand.ts'), "the built-in brand isn't browser code");
  // App Router server components aren't browser code; the client modules they render are.
  assert.ok(!reached.has('app/src/app/layout.tsx') && reached.has('app/src/app/providers.tsx'));
  assert.ok(!reached.has('app/src/app/form/[id]/layout.tsx'), 'the per-item metadata is rendered on the server');
});

test('browser code imports only the reviewed core modules', () => {
  const direct = new Set<string>();
  for (const [from, deps] of importsOf) {
    if (from.startsWith('core/')) continue;
    for (const d of deps) if (d.startsWith('core/')) direct.add(d);
  }
  assert.deepEqual([...direct].filter(p => !CORE_FOR_BROWSER.has(p)).sort(), []);
});

test('no browser module reads a build-time NEXT_PUBLIC_* value', () => {
  const offenders = browserModules.filter(p => !ALLOWED[p]?.nextPublic && /process\.env\.NEXT_PUBLIC_/.test(source(p)));
  assert.deepEqual(offenders, []);
});

test("no browser module names a built-in installation's host, however it is written", () => {
  // Bare, schemed or interpolated (`https://l${id}.graffiticode.org`), and the
  // built-in storage bucket.
  // Escaped dots too (a regex: graffiticode\.org).
  const HOST = /graffiticode\.(org|com)\b|graffiticode\.appspot\.com/;
  const offenders = browserModules.filter(p => !ALLOWED[p]?.hosts && HOST.test(source(p).replace(/\\\./g, '.')));
  assert.deepEqual(offenders, []);
});

test("no browser module uses core's built-in catalog or plan terms", () => {
  for (const p of ['core/src/lib/languages.ts', 'core/src/lib/plans-config.ts']) {
    assert.ok(!reached.has(p), `${p} is reachable from browser code: ${[...importsOf].filter(([, d]) => d.includes(p)).map(([f]) => f).join(', ')}`);
  }
});

test('every allowance is still needed and still browser code', () => {
  for (const p of Object.keys(ALLOWED)) assert.ok(reached.has(p), `${p} is no longer browser code; drop its allowance`);
});

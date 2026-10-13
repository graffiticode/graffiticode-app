import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, resolve } from 'path';

// Publishes Graffiticode language packages to npm. Handles both fleet layouts:
//   legacy:  packages/app  -> @graffiticode/lXXXX        (React component, has ./style.css)
//   future:  packages/core -> @graffiticode/lXXXX        (logic + spec, no style.css)
//            packages/view -> @graffiticode/lXXXX-view   (React component, has ./style.css)
//            packages/api  -> @graffiticode/api-lXXXX    (private — never published)
//
// Language repos are expected as siblings of this repo (../lXXXX), matching
// upgrade-l0000-and-deploy.ts. Every publish uses `--access public` so a scoped
// package never lands restricted (which would 404 for anonymous installers).
//
// DRY RUN BY DEFAULT — pass --publish to actually publish.
//
//   npx tsx scripts/publish-language-packages.ts                  # dry-run, all sibling l0* repos
//   npx tsx scripts/publish-language-packages.ts --lang l0003 l0174
//   npx tsx scripts/publish-language-packages.ts --publish        # for real
//   flags: --skip-install  --skip-build  --verbose

const BASE_DIR = resolve(process.cwd(), '..');
const DO_PUBLISH = process.argv.includes('--publish');
const SKIP_INSTALL = process.argv.includes('--skip-install');
const SKIP_BUILD = process.argv.includes('--skip-build');
const VERBOSE = process.argv.includes('--verbose');

function parseLangs(): Set<string> | null {
  const idx = process.argv.indexOf('--lang');
  if (idx === -1) return null;
  const langs: string[] = [];
  for (let i = idx + 1; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    langs.push(process.argv[i].toLowerCase().replace(/^(l?)(\d+)$/, (_, _l, n) => 'l' + n));
  }
  return langs.length ? new Set(langs) : null;
}

function run(cmd: string, cwd: string, timeoutMs = 15 * 60 * 1000): Promise<string> {
  return new Promise((res, rej) => {
    const stdio = VERBOSE ? ('inherit' as const) : ('pipe' as const);
    const child = spawn('bash', ['-c', cmd], { cwd, stdio });
    const timer = setTimeout(() => { child.kill(); rej(new Error('Timed out')); }, timeoutMs);
    let out = '';
    if (!VERBOSE) {
      child.stdout?.on('data', d => (out += d));
      child.stderr?.on('data', d => (out += d));
    }
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) rej(new Error(out.slice(-800) || `Exit code ${code}`));
      else res(out);
    });
  });
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

interface Pub { repo: string; dir: string; ws: string; role: string; name: string; version: string; deps: string[]; }

// A package is publishable if it is scoped @graffiticode/*, not private, and
// (for the component packages) ships a build + dist. We deliberately skip
// packages/api (@graffiticode/api-*, private:true) and the private repo root.
function publishablesFor(dir: string): Pub[] {
  const repo = basename(dir);
  const out: Pub[] = [];
  const consider = (ws: string, role: string) => {
    const pj = resolve(dir, ws, 'package.json');
    if (!existsSync(pj)) return;
    let p: any;
    try { p = readJson(pj); } catch { return; }
    if (p.private === true) return;
    if (typeof p.name !== 'string' || !p.name.startsWith('@graffiticode/')) return;
    if (!p.scripts?.build) { console.warn(`  ! ${repo}/${ws}: ${p.name} has no build script — skipping`); return; }
    const deps = Object.keys(p.dependencies || {}).filter(d => d.startsWith('@graffiticode/') && !/\/(auth|tracing)/.test(d));
    out.push({ repo, dir, ws, role, name: p.name, version: p.version, deps });
  };
  if (existsSync(resolve(dir, 'packages/app/package.json'))) {
    consider('packages/app', 'component');
  } else {
    consider('packages/core', 'core');
    consider('packages/view', 'view');
  }
  return out;
}

function findRepos(langs: Set<string> | null): string[] {
  return readdirSync(BASE_DIR)
    .filter(n => /^l0\d{3}$/.test(n))
    .filter(n => !langs || langs.has(n))
    .map(n => resolve(BASE_DIR, n))
    .filter(d => existsSync(resolve(d, 'package.json')))
    .sort();
}

// Topologically order so an in-set dependency (e.g. a base language) publishes
// before its dependents. Tiebreak: core/component before view, then repo name.
function order(pubs: Pub[]): Pub[] {
  const byName = new Map(pubs.map(p => [p.name, p]));
  const indeg = new Map(pubs.map(p => [p.name, 0]));
  const adj = new Map<string, string[]>(pubs.map(p => [p.name, []]));
  for (const p of pubs) for (const d of p.deps) if (byName.has(d)) {
    adj.get(d)!.push(p.name);
    indeg.set(p.name, indeg.get(p.name)! + 1);
  }
  const rank = (ws: string) => (ws.endsWith('view') ? 1 : 0);
  const cmp = (a: string, b: string) => {
    const pa = byName.get(a)!, pb = byName.get(b)!;
    return pa.repo !== pb.repo ? pa.repo.localeCompare(pb.repo) : rank(pa.ws) - rank(pb.ws);
  };
  const q = [...indeg].filter(([, d]) => d === 0).map(([n]) => n).sort(cmp);
  const out: Pub[] = [];
  while (q.length) {
    const n = q.shift()!;
    out.push(byName.get(n)!);
    for (const m of adj.get(n)!) { indeg.set(m, indeg.get(m)! - 1); if (indeg.get(m) === 0) q.push(m); }
    q.sort(cmp);
  }
  for (const p of pubs) if (!out.includes(p)) out.push(p); // cycle fallback (shouldn't happen)
  return out;
}

async function publishedVersions(name: string): Promise<Set<string>> {
  try {
    const out = await run(`npm view ${name} versions --json 2>/dev/null || echo "[]"`, BASE_DIR, 60_000);
    const v = JSON.parse(out.trim() || '[]');
    return new Set(Array.isArray(v) ? v : [v]);
  } catch { return new Set(); }
}

async function main() {
  const langs = parseLangs();
  const repos = findRepos(langs);
  if (!repos.length) { console.error(`No l0* sibling repos found under ${BASE_DIR}${langs ? ` matching ${[...langs].join(', ')}` : ''}.`); process.exit(1); }

  const pubs = order(repos.flatMap(publishablesFor));
  console.log(`\n${DO_PUBLISH ? 'PUBLISH' : 'DRY RUN'} — ${pubs.length} package(s) across ${repos.length} repo(s)\n`);
  for (const p of pubs) console.log(`  ${p.name}@${p.version}  (${p.repo}/${p.ws})${p.deps.length ? '  deps: ' + p.deps.join(', ') : ''}`);
  console.log('');

  const results: { name: string; version: string; status: string; error?: string }[] = [];
  const built = new Set<string>();

  for (const p of pubs) {
    const tag = `${p.name}@${p.version}`;
    try {
      if ((await publishedVersions(p.name)).has(p.version)) {
        console.log(`= ${tag} already on npm — skip`);
        results.push({ name: p.name, version: p.version, status: 'skipped (already published)' });
        continue;
      }
      if (!SKIP_INSTALL) { console.log(`+ ${tag} installing…`); await run(`npm install -w ${p.ws}`, p.dir); }
      if (!SKIP_BUILD) { console.log(`+ ${tag} building…`); await run(`npm run build -w ${p.ws}`, p.dir); built.add(p.dir); }
      const dry = DO_PUBLISH ? '' : ' --dry-run';
      console.log(`+ ${tag} ${DO_PUBLISH ? 'publishing' : 'pack-checking'}…`);
      await run(`npm publish -w ${p.ws} --access public${dry}`, p.dir);
      results.push({ name: p.name, version: p.version, status: DO_PUBLISH ? 'PUBLISHED' : 'ok (dry-run)' });
    } catch (e: any) {
      console.error(`✗ ${tag}: ${e.message}`);
      results.push({ name: p.name, version: p.version, status: 'FAILED', error: e.message });
    }
  }

  console.log('\n── Summary ──');
  for (const r of results) console.log(`  ${r.status.padEnd(28)} ${r.name}@${r.version}`);
  const failed = results.filter(r => r.status === 'FAILED').length;
  if (!DO_PUBLISH) console.log('\nThis was a DRY RUN. Re-run with --publish to publish for real.');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });

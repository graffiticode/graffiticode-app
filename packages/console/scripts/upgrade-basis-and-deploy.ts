import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, resolve } from 'path';

const BATCH_SIZE = 5;
const FORCE_DEPLOY = !process.argv.includes('--no-force');
const VERBOSE = process.argv.includes('--verbose');
const BASE_DIR = resolve(process.cwd(), '..');

function parseLangs(): string[] | null {
  const idx = process.argv.indexOf('--lang');
  if (idx === -1) return null;
  const langs: string[] = [];
  for (let i = idx + 1; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    langs.push(process.argv[i].replace(/^l/i, ''));
  }
  return langs.length > 0 ? langs : null;
}
const LANGS = parseLangs();

function run(cmd: string, cwd: string, timeoutMs = 10 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    // ALWAYS pipe, and tee to our own streams when verbose. `stdio: 'inherit'` hands the
    // child our terminal directly, so nothing reaches the `data` handlers and `output`
    // resolves as the empty string. That is not merely a logging quirk: callers branch on
    // what they read back, and `git status --porcelain` returning '' reads as "clean". Under
    // --verbose the upgrade was therefore deployed but never committed or pushed, silently.
    const child = spawn('bash', ['-c', cmd], { cwd, stdio: 'pipe' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, timeoutMs);
    let output = '';
    child.stdout?.on('data', d => { output += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr?.on('data', d => { output += d; if (VERBOSE) process.stderr.write(d); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(output.slice(-500) || `Exit code ${code}`));
      else resolve(output);
    });
  });
}

function isDeprecated(dir: string): boolean {
  const pkg = readFileSync(resolve(dir, 'package.json'), 'utf-8');
  return /gcp:build.*deprecated/i.test(pkg);
}

function findRepos(): string[] {
  return readdirSync(BASE_DIR)
    .filter(name => /^l0\d{3}$/.test(name))
    .filter(name => !LANGS || LANGS.includes(name.slice(1)))
    .map(name => resolve(BASE_DIR, name))
    .filter(dir => {
      if (!existsSync(resolve(dir, 'packages/api/package.json'))) return false;
      if (!existsSync(resolve(dir, 'package.json'))) return false;
      const pkg = readFileSync(resolve(dir, 'package.json'), 'utf-8');
      if (!pkg.includes('"gcp:build"')) return false;
      // Skip repos that don't depend on @graffiticode/basis — nothing to upgrade
      // and `npm i basis@latest` would just add an unwanted dep.
      const apiPkg = readFileSync(resolve(dir, 'packages/api/package.json'), 'utf-8');
      return apiPkg.includes('"@graffiticode/basis"');
    })
    .sort();
}

async function upgradeAndDeploy(dir: string): Promise<{ name: string; ok: boolean; error?: string }> {
  const name = basename(dir);
  try {
    console.log(`[${name}] Starting upgrade + deploy...`);
    const apiDir = resolve(dir, 'packages/api');
    await run('npm i @graffiticode/basis@latest', apiDir);
    // Ensure graphql peer dep is present if graphql-request is used
    const apiPkg = readFileSync(resolve(apiDir, 'package.json'), 'utf-8');
    if (apiPkg.includes('graphql-request') && !apiPkg.includes('"graphql"')) {
      await run('npm i graphql', apiDir);
    }
    const status = await run('git status --porcelain', dir);
    if (status.trim()) {
      await run('git add -A && git commit -m "Upgrade basis to latest"', dir);
      await run('git push', dir);
      await run('npm run gcp:build', dir, 20 * 60 * 1000);
      console.log(`[${name}] Done`);
    } else if (FORCE_DEPLOY && !isDeprecated(dir)) {
      console.log(`[${name}] Already up to date, force deploying...`);
      await run('npm run gcp:build', dir, 20 * 60 * 1000);
      console.log(`[${name}] Done`);
    } else if (FORCE_DEPLOY) {
      console.log(`[${name}] Deprecated, skipping deploy`);
    } else {
      console.log(`[${name}] Already up to date, skipping deploy`);
    }
    return { name, ok: true };
  } catch (err: any) {
    console.error(`[${name}] FAILED`);
    return { name, ok: false, error: (err.message || '').slice(-500) };
  }
}

async function main() {
  const repos = findRepos();
  console.log(`Found ${repos.length} repos to upgrade`);
  repos.forEach(r => console.log(`  ${basename(r)}`));
  console.log('');

  const failed: { name: string; error?: string }[] = [];

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    console.log(`--- Batch: ${batch.map(d => basename(d)).join(' ')} ---`);

    const results = await Promise.all(batch.map(upgradeAndDeploy));
    for (const r of results) {
      if (!r.ok) failed.push(r);
    }
    console.log('');
  }

  if (failed.length > 0) {
    console.error(`FAILED (${failed.length}):`);
    for (const f of failed) {
      console.error(`  ${f.name}`);
      if (f.error) console.error(`    ${f.error.split('\n').slice(-3).join('\n    ')}`);
    }
    process.exit(1);
  } else {
    console.log(`All ${repos.length} repos upgraded and deployed successfully`);
  }
}

main();

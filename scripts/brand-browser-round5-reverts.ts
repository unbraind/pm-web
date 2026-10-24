/** Prove each fifth-round regression fails with only its reviewed behavior restored. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyBrowserTree } from './browser-build-tree.ts';

const output = process.env.BRAND_REVERT_EVIDENCE;
assert.ok(output, 'Set BRAND_REVERT_EVIDENCE to an external evidence directory');
await mkdir(output, { recursive: true });
const root = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-round5-revert-'));
const cases = [
  ['api', 'public/src/api.ts'], ['marker', 'public/src/edit-origin.ts'],
  ['observer', 'public/src/interactions.ts'], ['health', 'public/src/views/health.ts'],
  ['facets', 'public/styles.css'], ['header', 'public/src/views/items.ts'],
  ['disabled', 'public/styles.css'], ['surface', 'public/src/live-copy.ts'],
  ['copy', 'public/src/i18n/en.json'], ['contrast', 'scripts/brand-browser-contrast.ts'],
];
const originals = new Map<string, string>();
for (const target of new Set(cases.map(entry => entry[1]))) originals.set(target, await readFile(target, 'utf8'));
const receipts: { name: string; target: string; exit: number; failure: string }[] = [];
/** Restore one defective behavior while keeping its regression and all other fixes current. */
function restoreBehavior(name: string, file: string, source: string): string {
  if (name === 'marker') return source.replace('if (localEdits.get(key) === marker) localEdits.delete(key);', 'localEdits.delete(key);');
  if (name === 'health') return source.replace("else if (score < 80) scoreColor = 'var(--pm-graphite)';", "else if (score < 80) scoreColor = 'var(--pm-stamp)';");
  if (name === 'facets') return source.replace('.graph-preset-rail { display: flex; flex-wrap: wrap; }', '').replace('.graph-preset-btn { flex: 0 0 auto; height: auto; min-height: 34px; }', '').replace('.graph-preset-btn span, .graph-preset-btn strong { overflow: visible; text-overflow: clip; }', '');
  if (name === 'disabled') return source.replace('.btn[aria-disabled="true"] { background: transparent;', '.btn[aria-disabled="true"] { background: var(--pm-paper);');
  const old = spawnSync('git', ['show', `4bcc415:${file}`], { cwd: root, encoding: 'utf8' });
  if (old.status !== 0) throw new Error('Unable to load the review baseline');
  return old.stdout;
}
try {
  await copyBrowserTree(root, scratch);
  const selectedCases = cases.filter(([name]) => !process.env.BRAND_REVERT_CASES || process.env.BRAND_REVERT_CASES.split(',').includes(name));
  for (const [name, file] of selectedCases) {
    const source = originals.get(file);
    assert.ok(source, 'Every probe must have an original source');
    const reverted = restoreBehavior(name, file, source);
    assert.notEqual(reverted, source, `${name}: empty revert`);
    await writeFile(path.join(scratch, file), reverted);
    const build = spawnSync('npm', ['run', 'build:frontend'], { cwd: scratch, encoding: 'utf8' });
    assert.equal(build.status, 0, `${name}: build errors do not count\n${build.stdout}\n${build.stderr}`);
    const browser = ['observer', 'health', 'facets', 'header', 'disabled', 'contrast'].includes(name);
    const args = browser ? ['scripts/brand-browser.ts'] : ['--test', `test/${name === 'copy' ? 'brand-copy' : name === 'surface' ? 'live-copy' : 'frontend-api'}.test.ts`];
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 240000, env: {
      ...process.env, BRAND_QUICK: '1', BRAND_ACCEPTANCE: '0', BRAND_CAPTURE_ONLY: 'none',
      BRAND_REGRESSION_ONLY: `round5-${name}`, BRAND_SCREENSHOTS: path.join(output, name),
    } });
    assert.ok(!result.error, `${name}: process errors do not count`);
    const log = `${result.stdout}\n${result.stderr}`;
    await writeFile(path.join(output, `${name}.log`), log);
    assert.notEqual(result.status, 0, `${name}: defective behavior passed`);
    const failure = log.match(/AssertionError[^\n]*|locator\.waitFor:[^\n]*|Expected values[^\n]*|failed writes must[^\n]*/)?.[0];
    assert.ok(failure, `${name}: behavioral assertion required\n${log}`);
    receipts.push({ name, target: file, exit: result.status!, failure });
    await writeFile(path.join(output, 'revert-proofs.json'), JSON.stringify({ base: '4bcc41535bbfea7603204ba63f8c908418bed355', receipts }, null, 2));
    console.log(`Expected regression failure: ${name}: ${failure}`);
    await writeFile(path.join(scratch, file), source);
  }
  for (const [file, source] of originals) assert.equal(await readFile(path.join(root, file), 'utf8'), source, `Production source changed: ${file}`);
  await writeFile(path.join(output, 'revert-proofs.json'), JSON.stringify({ base: '4bcc41535bbfea7603204ba63f8c908418bed355', receipts, productionUnchanged: true }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }

/** Run independent fourth-round behavioral reverts in an isolated source copy. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyBrowserTree } from './browser-build-tree.ts';

const output = process.env.BRAND_REVERT_EVIDENCE;
if (!output) throw new Error('BRAND_REVERT_EVIDENCE must name an external evidence directory');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-round4-revert-'));
const root = process.cwd();
const cases = [
  ['locale', 'public/index.html'],
  ['drag', 'public/src/views/graph-canvas.ts'],
  ['settle-auto', 'public/src/views/graph-canvas.ts'],
  ['settle-fit', 'public/src/views/graph-canvas.ts'],
  ['palette-colors', 'public/src/views/graph-canvas.ts'],
  ['palette-tokens', 'public/src/brand.ts'],
  ['opacity', 'scripts/brand-browser-contrast.ts'],
  ['clears', 'src/routes/pm.ts'],
  ['sse', 'test/pm-collaboration.test.ts'],
];
const originals = new Map(await Promise.all([...new Set(cases.map(entry => entry[1]))].map(async file => [file, await readFile(file, 'utf8')] as const)));
const receipts: { name: string; failure: string }[] = [];
/** Restore exactly one reviewed behavior; fixtures and unrelated fixes stay current. */
function revert(name: string, source: string): string {
  if (name === 'locale') return source.replace('data-i18n-aria="nav.accountActions" ', '');
  if (name === 'drag') return source.replace(/      this.dragNode\.(?:x = wx|y = wy|vx = 0|vy = 0);\n/g, '');
  if (name === 'settle-auto') return source.replace("    } else {\n      this.reheat();\n    }\n\n    this.hoveredId", "    }\n\n    this.hoveredId");
  if (name === 'settle-fit') return source.replace('        this.fitInitialView();\n', '');
  if (name === 'palette-colors') return source.replace('if (this.colorRevision !== brandRevision()) this.recolorNodes();', 'this.recolorNodes();');
  if (name === 'palette-tokens') return source.replace('  const cached = resolved.get(token);\n  if (cached !== undefined) return cached;\n', '');
  if (name === 'opacity') {
    const old = spawnSync('git', ['show', '147ba52:scripts/brand-browser-contrast.ts'], { cwd: root, encoding: 'utf8' });
    assert.equal(old.status, 0); return old.stdout;
  }
  if (name === 'clears') return source.replace('(val !== "" || explicitClear)', '(val !== "")').replace('    const explicitClear = (key === "tags" || key === "description") && val === "";\n', '');
  if (name === 'sse') return source.replace('await observer.waitFor(events => events.some(event => event.type === "item-updated" && event.data.itemId === itemId && event.data.author === "Project member"));', 'await observer.waitFor(events => events.filter(event => event.type === "item-updated").length === 2);');
  throw new Error(`Unknown probe ${name}`);
}

try {
  await copyBrowserTree(root, scratch);
  for (const [name, file] of cases) {
    if (process.env.BRAND_REVERT_CASES && !process.env.BRAND_REVERT_CASES.split(',').includes(name)) continue;
    const source = originals.get(file)!;
    const reverted = revert(name, source);
    assert.notEqual(reverted, source, `${name}: revert did not change its target`);
    await writeFile(path.join(scratch, file), reverted);
    const browser = !['clears', 'sse'].includes(name);
    const buildCommand = browser ? ['run', 'build:frontend'] : ['run', 'build:server'];
    const built = spawnSync('npm', buildCommand, { cwd: scratch, encoding: 'utf8' });
    assert.equal(built.status, 0, `${name}: compile failures do not count\n${built.stdout}\n${built.stderr}`);
    const selector = name.startsWith('settle-') ? 'settle' : name.startsWith('palette-') ? 'palette' : name;
    const args = browser ? ['scripts/brand-browser.ts'] : ['scripts/with-test-db.ts', process.execPath, '--test', `--test-name-pattern=${name === 'clears' ? 'item updates clear' : 'item update SSE'}`, 'test/pm-collaboration.test.ts'];
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, args, { cwd: scratch, env: { ...process.env, PATH: `${path.join(root, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}`, BRAND_QUICK: '1', BRAND_ACCEPTANCE: '0', BRAND_CAPTURE_ONLY: 'none', BRAND_REGRESSION_ONLY: `round4-${selector}`, BRAND_SCREENSHOTS: path.join(output, name) }, encoding: 'utf8', timeout: 240000 });
    assert.ok(!result.error, `${name}: process errors do not count`);
    const log = [result.stdout, result.stderr].filter(Boolean).join('\n');
    await writeFile(path.join(output, `${name}.log`), log);
    assert.notEqual(result.status, 0, `${name}: reverted behavior unexpectedly passed`);
    const failure = log.match(/AssertionError[^\n]*|page\.(?:waitForFunction|evaluate):[^\n]*|locator\.[^\n]*Timeout[^\n]*|SSE condition timed out:[^\n]*/)?.[0];
    assert.ok(failure, `${name}: must fail on behavior\n${log}`);
    receipts.push({ name, failure: failure.slice(0, 240) });
    console.log(`Expected behavioral failure: ${name}: ${failure.slice(0, 200)}`);
    await writeFile(path.join(scratch, file), source);
  }
  const hashes: Record<string, string> = {};
  for (const [file, source] of originals) {
    assert.equal(await readFile(path.join(root, file), 'utf8'), source, `Production source changed: ${file}`);
    hashes[file] = createHash('sha256').update(source).digest('hex');
  }
  await writeFile(path.join(output, 'round4-reverts.json'), JSON.stringify({ base: '147ba52', receipts, hashes, productionUnchanged: true }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }

/** Independently restore each reviewed defect and require a behavioral failure. */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyBrowserTree } from './browser-build-tree.ts';

const evidenceRoot = process.env.BRAND_REVERT_EVIDENCE;
assert.ok(evidenceRoot, 'Set BRAND_REVERT_EVIDENCE');
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-round6-revert-'));
const cases = [
  ['errors', 'public/src/views/export.ts'], ['detail', 'public/src/views/items.ts'],
  ['live', 'public/src/live-copy.ts'], ['metadata', 'public/src/views/graph.ts'],
  ['pixels', 'scripts/brand-pixel-diff.ts'], ['geometry', 'public/styles.css'],
];
const originals = new Map<string, string>();
const receipts: { name: string; file: string; exit: number; failure: string }[] = [];
try {
  await copyBrowserTree(process.cwd(), scratch);
  for (const [name, file] of cases.filter(([name]) => !process.env.BRAND_REVERT_CASES || process.env.BRAND_REVERT_CASES.split(',').includes(name))) {
    const current = await readFile(file, 'utf8'); originals.set(file, current);
    const baseline = spawnSync('git', ['show', `fc0447c:${file}`], { encoding: 'utf8' });
    assert.equal(baseline.status, 0);
    // Keep the single heading markup current when only the live-root guard is reverted.
    await writeFile(path.join(scratch, file), baseline.stdout);
    if (name !== 'pixels') {
      const build = spawnSync('npm', ['run', 'build:frontend'], { cwd: scratch, encoding: 'utf8' });
      assert.equal(build.status, 0, build.stdout + build.stderr);
    }
    const args = name === 'pixels' ? ['--test', 'test/brand-pixel-diff.test.ts'] : ['scripts/brand-browser.ts'];
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 180000, env: {
      ...process.env, BRAND_QUICK: '1', BRAND_ACCEPTANCE: '0', BRAND_CAPTURE_ONLY: 'none',
      BRAND_REGRESSION_ONLY: `round6-${name}`, BRAND_SCREENSHOTS: path.join(evidenceRoot, name),
    } });
    assert.ok(!result.error, `${name}: process errors are not revert proof`);
    const log = result.stdout + result.stderr;
    await writeFile(path.join(evidenceRoot, `${name}.log`), log);
    assert.notEqual(result.status, 0, `${name}: reverted defect passed`);
    const failure = log.match(/AssertionError[^\n]*|locator\.waitFor:[^\n]*|Expected values[^\n]*|ERR_ASSERTION[^\n]*/)?.[0];
    assert.ok(failure, `${name}: behavioral assertion required\n${log}`);
    receipts.push({ name, file, exit: result.status!, failure });
    console.log(`Expected failure: ${name}: ${failure}`);
    await writeFile(path.join(scratch, file), current);
  }
  for (const [file, source] of originals) assert.equal(await readFile(file, 'utf8'), source);
  await writeFile(path.join(evidenceRoot, 'revert-proofs.json'), JSON.stringify({ base: 'fc0447ce08336c9598a00be76b4e48def296e9ee', receipts, productionUnchanged: true }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }

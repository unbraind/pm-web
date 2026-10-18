/** Exercise the screenshot matrix filter against complete strict-run directories. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';

test('pixel comparison selects exactly the five views across review widths and themes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-web-pixels-'));
  try {
    const before = path.join(root, 'before'), after = path.join(root, 'after');
    await mkdir(before); await mkdir(after);
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    for (const view of ['sign-in', 'projects', 'items', 'board', 'detail-open']) {
      for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
        const name = `${view}-${width}-${theme}.png`;
        await writeFile(path.join(before, name), png);
        await writeFile(path.join(after, name), png);
      }
    }
    // Full strict-run directories contain extra frames on both sides.
    for (const name of ['items-tags-1440-light.png', 'board-more-actions-390-dark.png', 'items-900-light.png', 'items-390-print.png']) {
      await writeFile(path.join(before, name), png);
      await writeFile(path.join(after, name), png);
    }
    const run = spawnSync(process.execPath, ['scripts/brand-pixel-diff.ts', before, after], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const results = JSON.parse(await readFile(path.join(after, 'pixel-diff.json'), 'utf8')) as { name: string }[];
    assert.equal(results.length, 30);
    assert.equal(new Set(results.map(result => result.name)).size, 30);
  } finally { await rm(root, { recursive: true, force: true }); }
});

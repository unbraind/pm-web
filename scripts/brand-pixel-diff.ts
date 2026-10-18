/** Compare corresponding PNG bytes; allow only sparse antialiasing differences in the migration. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const [before, after] = process.argv.slice(2);
assert.ok(before && after, 'Supply before and token-migration screenshot directories');
const results = [];
for (const name of (await readdir(before)).filter(name => /^(sign-in|projects|items|board|detail-open)-(1440|768|390)-(light|dark)\.png$/.test(name))) {
  const original = PNG.sync.read(await readFile(path.join(before, name)));
  const migrated = PNG.sync.read(await readFile(path.join(after, name)));
  assert.equal(migrated.width, original.width);
  assert.equal(migrated.height, original.height);
  let maxChannelDelta = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < original.data.length; offset += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(original.data[offset + channel] - migrated.data[offset + channel]));
    if (delta) changedPixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  results.push({ name, maxChannelDelta, changedPixels, changedPercent: changedPixels / (original.width * original.height) * 100 });
}
await writeFile(path.join(after, 'pixel-diff.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
assert.ok(results.length === 30, 'Expected five views across three widths and two themes');
assert.ok(results.every(result => result.maxChannelDelta <= 32 && result.changedPercent <= .02), 'Token migration exceeds the sparse antialiasing tolerance (32/255, 0.02% pixels)');

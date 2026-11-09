import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** Resolve every repository blob link in shipped Markdown at its stated revision. */
function missingLinks(document: string): string[] {
  return [...document.matchAll(/https:\/\/github\.com\/unbraind\/pm-web\/blob\/([^/]+)\/([^\s)#>]+)/g)]
    .filter(([, revision, file]) => spawnSync('git', ['cat-file', '-e', `${revision === 'main' ? 'origin/main' : revision}:${file}`]).status !== 0)
    .map(([url]) => url);
}

test('all published Markdown repository links name files present at their referenced revision', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  for (const file of manifest.files.filter(file => file.endsWith('.md'))) {
    assert.deepEqual(missingLinks(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), [], file);
  }
  assert.equal(missingLinks('https://github.com/unbraind/pm-web/blob/main/does-not-exist.md').length, 1);
  assert.equal(missingLinks('https://github.com/unbraind/pm-web/blob/0000000000000000000000000000000000000000/README.md').length, 1);
});

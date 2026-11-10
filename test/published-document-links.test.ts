import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import test from 'node:test';
import { markdownDestinations, missingPackedDocumentLinks } from '../scripts/published-document-links.ts';

/** Resolve every repository blob link in shipped Markdown at its stated revision. */
function missingLinks(document: string): string[] {
  return [...document.matchAll(/https:\/\/github\.com\/unbraind\/pm-web\/blob\/([^/]+)\/([^\s)#>]+)/g)]
    .filter(([, revision, file]) => spawnSync('git', ['cat-file', '-e', `${revision === 'main' ? 'origin/main' : revision}:${file}`]).status !== 0)
    .map(([url]) => url);
}

test('all published Markdown repository links name files present at their referenced revision', () => {
  const cleanEnvironment: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull };
  for (const key of Object.keys(cleanEnvironment)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER/i.test(key)) delete cleanEnvironment[key];
  }
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: new URL('..', import.meta.url), env: cleanEnvironment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const inventory = (JSON.parse(packed.stdout) as { files: { path: string }[] }[])[0]!.files.map(file => file.path);
  assert.deepEqual(missingPackedDocumentLinks(inventory, file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), []);
  for (const file of inventory.filter(file => /\.md$/i.test(file))) {
    assert.deepEqual(missingLinks(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), [], file);
  }
  assert.equal(missingLinks('https://github.com/unbraind/pm-web/blob/main/does-not-exist.md').length, 1);
  assert.equal(missingLinks('https://github.com/unbraind/pm-web/blob/0000000000000000000000000000000000000000/README.md').length, 1);
});

test('relative links require packed targets across nested documents, images, references, titles and encoded paths', () => {
  const targets = ['[inline](../target.md#section)', '[titled](../target.md "Title")', '![image](../target.md)', '[reference][ref]\n[ref]: ../target.md', '[space](<../target%20file.md?download=1#anchor>)', '[balanced](../target(file).md)'];
  for (const link of targets) {
    const files = ['docs/nested.md', 'target.md', 'target file.md', 'target(file).md'];
    assert.deepEqual(missingPackedDocumentLinks(files, file => file === 'docs/nested.md' ? link : ''), [], link);
    assert.equal(missingPackedDocumentLinks(['docs/nested.md'], () => link).length, 1, link);
    assert.equal(markdownDestinations(link).length, 1, link);
  }
  assert.deepEqual(missingPackedDocumentLinks(['README.md'], () => '[web](https://example.test) [mail](mailto:example@example.test) [local](#heading)\n```md\n[example](missing.md)\n```'), []);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devNull, tmpdir } from 'node:os';
import test from 'node:test';
import { assertPackedMarkdownMatches, markdownDestinations, missingPackedDocumentLinks, missingRevisionLinks, packedFileInventory, packedMarkdownFiles, stripFencedCode, type RevisionPresence } from '../scripts/published-document-links.ts';

/** Resolve a blob revision locally. A missing ref or unfetched commit is unresolved, not a missing file. */
function gitRevisionLookup(revision: string, file: string, cwd = new URL('..', import.meta.url)): RevisionPresence {
  const candidates = revision === 'main' ? ['origin/main', 'main'] : [revision];
  let resolved = '';
  for (const candidate of candidates) {
    const parsed = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`], { cwd, encoding: 'utf8' });
    if (parsed.status === 0 && parsed.stdout.trim()) { resolved = parsed.stdout.trim(); break; }
  }
  if (!resolved) return 'unresolved';
  const present = spawnSync('git', ['cat-file', '-e', `${resolved}:${file}`], { cwd, encoding: 'utf8' });
  if (present.status === 0) return 'present';
  if (/invalid object name|not a valid object name|bad object|ambiguous argument/i.test(present.stderr ?? '')) return 'unresolved';
  return 'absent';
}

test('all published Markdown repository links name files present at their referenced revision', t => {
  const cleanEnvironment: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull };
  for (const key of Object.keys(cleanEnvironment)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER/i.test(key)) delete cleanEnvironment[key];
  }
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: new URL('..', import.meta.url), env: cleanEnvironment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const inventory = packedFileInventory(packed.stdout);
  assert.deepEqual(missingPackedDocumentLinks(inventory, file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')), []);
  const reports = inventory.filter(file => /\.md$/i.test(file)).map(file => missingRevisionLinks(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), gitRevisionLookup));
  const missing = reports.flatMap(report => report.missing);
  const unresolved = reports.flatMap(report => report.unresolved);
  assert.deepEqual(missing, []);
  if (unresolved.length > 0) t.skip(`Git revision lookup cannot run for ${String(unresolved.length)} published link(s); those links are not reported as missing`);
  const absent = missingRevisionLinks('https://github.com/unbraind/pm-web/blob/main/does-not-exist.md', () => 'absent');
  const unresolvedOnly = missingRevisionLinks('https://github.com/unbraind/pm-web/blob/0000000000000000000000000000000000000000/README.md', () => 'unresolved');
  assert.equal(absent.missing.length, 1);
  assert.deepEqual(unresolvedOnly.missing, []);
  assert.equal(unresolvedOnly.unresolved.length, 1);
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

test('fenced examples follow CommonMark closing rules for every marker length and character', () => {
  const markers = ['`', '~'] as const;
  for (const marker of markers) {
    for (const length of [3, 4, 7]) {
      const open = marker.repeat(length);
      const inside = '[inside](missing.md)';
      const after = '[after](kept.md)';
      assert.deepEqual(markdownDestinations(`${open}\n${inside}\n${open}\n${after}`), ['kept.md'], `${marker} ${length}`);
      assert.deepEqual(markdownDestinations(`${open}\n${inside}\n${marker.repeat(length + 2)}\n${after}`), ['kept.md'], `longer ${marker}`);
      assert.deepEqual(markdownDestinations(`${open}\n${inside}\n${marker.repeat(length - 1)}\n${after}`), [], `shorter ${marker}`);
      assert.deepEqual(markdownDestinations(`${open}\n${inside}\n${open} trailing\n${after}`), [], `trailing ${marker}`);
      assert.deepEqual(markdownDestinations(`${open} info\n${inside}\n${open}\n${after}`), ['kept.md'], `info ${marker}`);
      assert.equal(stripFencedCode(`${open}\n${inside}`).includes(inside), false, `unclosed ${marker}`);
    }
  }
  assert.deepEqual(markdownDestinations('```\n[inside](missing.md)\n~~~\n[still](missing.md)\n```\n[after](kept.md)'), ['kept.md']);
  assert.deepEqual(markdownDestinations('```\n[inside](missing.md)\n```~~~\n[after](kept.md)'), []);
  assert.deepEqual(markdownDestinations('    ```\n[not-fenced](kept.md)\n```'), ['kept.md']);
  assert.deepEqual(markdownDestinations('```js with ` tick\n[not-a-fence](kept.md)'), ['kept.md']);
});

test('malformed percent-encoding is a missing destination and never aborts the inventory check', () => {
  const malformed = ['%', '%zz', '%2', '%E0%A4', 'ok%2', 'dir/%', '%zz/file.md'];
  for (const token of malformed) {
    assert.doesNotThrow(() => missingPackedDocumentLinks(['README.md', 'docs/ok.md'], () => `[x](${token})`), token);
    assert.equal(missingPackedDocumentLinks(['README.md'], () => `[x](${token})`).length, 1, token);
  }
  assert.deepEqual(missingPackedDocumentLinks(['README.md', 'docs/ok.md'], file => file === 'README.md' ? '[x](docs/ok%2Emd)' : ''), []);
});

test('packed Markdown selection and receipt parsing use the inventory, not manifest entries', () => {
  const manifestEntries = ['README.md', 'public/', 'docs/note.md'];
  const packed = ['README.md', 'CHANGELOG.md', 'public/brand/fonts/SOURCES.md', 'docs/note.md', 'docs/NOTE.MD', 'LICENSE'];
  const selected = packedMarkdownFiles(packed);
  assert.deepEqual(selected, ['README.md', 'CHANGELOG.md', 'public/brand/fonts/SOURCES.md', 'docs/note.md', 'docs/NOTE.MD']);
  const manifestOnly = manifestEntries.filter(file => file.endsWith('.md'));
  assert.equal(manifestOnly.includes('public/brand/fonts/SOURCES.md'), false);
  assert.equal(manifestOnly.includes('CHANGELOG.md'), false);
  assert.equal(selected.every(file => packed.includes(file)), true);
  const receipt = 'lifecycle note\n[{"files":[{"path":"README.md"},{"path":"public/a.md"}]}]';
  assert.deepEqual(packedFileInventory(receipt), ['README.md', 'public/a.md']);
  assert.deepEqual(packedFileInventory('[{"files":[]}]'), []);
  for (const stdout of ['', '[]', '[{}]', 'not json', '[{"files":[{"path":1}]}]']) {
    assert.throws(() => packedFileInventory(stdout), /no file inventory/, stdout);
  }
  assert.equal(readFileSync(new URL('../scripts/accept-packed.ts', import.meta.url), 'utf8').includes('manifest.files.filter'), false);
});

test('an unresolvable revision is never classified as a missing link', () => {
  const revisions = ['main', 'origin/main', '0'.repeat(40), 'not-a-ref', 'feature/missing'];
  const files = ['README.md', 'does-not-exist.md', 'docs/a md.md'];
  for (const revision of revisions) {
    for (const file of files) {
      const url = `See https://github.com/unbraind/pm-web/blob/${revision}/${file} and [x](local.md)`;
      const report = missingRevisionLinks(url, () => 'unresolved');
      assert.deepEqual(report.missing, [], url);
      assert.equal(report.unresolved.length, 1, url);
      assert.equal(missingRevisionLinks(url, () => 'present').missing.length, 0);
      assert.equal(missingRevisionLinks(url, () => 'absent').missing.length, 1);
    }
  }
});


test('packed Markdown byte comparison detects changes to nested, mandatory and uppercase files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'packed-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = ['README.md', 'CHANGELOG.md', 'public/nested.md', 'docs/NOTE.MD'];
  const source = join(root, 'source'), installed = join(root, 'installed');
  for (const directory of [source, installed]) {
    await mkdir(join(directory, 'public'), { recursive: true });
    await mkdir(join(directory, 'docs'));
    for (const file of inventory) await writeFile(join(directory, file), 'original');
  }
  const compare = (): void => assertPackedMarkdownMatches(inventory, file => readFileSync(join(installed, file), 'utf8'), file => readFileSync(join(source, file), 'utf8'));
  compare();
  for (const file of inventory) {
    await writeFile(join(installed, file), 'modified');
    assert.throws(compare, /Packed documentation differs/);
    await writeFile(join(installed, file), 'original');
  }
  compare();
});

test('real shallow checkout distinguishes unavailable revisions from missing files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'document-revisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), shallow = join(root, 'shallow');
  await mkdir(source);
  const git = (args: string[], cwd = source): string => {
    const result = spawnSync('git', ['-c', 'user.name=ContractTest', '-c', 'user.email=contract@example.test', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--initial-branch=main']);
  await writeFile(join(source, 'README.md'), 'synthetic public document');
  await mkdir(join(source, 'docs'));
  await writeFile(join(source, 'docs', 'a md.md'), 'encoded path fixture');
  git(['add', 'README.md', 'docs/a md.md']);
  git(['commit', '-m', 'first synthetic revision']);
  const old = git(['rev-parse', 'HEAD']);
  await writeFile(join(source, 'README.md'), 'second synthetic public document');
  git(['commit', '-am', 'second synthetic revision']);
  git(['clone', '--depth=1', '--no-local', '--single-branch', '--branch=main', source, shallow]);
  git(['update-ref', '-d', 'refs/remotes/origin/main'], shallow);
  const cwd = pathToFileURL(`${shallow}/`);
  assert.equal(git(['rev-parse', '--is-shallow-repository'], shallow), 'true');
  assert.equal(gitRevisionLookup('main', 'README.md', cwd), 'present');
  assert.equal(gitRevisionLookup('main', 'missing.md', cwd), 'absent');
  assert.equal(gitRevisionLookup(old, 'README.md', cwd), 'unresolved');
  assert.equal(gitRevisionLookup('missing-ref', 'README.md', cwd), 'unresolved');
  for (const revision of ['release/2026.11', 'feature/missing']) git(['branch', revision], shallow);
  for (const [revision, encoded, decoded] of [
    ['release/2026.11', 'README.md', 'README.md'],
    ['feature/missing', 'README.md', 'README.md'],
    ['main', 'docs/a%20md.md', 'docs/a md.md'],
    ['release%2F2026.11', 'docs%2Fa%20md.md', 'docs/a md.md'],
    ['main', 'docs/../README.md', 'README.md'],
  ]) {
    const calls: [string, string][] = [];
    const url = `https://github.com/unbraind/pm-web/blob/${revision}/${encoded}`;
    const report = missingRevisionLinks(`[fixture](${url})`, (ref, file) => {
      calls.push([ref, file]);
      return gitRevisionLookup(ref, file, cwd);
    });
    assert.deepEqual(report, { missing: [], unresolved: [] }, url);
    assert.deepEqual(calls.filter(([, file]) => file !== ''), [[decodeURIComponent(revision), decoded]], url);
  }
  const missingUrl = 'https://github.com/unbraind/pm-web/blob/release/2026.11/missing.md';
  assert.deepEqual(missingRevisionLinks(missingUrl, (ref, file) => gitRevisionLookup(ref, file, cwd)), { missing: [missingUrl], unresolved: [] });
  for (const file of ['../../outside.md', '%2E%2E%2Foutside.md', '%2Foutside.md', 'docs/%ZZ.md', 'docs/%E0%A4.md', 'docs/%00.md', 'docs%5Coutside.md']) {
    const url = `https://github.com/unbraind/pm-web/blob/main/${file}`;
    const report = missingRevisionLinks(url, (ref, target) => {
      assert.equal(target, '', 'unsafe paths must be refused before file lookup');
      return gitRevisionLookup(ref, target, cwd);
    });
    assert.deepEqual(report, { missing: [url], unresolved: [] }, url);
  }
});


test('Markdown blob destinations are consumed once without truncated bare URL copies', () => {
  const url = 'https://github.com/unbraind/pm-web/blob/main/docs/a(b).md';
  const titleUrl = 'https://github.com/unbraind/pm-web/blob/main/title-only.md';
  for (const document of [
    `[readme](${url})`, `![image](${url})`, `[readme](<${url}>)`,
    `[readme](${url} "${titleUrl}")`, `[readme](${url} "Title (with parentheses) ${titleUrl}")`, `[readme][ref]\n[ref]: ${url}`,
    `[readme][ref]\n[ref]: <${url}>`, `[readme][ref]\n[ref]: ${url} "${titleUrl}"`, `[readme][ref]\n[ref]: ${url} "[title](${titleUrl})"`, `<${url}>`, url,
  ]) {
    assert.deepEqual(markdownDestinations(document), [url], document);
    const calls: string[] = [];
    const report = missingRevisionLinks(document, (revision, file) => {
      if (file === '') return revision === 'main' ? 'present' : 'unresolved';
      calls.push(file);
      return file === 'docs/a(b).md' ? 'present' : 'absent';
    });
    assert.deepEqual(report, { missing: [], unresolved: [] }, document);
    assert.deepEqual(calls, ['docs/a(b).md'], document);
  }
  const missing = 'https://github.com/unbraind/pm-web/blob/main/missing.md';
  assert.deepEqual(markdownDestinations(`[readme](${url}) then ${missing}`), [url, missing]);
  assert.deepEqual(missingRevisionLinks(`[readme](${url}) then ${missing}`, (revision, file) =>
    revision !== 'main' ? 'unresolved' : file === 'missing.md' ? 'absent' : 'present'), { missing: [missing], unresolved: [] });
});

test('blob links require a file path and never hide missing targets as unresolved revisions', () => {
  for (const suffix of ['', 'main', 'main/', 'main?raw=1', 'main#anchor', 'main/.', 'main/%2E']) {
    const url = `https://github.com/unbraind/pm-web/blob/${suffix}`;
    const report = missingRevisionLinks(`[broken](${url})`, (revision, file) => {
      assert.equal(file, '', 'invalid destinations must not reach file lookup');
      return revision === 'main' ? 'present' : 'unresolved';
    });
    assert.deepEqual(report, { missing: [url], unresolved: [] }, url);
  }
  const empty = 'https://github.com/unbraind/pm-web/blob/';
  assert.deepEqual(missingRevisionLinks(empty, () => assert.fail('empty blob destination must not reach lookup')), { missing: [empty], unresolved: [] });
  for (const revision of ['main', 'release/2026.11']) {
    const url = `https://github.com/unbraind/pm-web/blob/${revision}/README.md`;
    assert.deepEqual(missingRevisionLinks(url, (ref, file) =>
      ref !== revision ? 'unresolved' : file === '' || file === 'README.md' ? 'present' : 'absent'), { missing: [], unresolved: [] });
  }
});

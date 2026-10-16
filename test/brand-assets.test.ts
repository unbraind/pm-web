import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBrand } from '../scripts/build-brand.ts';
import { createApp } from '../src/app.ts';
import { startEphemeralServer } from './helpers/ephemeral-server.ts';

test('brand build copies optional assets byte for byte and removes stale output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'brand-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40);
  await mkdir(path.join(root, 'node_modules/pm-brand/fonts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: {}, devDependencies: { 'pm-brand': `github:unbraind/pm-brand#${sha}` } }));
  await writeFile(path.join(root, 'node_modules/pm-brand/tokens.css'), ':root { --pm-sheet: white; }');
  await buildBrand(root);
  assert.equal(await readFile(path.join(root, 'public/brand/assets.css'), 'utf8'), `@import url('./${sha}/tokens.css');\n`);
  await writeFile(path.join(root, 'node_modules/pm-brand/fonts.css'), '/* synthetic font stylesheet */');
  await writeFile(path.join(root, 'node_modules/pm-brand/fonts/OFL.txt'), 'Synthetic license fixture');
  await writeFile(path.join(root, 'public/brand/stale.txt'), 'old');
  await buildBrand(root);
  assert.match(await readFile(path.join(root, 'public/brand/assets.css'), 'utf8'), /fonts\.css/);
  assert.equal(await readFile(path.join(root, `public/brand/${sha}/fonts/OFL.txt`), 'utf8'), 'Synthetic license fixture');
  await assert.rejects(readFile(path.join(root, 'public/brand/stale.txt')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'pm-brand': 'git:invalid' }, devDependencies: { 'pm-brand': 'latest' } }));
  await assert.rejects(buildBrand(root), /devDependencies only/);
});

test('published brand assets use immutable commit URLs and revalidated pointers', async t => {
  const server = await startEphemeralServer(createApp());
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${base}/brand/assets.css`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const content = await response.text();
  const relative = /\.\/([a-f0-9]{40}\/tokens\.css)/.exec(content)?.[1];
  assert.ok(relative);
  const tokens = await fetch(`${base}/brand/${relative}`);
  assert.equal(tokens.status, 200);
  assert.equal(tokens.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await tokens.text(), /--pm-paper:/);
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies: Record<string, string> };
  assert.ok(Object.values(pkg.dependencies).every(value => !value.startsWith('github:')));
});

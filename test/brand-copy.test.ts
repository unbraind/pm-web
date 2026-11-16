/** Owner copy rules apply to the hosted workspace in every shipped language. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const keys = ['auth.brand.tagline', 'auth.feature.tasks', 'auth.feature.storage', 'auth.feature.history', 'auth.feature.team'];
test('authentication copy describes shared context for any agent and task in every locale', async () => {
  for (const locale of ['en', 'de', 'es', 'zh']) {
    const catalog = JSON.parse(await readFile(`public/src/i18n/${locale}.json`, 'utf8')) as Record<string, string>;
    for (const key of keys) {
      assert.ok(catalog[key]);
      assert.doesNotMatch(catalog[key], /\bgit\b|branch|merge|coding agent|\.agents\/pm/i);
    }
    if (locale === 'en') {
      assert.match(catalog[keys[0]], /Context management for agents and the people/);
      assert.match(catalog[keys[1]], /context, goals, tasks, decisions and memory/);
      assert.match(catalog[keys[2]], /who made it, live for everyone/);
      const html = await readFile('public/index.html', 'utf8');
      for (const key of keys) assert.ok(html.includes(`data-i18n="${key}">${catalog[key]}`), `${key}: static fallback must match`);
    }
  }
});

test('the shipped application shell credits its maker with plain public links', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const footer = html.match(/<footer class="app-footer">([\s\S]*?)<\/footer>/);
  assert.ok(footer, 'the public package includes its maker credit');
  assert.equal(footer[1], 'Made by <a href="https://preu.at/">Stefan Preu</a> · <a href="https://unbrained.dev/">unbrained.dev</a>');
  assert.equal(html.match(/<footer\b/g)?.length, 1, 'one credit serves every application view');
  assert.doesNotMatch(footer[0], /rel\s*=\s*["'][^"']*\b(?:me|nofollow)\b/i);
  // Native DOM placement, viewport and cache checks live in maker-footer-browser.acceptance.ts.
});

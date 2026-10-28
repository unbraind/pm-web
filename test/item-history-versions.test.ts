/** Compatibility evidence is captured from actual npm CLIs on every run, never stored response fixtures. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { normalizeItemHistory } from '../src/services/item-history.ts';
import { itemHistoryHarness } from './helpers/item-history-harness.ts';
import { pool } from '../src/db.ts';

after(() => pool.end());

test('real npm history outputs normalize consistently on 2026.10.20, 2026.10.27 and 2026.10.28', { timeout: 600_000 }, async t => {
  const h = await itemHistoryHarness();
  const installs = await mkdtemp(path.join(os.tmpdir(), 'history-npm-versions-'));
  // Public package operations receive no inherited credential variables or credential files.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull, npm_config_userconfig: os.devNull, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', GIT_CEILING_DIRECTORIES: os.tmpdir() };
  for (const key of Object.keys(childEnv)) if (/token|secret|password|api_?key|credential|^(?:GH_|GITHUB_|CODEX_|OPENAI_|ANTHROPIC_|OLLAMA_)|^NPM_MEDIA_SERVER$/i.test(key)) delete childEnv[key];
  try {
    for (const version of ['2026.10.20', '2026.10.27', '2026.10.28']) {
      let packageRoot = path.resolve('node_modules/@unbrained/pm-cli');
      if (version !== '2026.10.20') {
        const prefix = path.join(process.env.PM_HISTORY_COMPAT_ROOT || installs, version);
        packageRoot = path.join(prefix, 'node_modules/@unbrained/pm-cli');
        if (!process.env.PM_HISTORY_COMPAT_ROOT) execFileSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `@unbrained/pm-cli@${version}`], { env: childEnv, encoding: 'utf8', timeout: 180_000 });
      }
      assert.equal((JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version, version);
      for (const flags of [[], ['--full'], ['--compact', '--limit', '3']]) {
        const text = execFileSync(process.execPath, [path.join(packageRoot, 'dist/cli.js'), 'history', h.itemId, '--json', '--pm-path', h.pmRoot, ...flags], { cwd: h.cwd, env: childEnv, encoding: 'utf8', timeout: 60_000 });
        const raw = JSON.parse(text) as Record<string, unknown>;
        const rows = normalizeItemHistory(raw);
        const expected = flags.includes('--limit') ? ['update', 'update', 'close'] : ['create', 'update', 'update', 'close'];
        assert.deepEqual(rows.map(row => row.action), expected, `${version}: ${flags.join(' ') || 'default'}`);
        assert.ok(rows.every(row => row.timestamp && row.author));
        if (!flags.length) {
          assert.equal(raw.history, undefined); assert.equal(raw.compact, true);
          assert.equal(raw.order, version === '2026.10.28' ? 'newest_first' : undefined);
        }
        t.diagnostic(`${version} ${flags.join(' ') || 'default'}: ${rows.length} real rows; upstream order=${String(raw.order || 'legacy oldest_first')}; normalized close last`);
      }
    }
  } finally { await h.cleanup(); await rm(installs, { recursive: true, force: true }); }
});

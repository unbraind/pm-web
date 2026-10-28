import { projectAccessRows } from './project-access-rows.ts';
/** Real non-git history tracker behind the production application; only account/project SQL is stubbed. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { createApp } from '../../src/app.ts';
import { pool } from '../../src/db.ts';

/** Set up isolated state without requiring a running PostgreSQL service. */
export async function itemHistoryHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'item-history-route-'));
  const owner = '44444444-4444-4441-8444-444444444444';
  const project = '66666666-6666-4661-8666-666666666666';
  const slug = 'history-proof';
  const cwd = path.join(root, owner, slug);
  const previousRoot = process.env.PROJECTS_ROOT;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PROJECTS_ROOT = root;
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  await mkdir(cwd, { recursive: true });
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const client = new PmClient({ pmRoot, cwd, noExtensions: true, author: 'history-test' });
  await client.init('demo', { defaults: true, agentGuidance: 'skip' });
  const { item } = await client.create({ type: 'Task', title: 'Item history projection proof' });
  await client.update(item.id, { title: 'Updated item history proof', message: 'exercise update flags' });
  await client.update(item.id, { priority: 1 });
  await client.close(item.id, 'Synthetic verification complete');
  const original = pool.query;
  const projectRow = { id: project, name: 'Item history', slug, description: '', prefix: 'demo', owner_user_id: owner, is_owner: true, permission: 'edit', created_at: '2026-10-01T00:00:00Z' };
  Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: async (sql: string, params: unknown[] = []) => {
    let rows: unknown[] = [];
    const projected = projectAccessRows(sql, params, projectRow);
    if (projected) return { rows: projected, rowCount: projected.length };
    if (sql.includes('user_id = $2') && params[0] === project && params[1] === owner) rows = [projectRow];
    else if (sql.includes('FROM pm_projects p') && sql.includes('p.user_id = $1') && params[0] === owner) rows = [projectRow];
    else if (/FROM pm_users\s+WHERE id\s*=\s*\$1/.test(sql) && params[0] === owner) rows = [{ id: owner, email: 'history@example.test', display_name: 'History reviewer', is_admin: false, has_github_token: false, created_at: '2026-10-01T00:00:00Z' }];
    return { rows, rowCount: rows.length };
  } });
  const app = createApp();
  return { root, cwd, pmRoot, client, itemId: item.id, owner, project, app,
    cleanup: async () => {
      Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: original });
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      await rm(root, { recursive: true, force: true });
    },
  };
}

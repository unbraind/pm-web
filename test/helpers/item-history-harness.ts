/** Real non-git history tracker and authenticated HTTP route; only project lookup is stubbed. */
import express from 'express';
import cookieParser from 'cookie-parser';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { pmRouter } from '../../src/routes/pm.ts';
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
  Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: async (sql: string, params: unknown[] = []) => ({
    rows: sql.includes('user_id = $2') && params[0] === project && params[1] === owner
      ? [{ id: project, name: 'Item history', slug, description: '', prefix: 'demo', owner_user_id: owner }] : [], rowCount: 1,
  }) });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/projects/:projectId/pm', pmRouter);
  return { root, cwd, pmRoot, client, itemId: item.id, owner, project, app,
    cleanup: async () => {
      Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: original });
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      await rm(root, { recursive: true, force: true });
    },
  };
}

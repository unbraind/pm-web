import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PmClient, type ContractsResult } from '@unbrained/pm-cli/sdk';
import { authedFetch, ensureSchema, seedUser, seedProject, seedUserShare, startApp } from './helpers/pg-harness.ts';
import { signToken } from '../src/auth.ts';
import { pool } from '../src/db.ts';
import { ContractExplorerClient } from '../src/contract-explorer-client.ts';
import { ContractExplorerError, directoryContractAdapter, exploreContracts } from '../src/contract-explorer.ts';
import { contractExplorerMarkup } from '../public/src/views/contract-explorer.ts';

/** Exercise the actual project directory, database permissions, HTTP routes and authenticated SDK. */
test('selected-project explorer and previews enforce scope, current availability and editor authorization', async t => {
  await ensureSchema();
  const previousRoot = process.env.PROJECTS_ROOT, root = await mkdtemp(path.join(os.tmpdir(), 'contract-http-'));
  process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(), viewer = await seedUser(), outsider = await seedUser(), project = await seedProject(owner.id);
  await seedUserShare(project.id, viewer.id, 'view');
  const cwd = path.join(root, owner.id, project.slug), pmRoot = path.join(cwd, '.agents', 'pm');
  await mkdir(cwd, { recursive: true });
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true, author: 'contract-test' });
  await pm.init('contract', { defaults: true, agentGuidance: 'skip' }); const { item } = await pm.create({ type: 'Task', title: 'Do not delete', description: 'A synthetic preservation fixture.' });
  const server = await startApp();
  t.after(async () => { await server.close(); await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id, outsider.id]]); await rm(root, { recursive: true, force: true }); if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot; });
  const sdk = (user: typeof owner) => new ContractExplorerClient(server.url('/'), signToken({ userId: user.id, email: user.email }));
  const page = await sdk(owner).list(project.id, { limit: 2 }); assert.equal(page.operations.length, 2); assert.ok(page.total > 50);
  const local = await exploreContracts(directoryContractAdapter({ cwd, pmRoot }), { limit: 2 });
  assert.deepEqual(page.operations, local.operations);
  const response = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/contracts?action=delete`);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  const detail = await response.json(); assert.ok(detail.schema);
  const preview = await sdk(owner).review(project.id, 'delete', { id: item.id }); assert.equal(preview.executed, false);
  await assert.rejects(sdk(viewer).review(project.id, 'delete', { id: item.id }), error => error instanceof ContractExplorerError && error.code === 'view_only');
  assert.equal((await sdk(viewer).review(project.id, 'list', {})).validated, false);
  await assert.rejects(sdk(outsider).list(project.id), error => error instanceof ContractExplorerError && error.code === 'not_found');
  assert.equal((await fetch(server.url(`/api/projects/${project.id}/pm/contracts`))).status, 401);
  for (const query of ['limit=', 'offset=abc', 'offset=0&offset=1', 'action=x&action=y']) assert.equal((await authedFetch(server, owner, `/api/projects/${project.id}/pm/contracts?${query}`)).status, 400);
  await assert.rejects(sdk(owner).review(project.id, 'unknown-operation', {}), error => error instanceof ContractExplorerError && error.code === 'unsupported');
  assert.equal((await pm.get(item.id)).item.id, item.id);
  await pool.query('DELETE FROM pm_project_shares WHERE project_id=$1 AND shared_with_user_id=$2', [project.id, viewer.id]);
  await assert.rejects(sdk(viewer).list(project.id), error => error instanceof ContractExplorerError && error.code === 'not_found');
  await rm(pmRoot, { recursive: true });
  await assert.rejects(sdk(owner).review(project.id, 'delete', { id: item.id }), error => error instanceof ContractExplorerError && error.code === 'unavailable' && !error.remedy.includes(root));
});

/** A real SQL/JSON round trip and remote HTTP round trip preserve one SDK-derived synthetic capability set. */
test('synthetic Postgres adapter renders the same capabilities as a directory provider', async t => {
  await ensureSchema();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'contract-adapters-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const pmRoot = path.join(cwd, '.agents', 'pm'); await new PmClient({ cwd, pmRoot, noExtensions: true }).init('parity', { defaults: true, agentGuidance: 'skip' });
  const directory = directoryContractAdapter({ cwd, pmRoot, noExtensions: true });
  const snapshot = await directory.describe({ availabilityOnly: true });
  const db = await pool.query<{ snapshot: ContractsResult }>('SELECT $1::jsonb AS snapshot', [JSON.stringify(snapshot)]);
  const postgres = await exploreContracts({ kind: 'postgres', describe: async () => db.rows[0].snapshot });
  const local = await exploreContracts(directory);
  assert.deepEqual(postgres.operations, local.operations);
  assert.equal(contractExplorerMarkup(postgres, true).replace('postgres', 'backend'), contractExplorerMarkup(local, true).replace('directory', 'backend'));
});

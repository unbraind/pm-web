import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { pool } from '../src/db.ts';
import { ProjectReadError, readAuthorizedProject } from '../src/services/authorized-project-reads.ts';
import { runSerialized } from '../src/services/pm-runner.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { authedFetch, ensureSchema, seedProject, seedUser, seedUserShare, startApp } from './helpers/pg-harness.ts';

/** Own one isolated real tracker, grant set and HTTP server through test teardown. */
async function fixture(t: TestContext) {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), 'authorized-reads-'));
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(), viewer = await seedUser(), outsider = await seedUser();
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, viewer.id, 'view');
  const cwd = path.join(root, owner.id, project.slug);
  const { client, pmRoot } = await createPlainContractTracker(cwd);
  const { item } = await client.create({ type: 'Task', title: 'Authorized native item', description: 'Synthetic read fixture', body: 'full body needle' });
  const server = await startApp();
  t.after(async () => {
    try {
      await server.close();
      await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id, outsider.id]]);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
    }
  });
  return { root, cwd, pmRoot, client, item, server, owner, viewer, outsider, project };
}

/** Run fixture changes in an independent process with only the synthetic database configuration. */
async function change(action: string, project: string, principal: string): Promise<void> {
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./helpers/authorized-read-worker.ts', import.meta.url)), action, project, principal], {
    env: { DATABASE_URL: process.env.DATABASE_URL }, timeout: 30000,
  });
}

/** Real plain-directory items, real grants and an activated extension with a visible side effect. */
test('authorized item GET and HEAD reads never activate workspace extensions', async t => {
  const { cwd, pmRoot, item, server, viewer, outsider, project } = await fixture(t);
  const extension = path.join(pmRoot, 'extensions', 'read-marker'), marker = path.join(pmRoot, 'extensions', 'activated');
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ name: 'read-marker', version: '1.0.0', entry: './index.mjs', capabilities: ['commands'] }));
  await writeFile(path.join(extension, 'index.mjs'), "import { writeFileSync } from 'node:fs'; export function activate() { writeFileSync(new URL('../activated', import.meta.url), 'activated'); }");
  await new PmClient({ pmRoot, cwd }).get(item.id);
  assert.equal(existsSync(marker), true, 'control proves the actual SDK activates the extension');
  await rm(marker);
  const settings = await readFile(path.join(pmRoot, 'settings.json'));
  const history = await readFile(path.join(pmRoot, 'history', `${item.id}.jsonl`));
  assert.equal(existsSync(path.join(cwd, '.git')), false);
  for (const endpoint of [`get/${item.id}`, `at/${item.id}/1`, 'search?q=needle', 'board', 'export', 'calendar.ics']) {
    await t.test(endpoint, async () => {
      await rm(marker, { force: true });
      const response = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/${endpoint}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(existsSync(marker), false, `${endpoint} activated an extension for a viewer`);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      if (endpoint.startsWith('search')) assert.equal((await response.json()).items[0].id, item.id);
      const head = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/${endpoint}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(existsSync(marker), false);
    });
  }
  const denied = await authedFetch(server, outsider, `/api/projects/${project.id}/pm/get/${item.id}`);
  assert.equal(denied.status, 404);
  assert.deepEqual(await readFile(path.join(pmRoot, 'settings.json')), settings);
  assert.deepEqual(await readFile(path.join(pmRoot, 'history', `${item.id}.jsonl`)), history);
});

/** Returning cached capabilities never returns cached authorization or item values. */
test('read bindings isolate principals and grants while observing independent SDK writes', async t => {
  const { viewer, owner, outsider, project, pmRoot, item, client } = await fixture(t);
  const capture = (principal: string) => readAuthorizedProject(principal, project.id, async reader => {
    assert.equal((await reader.get(item.id)).item.id, item.id);
    return reader;
  });
  const first = await capture(viewer.id);
  assert.equal(await capture(viewer.id.toUpperCase()), first, 'normalize both cache and grant identities');
  await seedUserShare(project.id, outsider.id, 'view');
  assert.notEqual(await capture(outsider.id), first, 'equal permissions do not make principals interchangeable');
  assert.notEqual(await capture(owner.id), first, 'different principals never share a capability handle');
  await pool.query("UPDATE pm_project_shares SET permission='edit' WHERE project_id=$1", [project.id]);
  const editor = await capture(viewer.id);
  assert.notEqual(editor, first, 'a changed effective grant must select a different binding');
  await readAuthorizedProject(viewer.id, project.id, async reader => {
    await change('update-item', pmRoot, item.id);
    assert.equal((await reader.get(item.id)).item.title, 'Changed by independent writer');
    assert.equal((await reader.at(item.id, '1')).document.metadata.title, item.title);
    assert.equal((await reader.complete(true)).items[0].body, 'full body needle');
  });
  assert.equal((await client.get(item.id)).item.title, 'Changed by independent writer');
  await change('revoke', project.id, viewer.id);
  let readCalled = false;
  await assert.rejects(readAuthorizedProject(viewer.id, project.id, async () => { readCalled = true; }), error => error instanceof ProjectReadError && error.status === 404);
  assert.equal(readCalled, false, 'cached bindings must never bypass revoked access');
});

/** A separate process changes the grant or storage mapping after the SDK read and before admission. */
test('reads discard results when authorization or storage binding changes in flight', async t => {
  const { viewer, project, item } = await fixture(t);
  for (const action of ['downgrade', 'rebind', 'revoke']) {
    await t.test(action, async () => {
      await pool.query("UPDATE pm_project_shares SET permission='edit' WHERE project_id=$1", [project.id]);
      await assert.rejects(readAuthorizedProject(viewer.id, project.id, async reader => {
        const result = await reader.get(item.id);
        await change(action, project.id, viewer.id);
        return result;
      }), error => error instanceof ProjectReadError && error.status === (action === 'revoke' ? 404 : 409));
      if (action === 'rebind') await pool.query('UPDATE pm_projects SET slug=$2 WHERE id=$1', [project.id, project.slug]);
    });
  }
});

/** Provider failures and invalid references remain distinct from absent authority, without leaking paths. */
test('authorized reads fail closed for corrupt or absent trackers and invalid historical references', async t => {
  const { server, viewer, outsider, project, pmRoot, item, cwd } = await fixture(t);
  const base = `/api/projects/${project.id}/pm`;
  const invalid = await authedFetch(server, viewer, `${base}/at/${item.id}/invalid-ref`);
  assert.equal(invalid.status, 400);
  assert.equal((await authedFetch(server, viewer, `${base}/get/contract-missing`)).status, 404);
  const file = path.join(pmRoot, 'tasks', `${item.id}.toon`);
  await writeFile(file, 'invalid tracker bytes: [');
  const refused = await authedFetch(server, viewer, `${base}/export`);
  assert.equal(refused.status, 503);
  assert.doesNotMatch(await refused.text(), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await rm(pmRoot, { recursive: true });
  assert.equal((await authedFetch(server, viewer, `${base}/search?q=needle`)).status, 503);
  assert.equal((await authedFetch(server, outsider, `${base}/search?q=needle`)).status, 404);
  assert.equal(existsSync(pmRoot), false, 'a read must not bootstrap an absent tracker');
});

/** Relative deployment roots and resolved SDK bindings must share one local mutation queue. */
test('directory bindings serialize relative and absolute aliases of the same tracker', async t => {
  const { cwd, pmRoot, item, client } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = runSerialized(path.relative(process.cwd(), cwd), () => gate);
  let entered = false;
  const queued = runSerialized(cwd, async () => { entered = true; return client.get(item.id); });
  try {
    await change('update-item', pmRoot, item.id);
    assert.equal(entered, false, 'resolved read binding overtook the existing relative-root queue');
  } finally {
    release();
    await held;
    await queued;
  }
});

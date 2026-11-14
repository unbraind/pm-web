/** Real two-slot pool regressions for queue-before-transaction deletion admission. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { deferred } from './helpers/deferred.ts';
import { ProjectFixtureResources, ensureSchema, seedProject, authedFetch } from './helpers/pg-harness.ts';
import { pool } from '../src/db.ts';
import { getProjectDir, runSerialized } from '../src/services/pm-runner.ts';
import { readAuthorizedProject } from '../src/services/authorized-project-reads.ts';
import { startRealtimeBus } from '../src/services/realtime-bus.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';

/** Observe real metadata discovery, then acknowledge a later admission without replacing any API. */
async function queuedDelete(cwd: string, request: () => Promise<Response>) {
  const discovered = deferred<void>(), joined = deferred<void>();
  const original = fs.promises.realpath;
  Reflect.set(fs.promises, 'realpath', new Proxy(original, { apply(target, receiver, args) {
    if (String(args[0]) === cwd) discovered.resolve();
    return Reflect.apply(target, receiver, args);
  } }));
  const deletion = request();
  try { await discovered.promise; }
  finally { Reflect.set(fs.promises, 'realpath', original); }
  const follower = runSerialized(cwd, async () => undefined, joined.resolve);
  await joined.promise;
  return { deletion, follower };
}

/** Fail before the pool's five-second acquisition timeout; always clear the assertion timer. */
async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('unrelated request or final access check starved by queued deletion')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

/** Own a real non-git tracker, project rows and HTTP listener for one deletion interleaving. */
async function deletionFixture(t: test.TestContext) {
  const resources = new ProjectFixtureResources(t);
  await resources.directory('delete-pool-', true);
  const owner = await resources.user(), project = await seedProject(owner.id);
  const cwd = getProjectDir(owner.id, project.slug);
  const { client } = await createPlainContractTracker(cwd);
  const { item } = await client.create({ type: 'Task', title: 'Retained through row race' });
  const server = await resources.server();
  return { resources, owner, project, cwd, client, item, server,
    request: () => authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' }) };
}

test('deletion admission with a two-connection pool and realtime', async t => {
  if (process.env.PM_WEB_DB_POOL_MAX !== '2') {
    const result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET,
        PM_WEB_TEST_SCHEMA_READY: process.env.PM_WEB_TEST_SCHEMA_READY, PM_WEB_DB_POOL_MAX: '2', PM_AUTHOR: 'delete-pool-test' }, timeout: 60_000,
    }).catch(error => { throw new Error(String((error as { stdout?: string }).stdout ?? error)); });
    assert.match(result.stdout, /# fail 0/);
    return;
  }
  assert.equal(pool.options.max, 2);
  await ensureSchema();
  for (const check of ['unrelated', 'final-access'] as const) await t.test(check, async t => {
    const { owner, project, cwd, item, server, request } = await deletionFixture(t);
    const stop = await startRealtimeBus();
    const entered = deferred<void>(), release = deferred<void>();
    const read = readAuthorizedProject(owner.id, project.id, async reader => {
      entered.resolve(); await release.promise; return (await reader.get(item.id)).item.id;
    });
    const observed = read.then(value => ({ value }), error => ({ error }));
    let pending: Awaited<ReturnType<typeof queuedDelete>> | undefined;
    try {
      await entered.promise;
      pending = await queuedDelete(cwd, request);
      if (check === 'unrelated') {
        const response = await promptly(authedFetch(server, owner, '/api/projects'));
        assert.equal(response.status, 200);
      }
      release.resolve();
      assert.deepEqual(await promptly(observed), { value: item.id });
      assert.equal((await pending.deletion).status, 200);
      await pending.follower;
    } finally {
      release.resolve(); await observed;
      if (pending) await Promise.allSettled([pending.deletion, pending.follower]);
      await stop();
    }
  });
  for (const change of ['removed', 'owner', 'slug'] as const) await t.test(`row ${change} before lock`, async t => {
    const { resources, project, cwd, client, item, request } = await deletionFixture(t);
    const other = await resources.user();
    const entered = deferred<void>(), release = deferred<void>();
    const held = runSerialized(cwd, async () => { entered.resolve(); await release.promise; });
    let pending: Awaited<ReturnType<typeof queuedDelete>> | undefined;
    try {
      await entered.promise;
      pending = await queuedDelete(cwd, request);
      if (change === 'removed') await pool.query('DELETE FROM pm_projects WHERE id=$1', [project.id]);
      else if (change === 'owner') await pool.query('UPDATE pm_projects SET user_id=$1 WHERE id=$2', [other.id, project.id]);
      else await pool.query('UPDATE pm_projects SET slug=$1 WHERE id=$2', [`${project.slug}-changed`, project.id]);
      release.resolve();
      assert.equal((await pending.deletion).status, change === 'slug' ? 409 : 404);
      assert.equal((await stat(cwd)).isDirectory(), true);
      assert.equal((await client.get(item.id)).item.title, 'Retained through row race');
    } finally {
      release.resolve(); await held;
      if (pending) await Promise.allSettled([pending.deletion, pending.follower]);
    }
  });
});

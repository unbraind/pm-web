import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs, { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { pool } from '../src/db.ts';
import { ProjectReadError, readAuthorizedProject, type ProjectItemReader } from '../src/services/authorized-project-reads.ts';
import { pinProjectStorage, readCompletePmItems, runGetItemAt, runOnPinnedStorage, runPm, runSerialized } from '../src/services/pm-runner.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { ProjectFixtureResources, authedFetch, ensureSchema, seedProject, seedUser, seedUserShare, startApp } from './helpers/pg-harness.ts';
import { captureLogs, setLogLevel } from './helpers/stdout-logs.ts';

/** Own one isolated real tracker, grant set and HTTP server through test teardown. */
async function fixture(t: Pick<TestContext, 'after'>, checkpoint: (stage: string, value?: string) => void = () => undefined) {
  const resources = new ProjectFixtureResources(t);
  await ensureSchema();
  const root = await resources.directory('authorized-reads-', true);
  checkpoint('directory', root);
  const owner = await resources.user(); checkpoint('owner', owner.id);
  const viewer = await resources.user(); checkpoint('viewer', viewer.id);
  const outsider = await resources.user(); checkpoint('outsider', outsider.id);
  const project = await seedProject(owner.id); checkpoint('project', project.id);
  await seedUserShare(project.id, viewer.id, 'view'); checkpoint('share');
  const cwd = path.join(root, owner.id, project.slug);
  const { client, pmRoot } = await createPlainContractTracker(cwd); checkpoint('tracker');
  const { item } = await client.create({ type: 'Task', title: 'Authorized native item', description: 'Synthetic read fixture', body: 'full body needle' }); checkpoint('item');
  const server = await resources.server(); checkpoint('server', server.url('/'));
  return { root, cwd, pmRoot, client, item, server, owner, viewer, outsider, project };
}

/** Inject a failure after every real acquisition, without replacing the SDK, SQL or HTTP server. */
test('partial fixture acquisition cleans every resource and restores the previous project root', async t => {
  const previous = process.env.PROJECTS_ROOT;
  for (const failure of ['directory', 'owner', 'viewer', 'outsider', 'project', 'share', 'tracker', 'item', 'server']) {
    let cleanup: () => Promise<void> = async () => { assert.fail('teardown was not registered before setup'); };
    const observed = new Map<string, string>();
    try {
      await assert.rejects(fixture({ after: fn => { cleanup = async () => { await fn?.(t, () => undefined); }; } }, (stage, value) => {
        if (value) observed.set(stage, value);
        if (stage === failure) throw new Error('synthetic setup failure');
      }), /synthetic setup failure/);
    } finally { await cleanup(); }
    assert.equal(process.env.PROJECTS_ROOT, previous, failure);
    assert.equal(existsSync(observed.get('directory')!), false, failure);
    const users = ['owner', 'viewer', 'outsider'].flatMap(key => observed.has(key) ? [observed.get(key)!] : []);
    assert.equal((await pool.query('SELECT id FROM pm_users WHERE id=ANY($1::uuid[])', [users])).rowCount, 0, failure);
    if (observed.has('server')) await assert.rejects(fetch(observed.get('server')!));
  }
});

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
      if (endpoint === 'board') {
        const board = await response.json() as { count: number; columns: Array<{ items: Array<{ id: string }> }> };
        assert.equal(board.count, 1);
        assert.ok(board.columns.some(column => column.items.some(row => row.id === item.id)));
      }
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
  assert.notEqual(await capture(viewer.id.toUpperCase()), first, 'each callback owns a fresh scoped facade for the normalized principal');
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

/** Escaped readers, including extracted methods, expire on success, failure and final admission refusal. */
test('reader capabilities expire when their owning callback settles', async t => {
  const { viewer, project, item } = await fixture(t);
  for (const outcome of ['success', 'failure', 'revoked']) {
    await seedUserShare(project.id, viewer.id, 'view');
    let captured!: ProjectItemReader;
    const pending = readAuthorizedProject(viewer.id, project.id, async reader => {
      captured = reader;
      assert.equal((await reader.get(item.id)).item.id, item.id);
      await reader.complete();
      await reader.at(item.id, '1');
      await reader.contracts();
      if (outcome === 'failure') throw new Error('synthetic callback failure');
      if (outcome === 'revoked') await change('revoke', project.id, viewer.id);
      return reader;
    });
    if (outcome === 'success') assert.equal(await pending, captured);
    else await assert.rejects(pending);
    await change('revoke', project.id, viewer.id);
    const { get, complete, at, contracts } = captured;
    for (const operation of [() => get(item.id), () => complete(true), () => at(item.id, '1'), () => contracts()]) {
      await assert.rejects(operation(), error => error instanceof ProjectReadError && error.status === 409);
    }
  }
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
test('directory bindings serialize physical, relative and symlink aliases of a non-git tracker', async t => {
  const { cwd, pmRoot, item, client } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const alias = path.join(path.dirname(cwd), 'workspace-alias');
  await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const held = runOnPinnedStorage(await pinProjectStorage(alias), () => gate);
  let entered = false;
  const queued = Promise.all([cwd, path.relative(process.cwd(), cwd), path.join(alias, '.')].map(directory =>
    runSerialized(directory, async () => { entered = true; return client.get(item.id); })));
  try {
    await change('update-item', pmRoot, item.id);
    assert.equal(entered, false, 'resolved read binding overtook the existing relative-root queue');
  } finally {
    release();
    await held;
    await queued;
  }
});

/** Initial authorization does not permit storage reads after a separately committed queued revocation. */
test('revocation while an authorized read is queued prevents its storage callback', async t => {
  const { viewer, project, cwd, item } = await fixture(t);
  let release!: () => void, selected!: () => void;
  const held = runOnPinnedStorage(await pinProjectStorage(cwd), () => new Promise<void>(resolve => { release = resolve; }));
  const authorized = new Promise<void>(resolve => { selected = resolve; });
  let called = false;
  const pending = readAuthorizedProject(viewer.id, project.id, async reader => { called = true; return reader.get(item.id); }, selected);
  const refused = assert.rejects(pending, error => error instanceof ProjectReadError && error.status === 404);
  try {
    await authorized;
    await change('revoke', project.id, viewer.id);
  } finally { release(); }
  await held;
  await refused;
  assert.equal(called, false, 'final authorization alone must not allow the storage callback to run');
});

/** Exercise the same real diagnostic requests for the supplied platform's permission semantics. */
async function failedReadReasons(t: TestContext, platform: NodeJS.Platform): Promise<unknown[]> {
  const { server, viewer, project, pmRoot, cwd } = await fixture(t);
  setLogLevel(t, 'error');
  const lines = captureLogs(t);
  const endpoint = `/api/projects/${project.id}/pm/search?q=needle`;
  const requests: Array<{ reason: string; requestId: string | null }> = [];
  // Windows chmod cannot remove read access; missing-root coverage still runs there.
  if (platform !== 'win32') {
    const mode = (await stat(pmRoot)).mode & 0o7777;
    try {
      await chmod(pmRoot, 0);
      const response = await authedFetch(server, viewer, endpoint);
      assert.equal(response.status, 503);
      requests.push({ reason: 'tracker_root_unreadable', requestId: response.headers.get('x-request-id') });
      assert.deepEqual(await response.json(), { error: 'Project items are temporarily unavailable', code: 'project_read_unavailable' });
    } finally { await chmod(pmRoot, mode); }
  }
  await rm(pmRoot, { recursive: true });
  const missing = await authedFetch(server, viewer, endpoint);
  assert.equal(missing.status, 503);
  requests.push({ reason: 'tracker_root_missing', requestId: missing.headers.get('x-request-id') });
  const records = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.event === 'project_read_unavailable');
  assert.deepEqual(records.map(row => ({ reason: row.reason, requestId: row.request_id })), requests);
  assert.ok(requests.every(row => row.requestId));
  for (const secret of [cwd, viewer.id, project.id, 'needle']) assert.equal(JSON.stringify(records).includes(secret), false);
  return records.map(row => row.reason);
}

/** Log only SDK reason categories and the middleware's generated request identity, never provider paths. */
test('failed project reads log distinct safe reasons with the response request identity', async t => {
  const reasons = await failedReadReasons(t, process.platform);
  assert.deepEqual(reasons, process.platform === 'win32'
    ? ['tracker_root_missing'] : ['tracker_root_unreadable', 'tracker_root_missing']);
});

/** Exercise Windows scheduling on every host without mocking SDK storage, grants or HTTP responses. */
test('Windows diagnostics retain missing-root coverage without POSIX unreadability', async t => {
  assert.deepEqual(await failedReadReasons(t, 'win32'), ['tracker_root_missing']);
});

/** Replace a directory symlink without removing the storage it currently names. */
async function retarget(link: string, target: string): Promise<void> {
  await rm(link);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** A queued or running read must keep the storage captured at admission and refuse a later symlink switch. */
test('storage switches cannot escape authorized reads or queued SDK and CLI commands', async t => {
  const { root, cwd, owner, viewer, project, item } = await fixture(t);
  assert.equal(existsSync(path.join(cwd, '.git')), false);
  const storageA = path.join(root, 'storage-a');
  const storageB = path.join(root, 'storage-b');
  await rename(cwd, storageA);
  await symlink(storageA, cwd, process.platform === 'win32' ? 'junction' : 'dir');
  const other = await createPlainContractTracker(storageB);
  await other.client.create({ type: 'Task', title: 'SWITCHED-TARGET', description: 'Retargeted storage', body: 'must not be released' });
  const link = process.platform === 'win32' ? 'junction' : 'dir';

  for (const method of ['get', 'at', 'complete'] as const) {
    await retarget(cwd, storageA);
    let seen = '';
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let continueRead!: () => void;
    const switched = new Promise<void>(resolve => { continueRead = resolve; });
    const pending = readAuthorizedProject(viewer.id, project.id, async reader => {
      ready();
      await switched;
      if (method === 'get') seen = (await reader.get(item.id)).item.title ?? '';
      else if (method === 'at') seen = (await reader.at(item.id, '1')).document.metadata.title ?? '';
      else seen = (await reader.complete()).items.find(row => row.id === item.id)?.title ?? '';
      return seen;
    });
    await started;
    await retarget(cwd, storageB);
    continueRead();
    await assert.rejects(pending, error => error instanceof ProjectReadError && error.status === 409, method);
    assert.equal(seen, item.title, method);
    assert.notEqual(seen, 'SWITCHED-TARGET', method);
  }

  await retarget(cwd, storageA);
  const admitted = (await pinProjectStorage(cwd));
  let release!: () => void;
  const held = runOnPinnedStorage(admitted, () => new Promise<void>(resolve => { release = resolve; }));
  let entered = false;
  let selected!: () => void;
  const authorized = new Promise<void>(resolve => { selected = resolve; });
  const queued = readAuthorizedProject(viewer.id, project.id, async () => { entered = true; return 1; }, selected);
  const refused = assert.rejects(queued, error => error instanceof ProjectReadError && error.status === 409);
  try {
    await authorized;
    await retarget(cwd, storageB);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(entered, false, 'queued read followed the new target while holding the old tracker queue');
  } finally { release(); }
  await held;
  await refused;
  assert.equal(entered, false);

  const trackerA = path.join(root, 'tracker-a');
  const trackerB = path.join(root, 'tracker-b');
  await retarget(cwd, storageA);
  await rename(path.join(storageA, '.agents', 'pm'), trackerA);
  await symlink(trackerA, path.join(storageA, '.agents', 'pm'), link);
  const trackerWorkspace = path.join(root, 'tracker-b-workspace');
  await mkdir(trackerB, { recursive: true });
  await mkdir(trackerWorkspace, { recursive: true });
  const switchedTracker = new PmClient({ pmRoot: trackerB, cwd: trackerWorkspace, noExtensions: true, author: 'contract-test' });
  await switchedTracker.init('contract', { defaults: true, agentGuidance: 'skip' });
  await switchedTracker.create({ type: 'Task', title: 'SWITCHED-TARGET', description: 'Retargeted tracker' });
  let trackerSeen = '';
  let trackerReady!: () => void;
  const trackerStarted = new Promise<void>(resolve => { trackerReady = resolve; });
  let trackerContinue!: () => void;
  const trackerSwitched = new Promise<void>(resolve => { trackerContinue = resolve; });
  const trackerRead = readAuthorizedProject(viewer.id, project.id, async reader => {
    trackerReady();
    await trackerSwitched;
    trackerSeen = (await reader.get(item.id)).item.title ?? '';
    return trackerSeen;
  });
  await trackerStarted;
  await retarget(path.join(storageA, '.agents', 'pm'), trackerB);
  trackerContinue();
  await assert.rejects(trackerRead, error => error instanceof ProjectReadError && error.status === 409);
  assert.equal(trackerSeen, item.title);
  await retarget(path.join(storageA, '.agents', 'pm'), trackerA);

  for (const timeoutMs of [undefined, 30_000]) for (const jsonOutput of [false, true]) {
    await retarget(cwd, storageA);
    const pin = (await pinProjectStorage(cwd));
    let releaseCommand!: () => void;
    const commandHeld = runOnPinnedStorage(pin, () => new Promise<void>(resolve => { releaseCommand = resolve; }));
    let settled = false;
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const command = runPm({ userId: owner.id, slug: project.slug, args: ['get', item.id], jsonOutput, timeoutMs, onStoragePinned: admitted }).then(result => { settled = true; return result; });
    await admission;
    await retarget(cwd, storageB);
    assert.equal(settled, false, `json ${String(jsonOutput)} followed the retargeted workspace`);
    releaseCommand();
    const result = await command;
    await commandHeld;
    assert.equal(result.ok, true, result.stderr);
    assert.match(result.stdout, new RegExp(item.title));
    assert.doesNotMatch(result.stdout, /SWITCHED-TARGET/);
  }
  await retarget(cwd, storageA);
  const historicalPin = (await pinProjectStorage(cwd));
  let releaseHistory!: () => void;
  const historyHeld = runOnPinnedStorage(historicalPin, () => new Promise<void>(resolve => { releaseHistory = resolve; }));
  let historySettled = false;
  let historyAdmitted!: () => void;
  const historyAdmission = new Promise<void>(resolve => { historyAdmitted = resolve; });
  const historical = runGetItemAt(owner.id, project.slug, item.id, '1', historyAdmitted).then(result => { historySettled = true; return result; });
  await historyAdmission;
  await retarget(cwd, storageB);
  assert.equal(historySettled, false, 'historical read followed the retargeted workspace');
  releaseHistory();
  assert.equal((await historical).document.metadata.title, item.title);
  await historyHeld;
  await retarget(cwd, storageA);
  const listPin = (await pinProjectStorage(cwd));
  let releaseList!: () => void;
  const listHeld = runOnPinnedStorage(listPin, () => new Promise<void>(resolve => { releaseList = resolve; }));
  let listSettled = false;
  let listAdmitted!: () => void;
  const listAdmission = new Promise<void>(resolve => { listAdmitted = resolve; });
  const listed = readCompletePmItems(owner.id, project.slug, false, true, false, listAdmitted).then(result => { listSettled = true; return result; });
  await listAdmission;
  await retarget(cwd, storageB);
  assert.equal(listSettled, false, 'complete read followed the retargeted workspace');
  releaseList();
  const complete = await listed;
  await listHeld;
  assert.equal(complete.ok, true, complete.ok ? '' : complete.stderr);
  assert.equal(complete.ok && complete.result.items.some(row => row.title === 'SWITCHED-TARGET'), false);
  assert.equal(complete.ok && complete.result.items.some(row => row.id === item.id), true);
});


/** An enabled schema extension cannot silently hide its items behind a no-extensions certificate. */
test('observational reads refuse extension-defined item folders without activating extension code', async t => {
  const { cwd, pmRoot, client, server, viewer, project } = await fixture(t);
  const directory = path.join(pmRoot, 'extensions', 'custom-type');
  const marker = path.join(directory, 'activated');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ name: 'custom-type', version: '1.0.0', entry: './index.mjs', capabilities: ['schema'], contributions: { schema_version: 1, item_types: ['HiddenRecord'] } }));
  await writeFile(path.join(directory, 'index.mjs'), "import { writeFileSync } from 'node:fs'; export function activate(api) { api.registerItemTypes([{ name: 'HiddenRecord', folder: 'extension-records' }]); writeFileSync(new URL('./activated', import.meta.url), 'activated'); }");
  const active = new PmClient({ cwd, pmRoot });
  const hidden = await active.create({ type: 'HiddenRecord', title: 'Extension-only record', description: 'Synthetic schema completeness proof' });
  assert.equal(existsSync(marker), true, 'the control extension really registered the item type');
  const complete = await active.listAllComplete();
  assert.ok(complete.items.some(item => item.id === hidden.item.id));
  await rm(marker);
  const incomplete = await client.listAllComplete();
  assert.equal(incomplete.complete_list.source_complete, true, 'the SDK control certifies its narrower no-extensions scan');
  assert.equal(incomplete.items.some(item => item.id === hidden.item.id), false);
  for (const endpoint of ['board', 'search?q=Extension-only', 'export', 'calendar.ics', `get/${hidden.item.id}`, `at/${hidden.item.id}/1`]) {
    const response = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/${endpoint}`);
    assert.equal(response.status, 503, `${endpoint}: ${await response.clone().text()}`);
    assert.deepEqual(await response.json(), { error: 'Project items are temporarily unavailable', code: 'project_read_unavailable' });
    const head = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/${endpoint}`, { method: 'HEAD' });
    assert.equal(head.status, 503, endpoint);
    assert.equal(existsSync(marker), false, 'the viewer must not activate code to discover its schema');
  }
  // File-backed custom types are safe because the SDK can establish their actual folders without activation.
  await rm(directory, { recursive: true });
  await client.schemaAddType('PersistedRecord', { folder: 'custom-persisted-folder' });
  const persisted = await client.create({ type: 'PersistedRecord', title: 'Safe configured record' });
  const board = await authedFetch(server, viewer, `/api/projects/${project.id}/pm/board`);
  assert.equal(board.status, 200);
  const rows = await board.json() as { columns: { items: { id: string }[] }[] };
  assert.ok(rows.columns.some(column => column.items.some(item => item.id === persisted.item.id)));
});


/** The last SQL grant check must follow storage awaits so a paused lookup cannot release stale authority. */
test('revocation during the final asynchronous storage check refuses the read result', async t => {
  const { viewer, project, item } = await fixture(t);
  const original = fs.promises.realpath;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const pending = readAuthorizedProject(viewer.id, project.id, async reader => {
    const result = await reader.get(item.id);
    fs.promises.realpath = new Proxy(original, { async apply(target, receiver, args) { entered(); await gate; return Reflect.apply(target, receiver, args); } });
    return result;
  });
  const refused = assert.rejects(pending, error => error instanceof ProjectReadError && error.status === 404);
  try { await paused; await change('revoke', project.id, viewer.id); }
  finally {
    release();
    try { await refused; } finally { Reflect.set(fs.promises, 'realpath', original); }
  }
});

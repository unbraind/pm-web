import { deferred } from './helpers/deferred.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { evictPmClient, getPmClient, pinProjectStorage, runOnPinnedStorage, runSerialized } from '../src/services/pm-runner.ts';
import { workspaceAliasProbe } from './helpers/workspace-alias-probe.ts';

test('every workspace alias shares dispatch serialization and client identity', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'workspace-alias-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await workspaceAliasProbe(root);
});


/** Dangling links must select the future physical tracker before any queued work starts. */
test('dangling tracker aliases share a lexical target queue before and after initialization', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dangling-tracker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'storage');
  const target = path.join(store, '.agents', 'pm');
  const aliases = [path.join(root, 'first'), path.join(root, 'second')];
  for (const alias of aliases) {
    await mkdir(path.join(alias, '.agents'), { recursive: true });
    const link = path.join(alias, '.agents', 'pm');
    await symlink(process.platform === 'win32' ? target : path.relative(path.dirname(link), target), link,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const alias of aliases) assert.equal((await pinProjectStorage(alias)).tracker, target);
  let release!: () => void;
  const held = runOnPinnedStorage(await pinProjectStorage(aliases[0]!), () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  let entered = false;
  const admitted = deferred<void>();
  const queued = runSerialized(aliases[1]!, async storage => {
    entered = true;
    const result = await new PmClient({ cwd: store, pmRoot: storage.tracker, noExtensions: true }).listAllComplete();
    assert.equal(result.items.length, 0);
  }, admitted.resolve);
  try {
    await admitted.promise;
    assert.equal(entered, false, 'a dangling alias must not select its own independent queue');
    await mkdir(store, { recursive: true });
    await new PmClient({ cwd: store, pmRoot: target, noExtensions: true }).init('dangling', { defaults: true, agentGuidance: 'skip' });
    for (const alias of aliases) assert.equal((await pinProjectStorage(alias)).tracker, target);
    assert.equal(entered, false, 'creating the target must not change an admitted queue');
  } finally { release(); await held; await queued; }
});

/** A dangling ancestor link resolves missing descendants against its target rather than its alias. */
test('dangling workspace ancestor aliases retain one target for missing tracker descendants', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dangling-ancestor-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'missing', 'workspace');
  for (const name of ['first', 'second']) {
    const alias = path.join(root, name);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const pinned = (await pinProjectStorage(path.join(alias, 'nested')));
    assert.equal(pinned.workspace, path.join(target, 'nested'));
    assert.equal(pinned.tracker, path.join(target, 'nested', '.agents', 'pm'));
  }
});

/** Looping identities must remain usable for queue selection and idempotent cache eviction. */
test('tracker symlink loops use lexical identities without throwing during queue selection or eviction', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'looping-tracker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const tracker = path.join(workspace, '.agents', 'pm');
  await mkdir(path.dirname(tracker), { recursive: true });
  await symlink(tracker, tracker, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await pinProjectStorage(workspace)).tracker, tracker);
  const client = (await getPmClient(tracker));
  await assert.doesNotReject(evictPmClient(tracker));
  assert.notEqual((await getPmClient(tracker)), client);
  await runSerialized(workspace, async selected => { assert.equal(selected.tracker, tracker); });
  (await evictPmClient(tracker));
});


/** A pending metadata read yields to the event loop instead of entering a synchronous syscall. */
test('physical storage resolution yields while asynchronous filesystem metadata is pending', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'async-storage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalAsync = fs.promises.realpath;
  const originalSync = fs.realpathSync.native;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let syncCalls = 0, asyncCalls = 0, settled = false;
  fs.realpathSync.native = new Proxy(originalSync, { apply(target, receiver, args) { syncCalls++; return Reflect.apply(target, receiver, args); } });
  fs.promises.realpath = new Proxy(originalAsync, { async apply(target, receiver, args) { asyncCalls++; await gate; return Reflect.apply(target, receiver, args); } });
  let pending: Promise<unknown> | undefined;
  try {
    pending = pinProjectStorage(root).then(value => { settled = true; return value; });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(settled, false, 'the event-loop callback must run while metadata is still pending');
    assert.ok(asyncCalls > 0, 'metadata must use the asynchronous filesystem API');
    assert.equal(syncCalls, 0, 'path resolution must never enter realpathSync');
  } finally {
    release();
    try { await pending; } finally { Reflect.set(fs.promises, 'realpath', originalAsync); Reflect.set(fs.realpathSync, 'native', originalSync); }
  }
});

/** The workspace selected by the first realpath remains the client's sole anchor. */
test('client lookup and eviction stay on the captured workspace when its symlink switches', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'client-switch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second'), alias = path.join(root, 'alias');
  for (const workspace of [first, second]) {
    await mkdir(workspace);
    await new PmClient({ cwd: workspace, pmRoot: path.join(workspace, '.agents', 'pm'), noExtensions: true })
      .init('client-switch', { defaults: true, agentGuidance: 'skip' });
  }
  const tracker = (workspace: string) => path.join(workspace, '.agents', 'pm');
  const firstClient = await getPmClient(tracker(first)), secondClient = await getPmClient(tracker(second));
  const original = fs.promises.realpath;
  for (const evict of [false, true]) {
    await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const captured = deferred<void>(), release = deferred<void>();
    fs.promises.realpath = new Proxy(original, {
      async apply(target, receiver, args) {
        const result = await Reflect.apply(target, receiver, args);
        if (String(args[0]) === alias) { captured.resolve(); await release.promise; }
        return result;
      },
    });
    const pending = evict ? evictPmClient(tracker(alias)) : getPmClient(tracker(alias));
    try {
      await captured.promise;
      await rm(alias);
      await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir');
      release.resolve();
      const client = await pending;
      if (!evict) assert.equal(client, firstClient, 'lookup must not mix the first cwd with the second tracker');
      else assert.notEqual(await getPmClient(tracker(first)), firstClient, 'eviction must remove the captured first client');
      assert.equal(await getPmClient(tracker(second)), secondClient, 'the second workspace client must remain untouched');
    } finally {
      release.resolve();
      await pending;
      Reflect.set(fs.promises, 'realpath', original);
      await rm(alias);
    }
  }
});

/** Exercise physical-prefix comparisons on every host, including hosts whose temp root is already canonical. */
test('workspace path assertions accept a symlinked temporary-directory prefix', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'temp-prefix-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physical = path.join(root, 'physical'), logical = path.join(root, 'logical');
  await mkdir(physical);
  await symlink(physical, logical, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await promisify(execFile)(process.execPath, ['--test', '--test-concurrency=2',
    '--test-name-pattern=^(dangling tracker|dangling workspace|tracker symlink loops|client lookup and eviction|spawn fallback stays)',
    fileURLToPath(import.meta.url), fileURLToPath(new URL('./pm-runner.test.ts', import.meta.url))], { env: { PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter), TMPDIR: logical, TMP: logical, TEMP: logical, PM_AUTHOR: 'temp-prefix-test' }, timeout: 60_000 });
  assert.match(result.stdout, /pass 5/);
});

/** Run real nested tests from a non-system Node location with only explicit child configuration. */
test('nested alias tests retain a non-system Node search path and isolate PM context', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'node-search-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const node = path.join(bin, path.basename(process.execPath));
  await copyFile(process.execPath, node);
  const result = await promisify(execFile)(node, ['--test', '--test-concurrency=1',
    '--test-name-pattern=^workspace path assertions accept', fileURLToPath(import.meta.url)], {
    env: { PATH: bin, TMPDIR: root, TMP: root, TEMP: root, PM_AUTHOR: 'node-search-test', PM_PATH: path.join(root, 'unrelated-tracker') }, timeout: 90_000,
  });
  assert.match(result.stdout, /pass 1/);
});

/** Late metadata must never reverse writes submitted through two aliases of the same tracker. */
test('physical aliases preserve invocation order while independent tracker work overlaps', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'alias-arrival-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'physical'), alias = path.join(root, 'alias'), other = path.join(root, 'other');
  await mkdir(workspace); await mkdir(other);
  const client = new PmClient({ cwd: workspace, pmRoot: path.join(workspace, '.agents', 'pm'), noExtensions: true, author: 'alias-order-test' });
  await client.init('arrival', { defaults: true, agentGuidance: 'skip' });
  const { item } = await client.create({ type: 'Task', title: 'Initial' });
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const captured = deferred<void>(), releaseMetadata = deferred<void>(), laterResolved = deferred<void>();
  const firstEntered = deferred<void>(), releaseFirst = deferred<void>(), independentEntered = deferred<void>();
  const original = fs.promises.realpath;
  Reflect.set(fs.promises, 'realpath', new Proxy(original, { async apply(target, receiver, args) {
    const result = await Reflect.apply(target, receiver, args);
    const requested = String(args[0]);
    if (requested === alias) { captured.resolve(); await releaseMetadata.promise; }
    if (requested === path.join(workspace, '.agents', 'pm')) laterResolved.resolve();
    return result;
  } }));
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(runSerialized(alias, async storage => {
      events.push('first');
      assert.equal(storage.tracker, path.join(workspace, '.agents', 'pm'));
      await client.update(item.id, { title: 'First' });
      firstEntered.resolve();
      await releaseFirst.promise;
    }));
    await captured.promise;
    pending.push(runSerialized(workspace, async () => { events.push('second'); await client.update(item.id, { title: 'Second' }); }));
    pending.push(runSerialized(other, async () => { events.push('independent'); independentEntered.resolve(); }));
    await laterResolved.promise;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(events.includes('second'), false, 'a later alias must wait for the earlier invocation to resolve');
    releaseMetadata.resolve();
    await firstEntered.promise;
    await independentEntered.promise;
    assert.equal(events.includes('second'), false, 'the shared tracker remains serialized while independent work completes');
    assert.equal((await client.get(item.id)).item.title, 'First');
    releaseFirst.resolve();
    await Promise.all(pending);
    assert.equal((await client.get(item.id)).item.title, 'Second', 'the later invocation must persist last');
    assert.deepEqual(events, ['first', 'independent', 'second']);
  } finally {
    releaseMetadata.resolve(); releaseFirst.resolve();
    try { await Promise.allSettled(pending); } finally { Reflect.set(fs.promises, 'realpath', original); }
  }
});

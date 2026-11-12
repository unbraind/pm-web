import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { evictPmClient, getPmClient, pinProjectStorage, runSerialized } from '../src/services/pm-runner.ts';
import { workspaceAliasProbe } from './helpers/workspace-alias-probe.ts';

test('every workspace alias shares dispatch serialization and client identity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await workspaceAliasProbe(root);
});


/** Dangling links must select the future physical tracker before any queued work starts. */
test('dangling tracker aliases share a lexical target queue before and after initialization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dangling-tracker-'));
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
  for (const alias of aliases) assert.equal(pinProjectStorage(alias).tracker, target);
  let release!: () => void;
  const held = runSerialized(aliases[0]!, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  let entered = false;
  const queued = runSerialized(aliases[1]!, async storage => {
    entered = true;
    const result = await new PmClient({ cwd: store, pmRoot: storage.tracker, noExtensions: true }).listAllComplete();
    assert.equal(result.items.length, 0);
  });
  try {
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(entered, false, 'a dangling alias must not select its own independent queue');
    await mkdir(store, { recursive: true });
    await new PmClient({ cwd: store, pmRoot: target, noExtensions: true }).init('dangling', { defaults: true, agentGuidance: 'skip' });
    for (const alias of aliases) assert.equal(pinProjectStorage(alias).tracker, target);
    assert.equal(entered, false, 'creating the target must not change an admitted queue');
  } finally { release(); await held; await queued; }
});

/** A dangling ancestor link resolves missing descendants against its target rather than its alias. */
test('dangling workspace ancestor aliases retain one target for missing tracker descendants', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dangling-ancestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'missing', 'workspace');
  for (const name of ['first', 'second']) {
    const alias = path.join(root, name);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const pinned = pinProjectStorage(path.join(alias, 'nested'));
    assert.equal(pinned.workspace, path.join(target, 'nested'));
    assert.equal(pinned.tracker, path.join(target, 'nested', '.agents', 'pm'));
  }
});

/** Looping identities must remain usable for queue selection and idempotent cache eviction. */
test('tracker symlink loops use lexical identities without throwing during queue selection or eviction', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'looping-tracker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const tracker = path.join(workspace, '.agents', 'pm');
  await mkdir(path.dirname(tracker), { recursive: true });
  await symlink(tracker, tracker, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pinProjectStorage(workspace).tracker, tracker);
  const client = getPmClient(tracker);
  assert.doesNotThrow(() => evictPmClient(tracker));
  assert.notEqual(getPmClient(tracker), client);
  await runSerialized(workspace, async selected => { assert.equal(selected.tracker, tracker); });
  evictPmClient(tracker);
});

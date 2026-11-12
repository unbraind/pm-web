import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { evictPmClient, getPmClient, pinProjectStorage, runGetItemAt, runOnPinnedStorage, runPm, runSerialized } from '../../src/services/pm-runner.ts';

/** Exercise physical identity across SDK, CLI, historical reads and both output formats without Git. */
export async function workspaceAliasProbe(root: string): Promise<void> {
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const directory = path.join(root, 'owner', 'physical');
  const alias = path.join(root, 'owner', 'alias');
  const pmRoot = path.join(directory, '.agents', 'pm');
  try {
    await mkdir(directory, { recursive: true });
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const trackerAlias = path.join(root, 'owner', 'tracker-alias');
    await mkdir(path.join(trackerAlias, '.agents'), { recursive: true });
    const client = (await getPmClient(pmRoot));
    await client.init('alias', { defaults: true, agentGuidance: 'skip' });
    await symlink(pmRoot, path.join(trackerAlias, '.agents', 'pm'), process.platform === 'win32' ? 'junction' : 'dir');
    const { item } = await client.create({ type: 'Task', title: 'Physical identity' });
    const aliases = [directory, alias, path.relative(process.cwd(), alias), path.join(alias, 'nested', '..'), trackerAlias];
    for (const candidate of aliases.slice(0, -1)) assert.equal((await getPmClient(path.join(candidate, '.agents', 'pm'))), client);
    const trackerClient = (await getPmClient(path.join(trackerAlias, '.agents', 'pm')));
    assert.notEqual(trackerClient, client, 'shared tracker storage must retain distinct execution workspaces');
    (await evictPmClient(path.join(alias, '.agents', 'pm')));
    assert.notEqual((await getPmClient(pmRoot)), client, 'alias eviction removes the physical cache entry');
    assert.equal((await getPmClient(path.join(trackerAlias, '.agents', 'pm'))), trackerClient, 'eviction preserves other execution workspaces');

    for (const heldDirectory of aliases) {
      let release!: () => void;
      const held = runOnPinnedStorage(await pinProjectStorage(heldDirectory), () => new Promise<void>(resolve => { release = resolve; }));
      await new Promise<void>(resolve => { setImmediate(resolve); });
      let completed = 0;
      const admissions: Promise<void>[] = [];
      /** Register one acknowledgement for each queued SDK, CLI or historical call. */
      function acknowledge(): () => void {
        let admitted!: () => void;
        admissions.push(new Promise<void>(resolve => { admitted = resolve; }));
        return admitted;
      }
      const calls = [
        ...aliases.map(candidate => runSerialized(candidate, async () => { completed++; }, acknowledge())),
        ...[false, true].map(jsonOutput => runPm({ userId: 'owner', slug: 'physical', args: ['get', item.id], jsonOutput, onStoragePinned: acknowledge() }).then(result => {
          assert.equal(result.ok, true, result.stderr); completed++;
        })),
        runPm({ userId: 'owner', slug: 'alias', args: ['get', item.id], jsonOutput: true, timeoutMs: 30_000, onStoragePinned: acknowledge() }).then(result => { assert.equal(result.ok, true, result.stderr); completed++; }),
        runGetItemAt('owner', 'physical', item.id, '1', acknowledge()).then(result => { assert.equal(result.document.metadata.id, item.id); completed++; }),
      ];
      try {
        await Promise.all(admissions);
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(completed, 0, 'no dispatch path may overtake a physical alias');
        const independent = runSerialized(path.join(root, 'independent'), async () => undefined);
        const singleSlot = Number.parseInt(process.env.PM_WEB_PM_CONCURRENCY ?? '8', 10) === 1;
        if (singleSlot) release();
        await independent;
        if (!singleSlot) assert.equal(completed, 0, 'independent work must not release the held alias queue');
      } finally { release(); await held; await Promise.all(calls); }
    }
    for (const candidate of aliases) (await evictPmClient(path.join(candidate, '.agents', 'pm')));
  } finally {
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
  }
  await workspaceCwdProbe(path.join(root, 'cwd-probe'));
  await storageSwitchProbe(path.join(root, 'storage-switch'));
}

/** Prove shared tracker storage never substitutes its Git provenance for any execution workspace. */
async function workspaceCwdProbe(root: string): Promise<void> {
  const keys = ['PROJECTS_ROOT', 'PM_PATH', 'PM_SOURCE_PM_PATH', 'PM_SOURCE_WORKSPACE_ROOT', 'GITHUB_HEAD_REF', 'GITHUB_REF_NAME'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.PROJECTS_ROOT = root;
  const storage = path.join(root, 'storage');
  const tracker = path.join(storage, '.agents', 'pm');
  const roots: string[] = [tracker];
  try {
    await mkdir(storage, { recursive: true });
    assert.equal(spawnSync('git', ['init', '-b', 'tracker-storage'], { cwd: storage }).status, 0);
    await (await getPmClient(tracker)).init('cwd', { defaults: true, agentGuidance: 'skip' });
    const clients = new Set([(await getPmClient(tracker))]);
    for (const slug of ['workspace-a', 'workspace-b', 'non-git']) {
      const directory = path.join(root, 'owner', slug);
      const pmRoot = path.join(directory, '.agents', 'pm');
      roots.push(pmRoot);
      await mkdir(path.dirname(pmRoot), { recursive: true });
      if (slug !== 'non-git') assert.equal(spawnSync('git', ['init', '-b', slug], { cwd: directory }).status, 0);
      await symlink(tracker, pmRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const client = (await getPmClient(pmRoot));
      assert.ok(!clients.has(client), 'distinct cwd requires a distinct client even with shared storage');
      clients.add(client);
      const { item } = await client.create({ type: 'Task', title: `Synthetic ${slug}` });
      const command = 'node -e "process.exit(0)"';
      await client.run('test', { options: { id: item.id, add: command } });
      for (const jsonOutput of [false, true]) {
        const result = await runPm({ userId: 'owner', slug, args: ['test', item.id, '--add', `${command} ${jsonOutput}`], jsonOutput });
        assert.equal(result.ok, true, result.stderr);
      }
      const linked = await client.run('test', { options: { id: item.id } }) as { tests: { provenance?: { source_ref?: string } }[] };
      assert.equal(linked.tests.length, 3);
      for (const entry of linked.tests) assert.equal(entry.provenance?.source_ref, slug === 'non-git' ? undefined : slug, 'SDK and CLI must record the execution workspace branch');
      for (const jsonOutput of [false, true]) {
        const executed = await runPm({ userId: 'owner', slug, args: ['test', item.id, '--run'], jsonOutput, timeoutMs: 30_000 });
        assert.equal(executed.ok, true, executed.stderr || executed.stdout);
      }
    }
  } finally {
    for (const pmRoot of roots) (await evictPmClient(pmRoot));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Point a directory symlink at another real tracker without deleting either store. */
async function retargetStorage(link: string, target: string): Promise<void> {
  await rm(link);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Packed SDK, CLI, JSON, TOON and historical reads must stay on the tracker captured at queue admission. */
export async function storageSwitchProbe(root: string): Promise<void> {
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const logical = path.join(root, 'owner', 'slug');
  const storageA = path.join(root, 'storage-a');
  const storageB = path.join(root, 'storage-b');
  const roots = [path.join(storageA, '.agents', 'pm'), path.join(storageB, '.agents', 'pm')];
  try {
    await mkdir(path.dirname(logical), { recursive: true });
    await mkdir(storageA, { recursive: true });
    await mkdir(storageB, { recursive: true });
    const clientA = (await getPmClient(roots[0]!));
    await clientA.init('switch', { defaults: true, agentGuidance: 'skip' });
    const { item } = await clientA.create({ type: 'Task', title: 'Pinned target' });
    const clientB = (await getPmClient(roots[1]!));
    await clientB.init('switch', { defaults: true, agentGuidance: 'skip' });
    await clientB.create({ type: 'Task', title: 'SWITCHED-TARGET' });
    await symlink(storageA, logical, process.platform === 'win32' ? 'junction' : 'dir');
    for (const timeoutMs of [undefined, 30_000]) for (const jsonOutput of [false, true]) {
      await retargetStorage(logical, storageA);
      const pin = (await pinProjectStorage(logical));
      let release!: () => void;
      const held = runOnPinnedStorage(pin, () => new Promise<void>(resolve => { release = resolve; }));
      let settled = false;
      let admitted!: () => void;
      const admission = new Promise<void>(resolve => { admitted = resolve; });
      const pending = runPm({ userId: 'owner', slug: 'slug', args: ['get', item.id], jsonOutput, timeoutMs, onStoragePinned: admitted }).then(result => { settled = true; return result; });
      await admission;
      await retargetStorage(logical, storageB);
      assert.equal(settled, false, `json ${String(jsonOutput)} followed the retargeted workspace`);
      release();
      const result = await pending;
      await held;
      assert.equal(result.ok, true, result.stderr);
      assert.match(result.stdout, /Pinned target/);
      assert.doesNotMatch(result.stdout, /SWITCHED-TARGET/);
    }
    await retargetStorage(logical, storageA);
    const pin = (await pinProjectStorage(logical));
    let releaseHistory!: () => void;
    const historyHeld = runOnPinnedStorage(pin, () => new Promise<void>(resolve => { releaseHistory = resolve; }));
    let historySettled = false;
    let historyAdmitted!: () => void;
    const admission = new Promise<void>(resolve => { historyAdmitted = resolve; });
    const historical = runGetItemAt('owner', 'slug', item.id, '1', historyAdmitted).then(result => { historySettled = true; return result; });
    await admission;
    await retargetStorage(logical, storageB);
    assert.equal(historySettled, false, 'historical read followed the retargeted workspace');
    releaseHistory();
    assert.equal((await historical).document.metadata.title, 'Pinned target');
    await historyHeld;
  } finally {
    for (const pmRoot of roots) (await evictPmClient(pmRoot));
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
  }
}

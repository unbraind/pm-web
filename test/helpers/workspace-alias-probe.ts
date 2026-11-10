import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { evictPmClient, getPmClient, runGetItemAt, runPm, runSerialized } from '../../src/services/pm-runner.ts';

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
    const client = getPmClient(pmRoot);
    await client.init('alias', { defaults: true, agentGuidance: 'skip' });
    await symlink(pmRoot, path.join(trackerAlias, '.agents', 'pm'), process.platform === 'win32' ? 'junction' : 'dir');
    const { item } = await client.create({ type: 'Task', title: 'Physical identity' });
    const aliases = [directory, alias, path.relative(process.cwd(), alias), path.join(alias, 'nested', '..'), trackerAlias];
    for (const candidate of aliases.slice(0, -1)) assert.equal(getPmClient(path.join(candidate, '.agents', 'pm')), client);
    const trackerClient = getPmClient(path.join(trackerAlias, '.agents', 'pm'));
    assert.notEqual(trackerClient, client, 'shared tracker storage must retain distinct execution workspaces');
    evictPmClient(path.join(alias, '.agents', 'pm'));
    assert.notEqual(getPmClient(pmRoot), client, 'alias eviction removes the physical cache entry');
    assert.equal(getPmClient(path.join(trackerAlias, '.agents', 'pm')), trackerClient, 'eviction preserves other execution workspaces');

    for (const heldDirectory of aliases) {
      let release!: () => void;
      const held = runSerialized(heldDirectory, () => new Promise<void>(resolve => { release = resolve; }));
      await new Promise<void>(resolve => { setImmediate(resolve); });
      let completed = 0;
      const calls = [
        ...aliases.map(candidate => runSerialized(candidate, async () => { completed++; })),
        ...[false, true].map(jsonOutput => runPm({ userId: 'owner', slug: 'physical', args: ['get', item.id], jsonOutput }).then(result => {
          assert.equal(result.ok, true, result.stderr); completed++;
        })),
        runPm({ userId: 'owner', slug: 'alias', args: ['get', item.id], jsonOutput: true, timeoutMs: 30_000 }).then(result => { assert.equal(result.ok, true, result.stderr); completed++; }),
        runGetItemAt('owner', 'physical', item.id, '1').then(result => { assert.equal(result.document.metadata.id, item.id); completed++; }),
      ];
      try {
        await runSerialized(path.join(root, 'independent'), async () => undefined);
        await new Promise<void>(resolve => { setTimeout(resolve, 100); });
        assert.equal(completed, 0, 'no dispatch path may overtake a physical alias');
      } finally { release(); await held; await Promise.all(calls); }
    }
    for (const candidate of aliases) evictPmClient(path.join(candidate, '.agents', 'pm'));
  } finally {
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
  }
  await workspaceCwdProbe(path.join(root, 'cwd-probe'));
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
    await getPmClient(tracker).init('cwd', { defaults: true, agentGuidance: 'skip' });
    const clients = new Set([getPmClient(tracker)]);
    for (const slug of ['workspace-a', 'workspace-b', 'non-git']) {
      const directory = path.join(root, 'owner', slug);
      const pmRoot = path.join(directory, '.agents', 'pm');
      roots.push(pmRoot);
      await mkdir(path.dirname(pmRoot), { recursive: true });
      if (slug !== 'non-git') assert.equal(spawnSync('git', ['init', '-b', slug], { cwd: directory }).status, 0);
      await symlink(tracker, pmRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const client = getPmClient(pmRoot);
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
    for (const pmRoot of roots) evictPmClient(pmRoot);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

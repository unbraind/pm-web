import assert from 'node:assert/strict';
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
    for (const candidate of aliases) assert.equal(getPmClient(path.join(candidate, '.agents', 'pm')), client);
    evictPmClient(path.join(alias, '.agents', 'pm'));
    assert.notEqual(getPmClient(pmRoot), client, 'alias eviction removes the physical cache entry');

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
}

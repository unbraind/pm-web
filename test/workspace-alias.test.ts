import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceAliasProbe } from './helpers/workspace-alias-probe.ts';

test('every workspace alias shares dispatch serialization and client identity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await workspaceAliasProbe(root);
});

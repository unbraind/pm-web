import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { create, init } from '@unbrained/pm-cli/sdk';

test('graph physics and memory catalog work beside a real non-git tracker without git on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-web-graph-no-git-'));
  const bin = path.join(root, 'bin');
  const client = { cwd: root, pmRoot: path.join(root, '.agents/pm'), noExtensions: true };
  try {
    await init('scale', { defaults: true, mergeFence: false, agentGuidance: 'skip' }, client);
    await create({ title: 'Synthetic graph task', type: 'Task', allowDuplicate: true }, client);
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
    const fixture = pathToFileURL(path.resolve('scripts/graph-scale-fixture.ts')).href;
    const physics = pathToFileURL(path.resolve('public/src/views/graph-physics.js')).href;
    const catalog = pathToFileURL(path.resolve('src/services/package-catalog.ts')).href;
    const source = `import {graphFixture} from ${JSON.stringify(fixture)};
      import {tickPhysics} from ${JSON.stringify(physics)};
      import {findCatalogEntry,resolveNpmSpec} from ${JSON.stringify(catalog)};
      const graph=graphFixture(2000);tickPhysics(graph.nodes,graph.edges,graph.params,new Set(),.3);
      if(!graph.nodes.every(node=>Number.isFinite(node.x)))throw new Error('Invalid graph');
      for(const name of ['pm-memory','pm-rlm'])if(!findCatalogEntry(name)||resolveNpmSpec(name)!==null)throw new Error('Catalog gating');
      console.log('non-git graph and catalog accepted');`;
    const filename = path.join(root, 'verify.mjs');
    await writeFile(filename, source);
    const result = execFileSync(process.execPath, [filename], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.match(result, /non-git graph and catalog accepted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

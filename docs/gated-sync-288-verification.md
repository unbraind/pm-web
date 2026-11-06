# Issue 288: verify the existing GH278 provenance repair

The failure was ambiguous importer ownership: both delivered records carried the
unique `gh:unbraind/pm-web#278` key. PR [292](https://github.com/unbraind/pm-web/pull/292)
already repaired the metadata on main (`6ebdee78b81e69b18bbf7aa6b8a392ead329c9e1`).
The original repair commit was `ee1b69c5dc6648f8d9f9d4b7163c1963a987d539`.
`pm-web-5sx6` remains the sole canonical owner. `pm-web-cnhi` retains its closed
status, release `2026.10.29`, delivery evidence and a `related` dependency on the
owner. Neither record nor its append-only history was deleted.

This verification changes documentation and the existing tracking item only.
No product implementation, workflow pin, gate or threshold changes are needed.
The inspected main commit is `1a8ce23d8cb17a867ae0205bffc05f4e10d49f39`.

## Exact historical version and reproduction

The fixture below uses the published `pm-github@2026.10.19` gate with the repo's
pinned PM SDK (`2026.11.2`). It certifies the complete corpus, then restores the
second GH278 owner through the real SDK in a disposable tracker. The negative
control must reproduce the original refusal before the SDK removes the tag.
It also repeats the real GitHub import plan and compares both complete JSON
results and all persisted item/history bytes. A separate tracker initialized
through the SDK tests the same refusal and recovery without Git.

Run from a clean package worktree with dependencies installed. Download the exact
published package locally; no tracked dependency or extension registration changes:

```sh
mkdir -p .pi-subagents/issue-288-tools
NPM_CONFIG_USERCONFIG=/dev/null npm pack pm-github@2026.10.19 --pack-destination .pi-subagents/issue-288-tools --ignore-scripts --silent
tar -xzf .pi-subagents/issue-288-tools/pm-github-2026.10.19.tgz -C .pi-subagents/issue-288-tools
sha256sum .pi-subagents/issue-288-tools/pm-github-2026.10.19.tgz
```

Observed package SHA256:
`595a017feaafc620438ffd9a27720c8a07827159029b9c2088e7ff529dcea66d`.
Save the following fixture as `.pi-subagents/verify-288.ts` and execute
`node .pi-subagents/verify-288.ts`. The GitHub reads use the importer's normal
credential resolver; no credential is printed. Scratch trackers are removed in
`finally`, including after a failed assertion. No provider or canonical tracker
writes occur.

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { verifyImportIdempotency } from './issue-288-tools/package/dist/index.js';

const repo = process.cwd();
const tag = 'gh:unbraind/pm-web#278';
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-288-'));
const pmRoot = path.join(scratch, '.agents/pm');
const cli = path.join(repo, 'node_modules/@unbrained/pm-cli/dist/cli.js');
const client = new PmClient({ cwd: scratch, pmRoot, noExtensions: true, author: 'codex-sol' });

/** Hash persisted tracker documents and append-only histories, excluding runtime caches. */
async function snapshot(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    if (!name.endsWith('.toon') && !name.endsWith('.jsonl')) continue;
    if (name.split(path.sep).some(part => ['runtime', 'locks', 'search', 'transactions'].includes(part))) continue;
    hash.update(name).update(await readFile(path.join(root, name)));
  }
  return hash.digest('hex');
}

/** Run the pinned CLI against the disposable tracker without displaying provider payloads. */
function run(args: string[]): string {
  const result = spawnSync(process.execPath, [cli, '--pm-path', pmRoot, ...args], {
    cwd: scratch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PM_AUTHOR: 'codex-sol', NPM_CONFIG_USERCONFIG: '/dev/null' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  await cp(path.join(repo, '.agents/pm'), pmRoot, { recursive: true, filter: source => !source.split(path.sep).some(part => ['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(part)) });
  await symlink(path.join(repo, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const corpus = await client.listAllComplete({ includeBody: true });
  const rows = corpus.items;
  const owners = rows.filter(row => row.tags?.includes(tag));
  assert.deepEqual(owners.map(row => row.id), ['pm-web-5sx6']);
  const fragment = rows.find(row => row.id === 'pm-web-cnhi');
  assert.ok(fragment);
  assert.equal(fragment.status, 'closed');
  assert.equal(fragment.release, '2026.10.29');
  assert.ok(fragment.dependencies?.some(dep => dep.id === 'pm-web-5sx6' && dep.kind === 'related'));
  const before = await snapshot(pmRoot);
  const first = verifyImportIdempotency(rows, [], 'unbraind/pm-web');
  assert.deepEqual(verifyImportIdempotency(rows, [], 'unbraind/pm-web'), first);
  assert.equal(await snapshot(pmRoot), before);
  console.log('PASS current complete corpus', rows.length, JSON.stringify(first));

  await client.update('pm-web-cnhi', { addTags: [tag] });
  const duplicated = (await client.listAllComplete()).items;
  const duplicateBefore = await snapshot(pmRoot);
  assert.throws(() => verifyImportIdempotency(duplicated, [], 'unbraind/pm-web'), /1 duplicate provenance tag\(s\).*0 new entr.*0 conflicting target.*No item was written/s);
  assert.equal(await snapshot(pmRoot), duplicateBefore);
  await client.update('pm-web-cnhi', { removeTags: [tag] });
  verifyImportIdempotency((await client.listAllComplete()).items, [], 'unbraind/pm-web');
  console.log('PASS behavioral revert: duplicate GH278 fails closed without document/history writes; SDK repair passes');

  run(['extension', 'install', path.join(repo, '.pi-subagents/issue-288-tools/package')]);
  const cliBefore = await snapshot(pmRoot);
  const plan1 = JSON.parse(run(['github', 'import', 'unbraind/pm-web', '--state', 'all', '--atomic', '--gate', '--dry-run', '--with-comments', '--json']));
  const plan2 = JSON.parse(run(['github', 'import', 'unbraind/pm-web', '--state', 'all', '--atomic', '--gate', '--dry-run', '--with-comments', '--json']));
  assert.deepEqual(plan2, plan1);
  assert.equal(await snapshot(pmRoot), cliBefore);
  console.log('PASS exact-version real GitHub read-only plans identical; no document/history writes');
  console.log('PLAN SUMMARY', JSON.stringify(plan1.summary ?? Object.fromEntries(Object.entries(plan1).filter(([key]) => !['items', 'plan', 'entries', 'gate'].includes(key)))));

  const plain = path.join(scratch, 'plain');
  await mkdir(plain);
  const plainRoot = path.join(plain, '.agents/pm');
  const plainClient = new PmClient({ cwd: plain, pmRoot: plainRoot, author: 'codex-sol', noExtensions: true });
  await plainClient.init('plain', { defaults: true, agentGuidance: 'skip' });
  await plainClient.create({ title: 'Canonical delivery', type: 'Issue', tags: tag });
  const second = await plainClient.create({ title: 'Related SDK delivery', type: 'Issue', tags: tag });
  const plainBefore = await snapshot(plainRoot);
  const plainRows = (await plainClient.listAllComplete()).items;
  assert.throws(() => verifyImportIdempotency(plainRows, [], 'unbraind/pm-web'), /1 duplicate provenance/);
  assert.equal(await snapshot(plainRoot), plainBefore);
  await plainClient.update(second.item.id, { removeTags: [tag] });
  verifyImportIdempotency((await plainClient.listAllComplete()).items, [], 'unbraind/pm-web');
  console.log('PASS plain no-git SDK tracker duplicate refusal and repaired acceptance');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
```

## Verified receipts

- Complete corpus: 204 records, 19 indexed importer identities; sole GH278 owner
  `pm-web-5sx6`. The related record is still closed with its release preserved.
- Behavioral revert: restoring the second GH278 tag through the SDK fails with
  exactly one duplicate identity, zero missing provenance and zero conflicting
  targets. The guard makes no item/history writes. SDK repair passes again.
- Exact-version real GitHub plans: two identical complete JSON results, each
  reporting `wouldImport: 0`, `wouldUpdate: 11`, `wouldSkip: 0`, `atomic: true`.
  Item/history hashes are unchanged across both read-only plans. This proves
  repeated planning stability; the normal workflow below separately proves a
  second *applied* import is a no-op.
- Plain no-Git SDK tracker: duplicate identity refused without item/history
  writes, then SDK tag removal accepted. All four fixture scenarios passed.
- Existing tests: `node --test --test-concurrency=2 test/workflow-security.test.ts
  test/workflow-update-automation.test.ts` passed 8/8, including through
  `pm test pm-web-kiqa --run --only-last --progress`.
- `npm run typecheck` and `npm run lint` passed. Both `npm run release:check`
  and `bun run release:check` passed static checks, duplication at 0%, and
  documentation for 936 declarations. Each stopped at coverage's mandatory
  database preflight because the throwaway PostgreSQL service was unavailable.
  Neither full local release gate is reported as passed; CI supplies PostgreSQL.

The [normal scheduled sync](https://github.com/unbraind/pm-web/actions/runs/42183873938)
completed successfully on inspected main commit
`1a8ce23d8cb17a867ae0205bffc05f4e10d49f39` on 2026-11-06. Its preview, guarded
import, repeat-import no-op, privacy and strict-health steps all succeeded.
This is subsequent workflow evidence for the existing metadata repair. The
workflow-version change in PR 294 remains separate from this verification.

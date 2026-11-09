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
It repeats a bounded real GitHub plan for issue 288 and compares both complete
JSON results, their nonempty provider/gate receipts and all persisted item/history
bytes. A separate disposable Git tracker exercises the real non-dry-run gated
import with the duplicate and a deliberately stale provider target, then
successful apply after repair. The stale target ensures a bypass would cause
observable item/history writes. A separate tracker initialized
through the SDK tests the same refusal and recovery without Git.
The plain control requires a scratch directory outside every Git worktree and
bare repository, even when `TMPDIR` is overridden. It checks before and after
SDK initialization; any Git error other than the normal no-repository diagnostic
fails the fixture. Choose an outside-Git temporary directory if this check fails.

Use a **separate clean checkout** of the recorded source commit, not the PR
branch. The fixture verifies that checkout's exact `HEAD` and cleanliness before
copying any tracker. Install that checkout's pinned dependencies, then verify
both the SDK resolved by the fixture and its actual spawned CLI are `2026.11.2`.
The fixture enforces these checks before creating scratch state.

```sh
set -eu
git worktree add --detach ../pm-web-issue-288-baseline 1a8ce23d8cb17a867ae0205bffc05f4e10d49f39
cd ../pm-web-issue-288-baseline
unset NPM_MEDIA_SERVER NPM_TOKEN NODE_AUTH_TOKEN
NPM_CONFIG_USERCONFIG=/dev/null npm ci
test "$(git rev-parse HEAD)" = 1a8ce23d8cb17a867ae0205bffc05f4e10d49f39
test -z "$(git status --porcelain)"
mkdir -p .pi-subagents/issue-288-tools
NPM_CONFIG_USERCONFIG=/dev/null npm pack pm-github@2026.10.19 --registry=https://registry.npmjs.org --pack-destination .pi-subagents/issue-288-tools --ignore-scripts --silent
printf '%s  %s\n' 595a017feaafc620438ffd9a27720c8a07827159029b9c2088e7ff529dcea66d .pi-subagents/issue-288-tools/pm-github-2026.10.19.tgz | sha256sum --check --status
tar -xzf .pi-subagents/issue-288-tools/pm-github-2026.10.19.tgz -C .pi-subagents/issue-288-tools
```

The shell stops on a digest mismatch **before extraction**. The verified archive
must be extracted afresh; do not reuse a previously modified extracted package.
No tracked dependency or extension-registration changes are needed.

Observed package SHA256:
`595a017feaafc620438ffd9a27720c8a07827159029b9c2088e7ff529dcea66d`.
Save the following fixture as `.pi-subagents/verify-288.ts` and execute
`node .pi-subagents/verify-288.ts`. The GitHub reads use the importer's normal
credential resolver; no credential is printed. Scratch trackers are removed in
`finally`, including after a failed assertion. Only disposable trackers are written; no provider or canonical tracker writes
occur. The Git-backed control copies the recorded checkout's existing ignore
policy so runtime caches stay outside the scanned tracker change. The gate and
its thresholds are unchanged.

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { findPackageJSON } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PmClient, parseItemDocument } from '@unbrained/pm-cli/sdk';
import { verifyImportIdempotency } from './issue-288-tools/package/dist/index.js';

const repo = process.cwd();
const sourceCommit = '1a8ce23d8cb17a867ae0205bffc05f4e10d49f39';
const beforeRepair = '6061e4d2a0657a80b340a6009e9f00075f1e66fa';
const tag = 'gh:unbraind/pm-web#278';
const sdkManifest = findPackageJSON('@unbrained/pm-cli/sdk', import.meta.url);
assert.ok(sdkManifest, 'The imported SDK must resolve to an installed package');
const cli = path.join(path.dirname(sdkManifest), 'dist/cli.js');

/** Prove the actual source, imported SDK and spawned CLI before creating a tracker. */
async function assertReproductionIdentity(): Promise<void> {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.equal(head.stdout.trim(), sourceCommit, 'Use the recorded historical checkout');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '', 'The historical checkout must be clean');
  const manifest: { version: string } = JSON.parse(await readFile(sdkManifest!, 'utf8'));
  assert.equal(manifest.version, '2026.11.2', 'The imported SDK must be exactly pinned');
  const version = spawnSync(process.execPath, [cli, '--version'], { cwd: repo, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '2026.11.2', 'The spawned CLI must be exactly pinned');
}
await assertReproductionIdentity();
if (process.argv.includes('--preflight-only')) process.exit(0);

const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-288-'));
const pmRoot = path.join(scratch, '.agents/pm');
const client = new PmClient({ cwd: scratch, pmRoot, noExtensions: true, author: 'codex-sol' });
const importArgs = ['github', 'import', 'unbraind/pm-web', '--issue', '288', '--atomic', '--gate', '--with-comments', '--json'];

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

/** Run the actual pinned CLI against one disposable tracker, keeping expected refusals observable. */
function invoke(args: string[], cwd = scratch, root = pmRoot) {
  return spawnSync(process.execPath, [cli, '--pm-path', root, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PM_AUTHOR: 'codex-sol', NPM_CONFIG_USERCONFIG: '/dev/null' },
  });
}

/** Require successful CLI execution without printing provider payloads. */
function run(args: string[], cwd = scratch, root = pmRoot): string {
  const result = invoke(args, cwd, root);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Read committed baseline bytes independently of scratch tracker state. */
function historical(file: string): Buffer {
  const result = spawnSync('git', ['show', `${beforeRepair}:${file}`], { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

/** Require positive evidence of a non-Git directory before accepting the plain control. */
function assertOutsideGit(directory: string): void {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 128, 'The plain control must be outside every Git repository');
  assert.equal(result.stdout, '');
  assert.match(result.stderr.trim(), /^fatal: not a git repository \(or any of the parent directories\): \.git$/);
}

/** Preserve both original histories and every delivery field except the intended tag/relationship edits. */
async function assertPreservation(root: string): Promise<void> {
  for (const [folder, id] of [['features', 'pm-web-5sx6'], ['issues', 'pm-web-cnhi']]) {
    const relative = `.agents/pm/${folder}/${id}.toon`;
    const original = parseItemDocument(historical(relative).toString(), { format: 'toon' });
    const current = parseItemDocument(await readFile(path.join(root, folder, `${id}.toon`), 'utf8'), { format: 'toon' });
    assert.equal(current.body, original.body);
    const { tags: oldTags, dependencies: oldDependencies, updated_at: oldUpdated, ...oldFields } = original.metadata;
    const { tags: newTags, dependencies: newDependencies, updated_at: newUpdated, ...newFields } = current.metadata;
    assert.deepEqual(newFields, oldFields, `${id} must retain every original delivery field`);
    for (const value of oldTags ?? []) if (value !== tag) assert.ok(newTags?.includes(value));
    for (const dependency of oldDependencies ?? []) assert.deepEqual(newDependencies?.find(value => value.id === dependency.id && value.kind === dependency.kind), dependency);
    const oldHistory = historical(`.agents/pm/history/${id}.jsonl`);
    const newHistory = await readFile(path.join(root, 'history', `${id}.jsonl`));
    assert.ok(newHistory.subarray(0, oldHistory.length).equals(oldHistory), `${id} history must extend the pre-repair bytes`);
  }
}

/** Reject empty provider results and require the historical planner's completeness/idempotency receipts. */
function assertPlan(value: unknown): void {
  assert.ok(value && typeof value === 'object');
  const plan = value as { plan?: { issue: number }[]; gate?: { completeness: { fetched: number; planned: number; skipped: number }; idempotency: { provenance_indexed: number; matched_by_provenance: number; new_entries: number } } };
  assert.deepEqual(plan.plan?.map(entry => entry.issue), [288]);
  assert.deepEqual(plan.gate?.completeness, { fetched: 1, planned: 1, skipped: 0 });
  assert.deepEqual(plan.gate?.idempotency, { provenance_indexed: 19, matched_by_provenance: 1, new_entries: 0 });
}

try {
  await cp(path.join(repo, '.agents/pm'), pmRoot, { recursive: true, filter: source => !source.split(path.sep).some(part => ['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(part)) });
  await symlink(path.join(repo, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  const corpus = await client.listAllComplete({ includeBody: true });
  const rows = corpus.items;
  assert.equal(rows.length, 204);
  assert.deepEqual(rows.filter(row => row.tags?.includes(tag)).map(row => row.id), ['pm-web-5sx6']);
  const fragment = rows.find(row => row.id === 'pm-web-cnhi');
  assert.ok(fragment?.dependencies?.some(dep => dep.id === 'pm-web-5sx6' && dep.kind === 'related'));
  await assertPreservation(pmRoot);
  const before = await snapshot(pmRoot);
  const first = verifyImportIdempotency(rows, [], 'unbraind/pm-web');
  assert.deepEqual(verifyImportIdempotency(rows, [], 'unbraind/pm-web'), first);
  assert.equal(await snapshot(pmRoot), before);
  console.log('PASS immutable complete corpus and pre-repair delivery/history preservation', rows.length);

  run(['extension', 'install', path.join(repo, '.pi-subagents/issue-288-tools/package')]);
  const installedManifest: { version: string } = JSON.parse(await readFile(path.join(pmRoot, 'extensions/pm-github/manifest.json'), 'utf8'));
  assert.equal(installedManifest.version, '2026.10.19');
  assert.ok((await readFile(path.join(pmRoot, 'extensions/pm-github/dist/index.js'))).equals(await readFile(path.join(repo, '.pi-subagents/issue-288-tools/package/dist/index.js'))), 'Installed runtime must match the checked source');
  const cliBefore = await snapshot(pmRoot);
  const plan1: unknown = JSON.parse(run([...importArgs, '--dry-run']));
  const plan2: unknown = JSON.parse(run([...importArgs, '--dry-run']));
  assertPlan(plan1);
  assertPlan(plan2);
  assert.deepEqual(plan2, plan1);
  assert.equal(await snapshot(pmRoot), cliBefore);
  console.log('PASS exact-version real GitHub nonempty read-only plans and gate receipts; no item/history writes');

  const gitTracker = path.join(scratch, 'git-control');
  const gitRoot = path.join(gitTracker, '.agents/pm');
  await cp(pmRoot, gitRoot, { recursive: true, filter: source => !source.split(path.sep).some(part => ['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(part)) });
  await symlink(path.join(repo, 'node_modules'), path.join(gitTracker, 'node_modules'), 'dir');
  /** Execute a Git operation only in the disposable import control. */
  function git(args: string[]): void {
    const result = spawnSync('git', args, { cwd: gitTracker, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await cp(path.join(repo, '.gitignore'), path.join(gitTracker, '.gitignore'));
  git(['init', '-q']);
  git(['add', '.gitignore', '.agents/pm']);
  git(['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '-qm', 'Synthetic import control']);
  const gitClient = new PmClient({ cwd: gitTracker, pmRoot: gitRoot, noExtensions: true, author: 'codex-sol' });
  await gitClient.update('pm-web-kiqa', { title: 'Synthetic stale provider target' });
  await gitClient.update('pm-web-cnhi', { addTags: [tag] });
  const duplicateBefore = await snapshot(gitRoot);
  const refusal = invoke(importArgs, gitTracker, gitRoot);
  assert.notEqual(refusal.status, 0, 'The real non-dry-run import must refuse duplicate identity');
  assert.match(refusal.stderr, /1 duplicate provenance tag\(s\).*0 new entr.*0 conflicting target.*No item was written/s);
  assert.equal(await snapshot(gitRoot), duplicateBefore, 'Refused import must not mutate items or history');
  await gitClient.update('pm-web-cnhi', { removeTags: [tag] });
  const applied = JSON.parse(run(importArgs, gitTracker, gitRoot)) as { gate?: { verdict: string; findings: number }; plan?: { issue: number }[] };
  assert.deepEqual(applied.plan?.map(entry => entry.issue), [288]);
  assert.equal(applied.gate?.verdict, 'pass');
  assert.equal(applied.gate?.findings, 0);
  const synced = (await gitClient.listAllComplete()).items.find(item => item.id === 'pm-web-kiqa');
  assert.ok(synced);
  assert.notEqual(synced.title, 'Synthetic stale provider target', 'Successful apply must actually repair the stale provider target');
  await assertPreservation(gitRoot);
  console.log('PASS real Git-backed gated apply refuses the duplicate without item/history writes, then succeeds after SDK repair');

  const plain = path.join(scratch, 'plain');
  await mkdir(plain);
  assertOutsideGit(plain);
  const plainRoot = path.join(plain, '.agents/pm');
  const plainClient = new PmClient({ cwd: plain, pmRoot: plainRoot, author: 'codex-sol', noExtensions: true });
  await plainClient.init('plain', { defaults: true, agentGuidance: 'skip' });
  assertOutsideGit(plain);
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
  targeting issue 288 and requiring one fetched/planned issue, no skips, one
  provenance match and no new identity. Earlier unbounded plans reported
  `wouldImport: 0`, `wouldUpdate: 11`, `wouldSkip: 0`, `atomic: true`.
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

## Review regression controls

The reproduction guards were tested against both the original document at
`f04a045` and this revision, using real Git processes and installed SDK/CLI
versions. Five refusal controls passed here and failed against the original:
wrong `HEAD`, dirty historical checkout, SDK `2026.11.5`, CLI `2026.11.5` with
the pinned SDK, and altered archive bytes. The exact-version checkout and exact
historical archive were the two passing must-allow controls. The identity-only
entrypoint is `node .pi-subagents/verify-288.ts --preflight-only`.

The importer integration has a separate behavioral mutation proof: in the
disposable extracted historical package, bypass only the CLI import's
`gateIdempotency = verifyImportIdempotency(existingItems, planned, repo)` call,
while leaving the exported verifier intact. The new non-dry-run duplicate
control deliberately makes issue 288 stale so an admitted import must write. It
must fail its unchanged-item/history assertion because the import writes
before its remaining post-write identity check refuses. Restore the original
package in `finally`, then rerun all four scenarios successfully. This proves
the regression observes the import boundary and write ordering, rather than
only the standalone verifier.

The no-Git boundary regression is reproducible with
`node --test --test-concurrency=2 test/gated-sync-verification.test.ts`.
It executes the documented setup with the real SDK and real Git processes:
an outside-Git directory initializes successfully, while nested worktrees,
bare repositories and corrupt repository metadata refuse before tracker writes.
Removing only the documented boundary-check calls makes the refusal controls
fail; restoring those calls makes the suite pass again.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PmClient, readHistoryEntries, getHistoryPath, listMutationEvents, type UpdateCommandOptions } from '@unbrained/pm-cli/sdk';
import { AgentContextClient, AgentContextError, type AgentContextPacket, type ResumePacket } from '../src/agent-context.ts';
import { buildResumePacket, type ResumeBinding } from '../src/services/resume-packets.ts';
import { getAgentContext, publishAgentContext, revokeAgentContext } from '../src/services/agent-context.ts';
import { verifyProjectAccess } from '../src/routes/projects.ts';
import { getProjectDir } from '../src/services/pm-runner.ts';
import { signToken } from '../src/auth.ts';
import { pool } from '../src/db.ts';
import { installExtension } from './helpers/install-runtime-extension.ts';
import { ensureSchema, seedUser, seedProject, seedUserShare, startApp } from './helpers/pg-harness.ts';

const exec = promisify(execFile);
/** Real SDK tracker plus real persisted consent, isolated from Git and every hosted service. */
async function fixture(t: TestContext) {
  await ensureSchema();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'resume-packet-'));
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true });
  await pm.init('resume', { defaults: true, agentGuidance: 'skip' });
  const a = (await pm.create({ type: 'Task', title: 'Selected', description: 'Synthetic', id: 'resume-one' })).item.id;
  const b = (await pm.create({ type: 'Task', title: 'Related', description: 'Synthetic', id: 'resume-two' })).item.id;
  const foreign = (await pm.create({ type: 'Task', title: 'Unselected', description: 'Synthetic', id: 'resume-foreign' })).item.id;
  const owner = await seedUser(), viewer = await seedUser(), other = await seedUser();
  const project = await seedProject(owner.id); await seedUserShare(project.id, viewer.id, 'view');
  const scope = await publishAgentContext(project.id, owner.id, { agent: 'synthetic', question: 'What changed for this delivery?', items: [a, b], viewers: [viewer.id], consent: true, receipts: [], gaps: [] });
  const binding: ResumeBinding = { project: project.id, principal: viewer.id, id: scope.id, revision: scope.revision };
  /** Check both live project membership and exact persisted consent before any source read. */
  const authorize = async (): Promise<AgentContextPacket> => {
    if (!await verifyProjectAccess(viewer.id, project.id)) throw new AgentContextError('not_found', 'Restore project access and reorient.', 404);
    return getAgentContext(project.id, viewer.id, scope.id, scope.revision);
  };
  /** Route every test read through the production service and live authorization. */
  const resume = (cursor?: string, budget?: number, step?: (name: string) => Promise<void>) => buildResumePacket(pmRoot, binding, { cursor, budget }, authorize, step);
  t.after(async () => { await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id, other.id]]); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, pmRoot, pm, a, b, foreign, owner, viewer, other, project, scope, binding, authorize, resume };
}
/** Require typed refusals with actionable remedies instead of treating failure as an empty delta. */
function refusal(code: AgentContextError['code']) { return (error: unknown) => error instanceof AgentContextError && error.code === code && error.remedy.length > 10; }
/** Independently read physical stream lengths through the public SDK for the reference admission ledger. */
async function versions(pmRoot: string, ids: string[]): Promise<Map<string, number>> {
  return new Map(await Promise.all(ids.map(async id => [id, (await readHistoryEntries(getHistoryPath(pmRoot, id), id)).length] as const)));
}
/** Reference model: set difference of per-item ordinals, with no native-field normalization. */
function expectedChanges(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].flatMap(([id, count]) => Array.from({ length: count - before.get(id)! }, (_, i) => `${id}:${before.get(id)! + i + 1}`)).sort();
}
/** Compare semantic references independently of encryption randomness and response formatting. */
function identities(packet: ResumePacket): string[] { return packet.changes.map(row => `${row.item}:${row.version}`).sort(); }

test('offline resume admits each selected change once, keeps retries stable and discloses deferred rows', async t => {
  const f = await fixture(t), baseline = await f.resume();
  assert.equal(baseline.phase, 'admitted'); assert.equal(baseline.receipt.baselineEvents, 2);
  const before = await versions(f.pmRoot, [f.a, f.b]);
  for (let i = 0; i < 55; i++) await f.pm.update(f.a, { title: `Change ${i}`, body: `Exact whitespace ${i}\r\n  retained  \n` });
  await f.pm.update(f.foreign, { title: 'Never disclosed' });
  const after = await versions(f.pmRoot, [f.a, f.b]);
  const first = await f.resume(baseline.cursor);
  assert.equal(first.changes.length, 50); assert.equal(first.receipt.deferred, 5); assert.equal(first.receipt.complete, false);
  const replay = await f.resume(baseline.cursor);
  assert.deepEqual(replay.changes, first.changes);
  const second = await f.resume(first.cursor);
  assert.equal(second.receipt.complete, true); assert.equal(second.changes.length, 5);
  assert.deepEqual([...identities(first), ...identities(second)].sort(), expectedChanges(before, after));
  assert.equal(new Set([...first.changes, ...second.changes].map(row => row.key)).size, 55);
  assert.equal((await f.resume(second.cursor)).changes.length, 0);
  assert.ok(first.budget.bytes <= first.budget.ceiling); assert.equal(first.budget.bytes, Buffer.byteLength(JSON.stringify(first)));
  const small = await f.resume(baseline.cursor, 2048); assert.ok(small.changes.length > 0 && small.receipt.deferred > 0);
  await assert.rejects(f.resume('bad'), refusal('reorientation_required'));
  await assert.rejects(f.resume(baseline.cursor, 1), refusal('invalid_input'));
  await assert.rejects(buildResumePacket(f.pmRoot, { ...f.binding, principal: f.other.id }, { cursor: baseline.cursor }, f.authorize), refusal('reorientation_required'));
});

test('retained prefix rewrites and missing history require reorientation; backdated SDK commits remain eligible', async t => {
  const f = await fixture(t), baseline = await f.resume();
  // SDK-native update with a frozen clock produces a later physical version with an older timestamp.
  const OriginalDate = Date;
  class BackdatedDate extends OriginalDate { constructor() { super('2020-01-01T00:00:00Z'); } static now() { return new OriginalDate('2020-01-01T00:00:00Z').valueOf(); } }
  globalThis.Date = BackdatedDate as unknown as DateConstructor;
  try { await f.pm.update(f.a, { title: 'Late visible commit' }); } finally { globalThis.Date = OriginalDate; }
  const late = await f.resume(baseline.cursor); assert.equal(late.changes.length, 1); assert.equal(late.changes[0].version, 2);
  const file = getHistoryPath(f.pmRoot, f.a), original = await readFile(file, 'utf8');
  // Corrupt only a disposable test history. Production never edits authoritative data.
  await writeFile(file, original.replace('Synthetic', 'Rewritten'));
  await assert.rejects(f.resume(late.cursor), refusal('reorientation_required'));
  await writeFile(file, original); await rm(file);
  await assert.rejects(f.resume(late.cursor), refusal('reorientation_required'));
});

test('revocation and revision replacement win at every asynchronous transition boundary on one plain tracker', async t => {
  const f = await fixture(t);
  const steps: string[] = [];
  await f.resume(undefined, undefined, async name => { steps.push(name); });
  for (const [position, boundary] of steps.entries()) {
    for (const competing of ['audience', 'membership', 'revision', 'peer'] as const) {
      const scope = await publishAgentContext(f.project.id, f.owner.id, { ...f.scope, viewers: [f.viewer.id] });
      const binding = { ...f.binding, id: scope.id, revision: scope.revision };
      const authorize = async () => {
        if (!await verifyProjectAccess(f.viewer.id, f.project.id)) throw new AgentContextError('not_found', 'Restore project access.', 404);
        return getAgentContext(f.project.id, f.viewer.id, scope.id, binding.revision);
      };
      const initial = await buildResumePacket(f.pmRoot, binding, {}, authorize);
      await f.pm.update(f.a, { title: `${position}-${boundary}-${competing}` });
      let injected = false, observed = 0;
      const run = buildResumePacket(f.pmRoot, binding, { cursor: initial.cursor }, authorize, async name => {
        if (observed++ !== position) return;
        assert.equal(name, boundary); injected = true;
        if (competing === 'membership') await pool.query('DELETE FROM pm_project_shares WHERE project_id=$1 AND shared_with_user_id=$2', [f.project.id, f.viewer.id]);
        else if (competing === 'audience') await revokeAgentContext(f.project.id, f.owner.id, scope.id, scope.revision);
        else if (competing === 'revision') await publishAgentContext(f.project.id, f.owner.id, { ...scope, question: 'Replacement question' }, scope);
        else {
          const peer = await buildResumePacket(f.pmRoot, binding, { cursor: initial.cursor }, authorize);
          assert.equal(peer.changes.length, 1);
        }
      });
      if (competing === 'peer') { assert.equal((await run).changes.length, 1); }
      else await assert.rejects(run, error => refusal('not_found')(error) || refusal('revision_conflict')(error));
      assert.ok(injected, boundary);
      if (competing === 'membership') await seedUserShare(f.project.id, f.viewer.id, 'view');
    }
  }
  // No shared checkpoint, claim, lease or outbox was created or deleted by either reader.
  assert.deepEqual((await f.pm.get(f.foreign, { depth: 'full' })).item.title, 'Unselected');
});

test('500 seeded model sequences round-trip resume state, older inputs, native whitespace and relationships through SDK reads', { timeout: 900000 }, async t => {
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  for (let i = 0; i < 10; i++) fixtures.push(await fixture(t));
  const server = await startApp(); t.after(() => server.close());
  const scopes = fixtures.map(f => f.scope);
  const clients = fixtures.map(f => new AgentContextClient(server.url('/'), signToken({ userId: f.owner.id, email: f.owner.email })));
  let seed = 0x5eed2026;
  /** Reproducible unsigned generator; include the seed in every failure context. */
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 500; sequence++) {
    const f = fixtures[sequence % fixtures.length], ids = [f.a, f.b];
    const index = sequence % fixtures.length;
    const candidate = { ...scopes[index], agent: `agent-${random()}`, question: `  question ${random()}\r\n next  `, receipts: [{ source: 'core-output-session' as const, receiptId: `receipt-${random()}`, revision: `revision-${sequence}`, servedAt: '2026-10-25T00:00:00Z', omission: [{ reason: `  omitted ${random()}\r\n`, remedy: 'Read selected native state.' }] }], gaps: [{ reason: '  pending\r\n', remedy: `Check evidence ${random()}` }] };
    const input = sequence % 5 === 0 ? f.scope : candidate; // Replay older consented input against the current target revision.
    scopes[index] = await clients[index].publish(f.project.id, JSON.parse(JSON.stringify(input)) as AgentContextPacket, scopes[index]);
    const scope = scopes[index];
    const retrieved = await clients[index].get(f.project.id, scope.id, scope.revision);
    assert.deepEqual(retrieved, scope);
    for (const field of ['agent', 'question', 'items', 'consent', 'viewers', 'receipts', 'gaps'] as const) assert.deepEqual(retrieved[field], input[field], `context reference model field=${field}, sequence=${sequence}`);
    const binding = { ...f.binding, id: scope.id, revision: scope.revision };
    const resume = (cursor?: string, budget?: number) => buildResumePacket(f.pmRoot, binding, { cursor, budget }, () => getAgentContext(f.project.id, f.viewer.id, scope.id, scope.revision));
    const baseline = await resume();
    const before = await versions(f.pmRoot, ids);
    const older: { item: string; input: UpdateCommandOptions }[] = [];
    for (let operation = 0; operation < 2 + random() % 3; operation++) {
      const item = ids[random() % ids.length];
      const variant = random() % 4;
      const input: UpdateCommandOptions = { title: `Sequence ${sequence} step ${operation}`, body: variant % 2 ? `  prose ${random()}  \r\n\r\n tail \r\n` : `\tprose ${random()}\n  tail  \n`, description: ` whitespace ${random()} `, priority: random() % 5, tags: `seeded,tag-${random() % 5}`, acceptanceCriteria: `criterion ${random()}`, goal: `goal-${random()}`, dep: [`id=${item === f.a ? f.b : f.a},kind=related`], replaceDeps: true };
      // Transport serialization is the only transformation owned by this feature.
      const transported = JSON.parse(JSON.stringify(input)) as UpdateCommandOptions;
      await f.pm.update(item, transported); older.push({ item, input: transported });
      if (variant === 0) await f.pm.update(older[0].item, older[0].input); // Replay an older native input, including a previous body and relationships.
    }
    const after = await versions(f.pmRoot, ids);
    const native = await Promise.all(ids.map(id => f.pm.get(id, { depth: 'full' })));
    const packet = await resume(JSON.parse(JSON.stringify(baseline.cursor)) as string, random() % 2 ? 2048 : 12288);
    const rows = [...identities(packet)]; let cursor = packet.cursor; let last = packet;
    while (!last.receipt.complete) { last = await resume(cursor); rows.push(...identities(last)); cursor = last.cursor; }
    assert.deepEqual(rows.sort(), expectedChanges(before, after), `sequence=${sequence}, seed=${seed}`);
    assert.equal(new Set(rows).size, rows.length);
    assert.deepEqual((await resume(baseline.cursor, packet.budget.ceiling)).changes, packet.changes);
    assert.equal((await resume(cursor)).changes.length, 0);
    // Read every field back through the SDK: resume may not mutate, normalize or lose a relationship/native field.
    assert.deepEqual(await Promise.all(ids.map(id => f.pm.get(id, { depth: 'full' }))), native);
  }
});

test('authenticated SDK and native TOON/JSON command work without git; revoked access cannot retrieve a packet', async t => {
  const f = await fixture(t);
  const savedRoot = process.env.PROJECTS_ROOT; process.env.PROJECTS_ROOT = path.join(f.cwd, 'projects');
  t.after(() => { if (savedRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = savedRoot; });
  const server = await startApp(); t.after(() => server.close());
  const root = getProjectDir(f.owner.id, f.project.slug);
  await mkdir(path.dirname(root), { recursive: true }); await symlink(f.cwd, root, 'dir');
  t.after(() => rm(root, { force: true }));
  const token = signToken({ userId: f.viewer.id, email: f.viewer.email });
  const sdk = new AgentContextClient(server.url('/'), token);
  const baseline = await sdk.resume(f.project.id, f.scope.id, f.scope.revision);
  await f.pm.update(f.a, { title: 'Changed while offline' });
  assert.equal((await sdk.resume(f.project.id, f.scope.id, f.scope.revision, baseline.cursor)).changes.length, 1);
  const bin = path.join(f.cwd, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
  await installExtension(f.pmRoot, f.pm, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  const env = { ...process.env, PM_WEB_TOKEN: token, PM_PATH: f.pmRoot, PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(f.cwd) };
  await assert.rejects(exec('git', ['--version'], { env }));
  for (const encoding of ['json', 'toon']) {
    const result = await exec(process.execPath, [path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js'), 'web', 'agent-context', 'resume', '--url', server.url('/'), '--project', f.project.id, '--id', f.scope.id, '--revision', f.scope.revision, '--cursor', baseline.cursor, '--output-budget', 'unbounded', ...(encoding === 'json' ? ['--json'] : [])], { cwd: f.cwd, env });
    assert.match(result.stdout, /pm-web-resume\/v1/); assert.match(result.stdout, /resume-one/);
    assert.ok(Buffer.byteLength(result.stdout) < 16384);
  }
  const response = await fetch(server.url(`/api/projects/${f.project.id}/pm/agent-context/${f.scope.id}/resume?revision=${f.scope.revision}`), { headers: { Authorization: `Bearer ${token}` } });
  assert.match(response.headers.get('cache-control')!, /no-store/);
  await revokeAgentContext(f.project.id, f.owner.id, f.scope.id, f.scope.revision);
  await assert.rejects(sdk.resume(f.project.id, f.scope.id, f.scope.revision, baseline.cursor), refusal('not_found'));
  // A copied opaque cursor conveys no source access without current membership and audience consent.
  await assert.rejects(new AgentContextClient(server.url('/'), signToken({ userId: f.other.id, email: f.other.email })).resume(f.project.id, f.scope.id, f.scope.revision, baseline.cursor), refusal('not_found'));
  const raw = await listMutationEvents({ pmRoot: f.pmRoot, item: f.foreign }); assert.equal(raw.count, 1);
});


test('bounded scopes, budget refusals and empty cursors never silently admit a fresh baseline', async t => {
  const f = await fixture(t);
  const sdk = new AgentContextClient('http://127.0.0.1:1', 'synthetic');
  await assert.rejects(f.resume(''), refusal('reorientation_required'));
  for (const items of [[], ['../escape'], [f.a, f.a], Array.from({ length: 21 }, (_, i) => `item-${i}`)]) {
    await assert.rejects(publishAgentContext(f.project.id, f.owner.id, { ...f.scope, items }), refusal('invalid_input'));
  }
  const legacy = await publishAgentContext(f.project.id, f.owner.id, { ...f.scope, items: undefined });
  await assert.rejects(buildResumePacket(f.pmRoot, { ...f.binding, id: legacy.id, revision: legacy.revision }, {}, async () => legacy), refusal('reorientation_required'));
  const ids = [f.a, f.b];
  for (let i = 0; i < 18; i++) ids.push((await f.pm.create({ type: 'Task', title: `Bound ${i}`, description: 'Synthetic', id: `resume-bound-${i}` })).item.id);
  const scope = await publishAgentContext(f.project.id, f.owner.id, { ...f.scope, items: ids });
  await assert.rejects(buildResumePacket(f.pmRoot, { ...f.binding, id: scope.id, revision: scope.revision }, { budget: 2048 }, async () => scope), refusal('budget_too_small'));
  // No remote fallback or untyped transport failure can be confused with an admitted baseline.
  await assert.rejects(sdk.resume(f.project.id, scope.id, scope.revision, ''), refusal('unavailable'));
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.ts';
import { PermissionImpactClient } from '../src/permission-impact-client.ts';
import { PermissionImpactError, parsePermissionImpactPage, type PermissionImpactPage } from '../src/permission-impact.ts';
import { AgentContextClient, type AgentContextInput } from '../src/agent-context.ts';
import { signToken } from '../src/auth.ts';
import { requestDecision, listDecisionInbox, readDecisionInboxSnapshot } from '../src/services/decision-inbox.ts';
import { directoryContractAdapter, exploreContracts } from '../src/contract-explorer.ts';
import { readProjectAccess } from '../src/services/project-access.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { installExtension } from './helpers/install-runtime-extension.ts';
import { addGroupMember, authedFetch, ensureSchema, seedGroup, seedGroupShare, seedProject, seedUser, seedUserShare, startApp } from './helpers/pg-harness.ts';
import { connectLiveSSE } from './helpers/live-sse.ts';

const exec = promisify(execFile);
/** Build a real non-git SDK tracker, independent project, HTTP server and explicit caller scopes. */
async function fixture(t: TestContext) {
  await ensureSchema();
  const root = await mkdtemp(path.join(os.tmpdir(), 'permission-http-')), previousRoot = process.env.PROJECTS_ROOT;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PROJECTS_ROOT = root; process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  const owner = await seedUser(), editor = await seedUser(), viewer = await seedUser(), outsider = await seedUser();
  const project = await seedProject(owner.id), otherProject = await seedProject(outsider.id);
  const share = await seedUserShare(project.id, editor.id, 'edit');
  await seedUserShare(project.id, viewer.id, 'view');
  const cwd = path.join(root, owner.id, project.slug), { client: pm, pmRoot } = await createPlainContractTracker(cwd);
  const item = await pm.create({ title: 'Scope preservation', type: 'Task', unset: ['parent', 'goal', 'objective', 'sprint', 'release'] });
  const plan = await pm.create({ type: 'Plan', title: 'Pending choice', unset: ['parent', 'goal', 'objective', 'sprint', 'release'] });
  const decision = await requestDecision(pmRoot, { author: owner.id, permission: 'edit' }, { planId: plan.item.id, question: 'Delivery choice?', alternatives: ['A', 'B'], evidence: 'Synthetic evidence.' });
  const server = await startApp();
  const cleanup: (() => Promise<void>)[] = [];
  const token = (user: typeof owner) => signToken({ userId: user.id, email: user.email });
  const impact = (user = owner) => new PermissionImpactClient(server.url('/'), token(user));
  const context = (user = owner) => new AgentContextClient(server.url('/'), token(user));
  const input: AgentContextInput = { agent: 'test-agent', question: 'Can I continue?', items: [item.item.id], consent: true, viewers: [editor.id], receipts: [], gaps: [] };
  const packet = await context().publish(project.id, input);
  const hidden = await context(editor).publish(project.id, { ...input, viewers: [] });
  t.after(async () => {
    for (const close of cleanup) await close();
    await server.close();
    await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, editor.id, viewer.id, outsider.id]]);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previousRoot;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  return { root, cwd, pmRoot, pm, owner, editor, viewer, outsider, project, otherProject, share, packet, hidden, decision, impact, context, input, server, cleanup };
}
/** Hash durable tracker bytes so preview cannot hide a side effect behind matching projections. */
async function documents(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !['runtime', 'locks', 'search'].includes(path.relative(root, entry.parentPath).split(path.sep)[0]) && /\.(toon|jsonl)$/.test(entry.name)) result.set(path.relative(root, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
  }
  return result;
}
/** Require typed, useful refusals from the actual authenticated client. */
function refusal(code: PermissionImpactError['code']) { return (error: unknown) => error instanceof PermissionImpactError && error.code === code && error.remedy.length > 10; }

/** Prepare an authenticated native consumer with no Git executable for both serialization regressions. */
async function nativeConsumer(f: Awaited<ReturnType<typeof fixture>>) {
  await installExtension(f.pmRoot, f.pm, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  const bin = path.join(f.root, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: os.tmpdir(), PM_WEB_TOKEN: signToken({ userId: f.owner.id, email: f.owner.email }) };
  const args = [path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js'), '--pm-path', f.pmRoot, 'web', 'permission-impact', '--url', f.server.url('/'), '--project', f.project.id, '--share', f.share, '--permission', 'none', '--limit', '2'];
  const json = await exec(process.execPath, [...args, '--json'], { cwd: f.cwd, env });
  const toon = await exec(process.execPath, args, { cwd: f.cwd, env });
  return { json, toon };
}

test('preview counts only visible consented packets, pending decisions and supported core operations without mutation', async t => {
  const f = await fixture(t), before = await documents(f.pmRoot), native = await f.pm.get(f.packet.items![0]);
  const shares = (await pool.query('SELECT * FROM pm_project_shares WHERE project_id=$1 ORDER BY id', [f.project.id])).rows;
  const packets = (await pool.query('SELECT packet FROM pm_agent_context WHERE project_id=$1 ORDER BY id', [f.project.id])).rows;
  const down = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'view', limit: 50 });
  assert.equal(down.counts.packets, 0); assert.equal(down.counts.decisions, 1);
  assert.ok(down.losses.some(row => row.id === f.decision.id && row.loss === 'respond'));
  const revoke = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'none', limit: 50 });
  assert.equal(revoke.counts.packets, 1); assert.equal(revoke.counts.decisions, 1);
  assert.equal(revoke.unknownCapabilities, 'disabled'); assert.equal(revoke.applied, false);
  const identities = [...revoke.losses];
  for (let offset = revoke.nextOffset; offset !== null;) { const page = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'none', offset, limit: 50 }); identities.push(...page.losses); offset = page.nextOffset; }
  assert.equal(identities.length, revoke.total); assert.ok(identities.some(row => row.id === f.packet.id));
  assert.ok(!identities.some(row => row.id === f.hidden.id));
  const adapter = directoryContractAdapter({ cwd: f.cwd, pmRoot: f.pmRoot, noExtensions: true });
  const known = await exploreContracts(adapter, { action: 'delete' }); assert.equal(known.operations[0].status, 'available');
  assert.ok(identities.some(row => row.kind === 'operation' && row.id === 'delete'));
  assert.deepEqual(parsePermissionImpactPage(JSON.parse(JSON.stringify(revoke))), revoke);
  assert.deepEqual(await documents(f.pmRoot), before); assert.deepEqual(await f.pm.get(f.packet.items![0]), native);
  assert.deepEqual((await pool.query('SELECT * FROM pm_project_shares WHERE project_id=$1 ORDER BY id', [f.project.id])).rows, shares);
  assert.deepEqual((await pool.query('SELECT packet FROM pm_agent_context WHERE project_id=$1 ORDER BY id', [f.project.id])).rows, packets);
  assert.ok(Buffer.byteLength(JSON.stringify(revoke)) < 12288);
  for (const user of [f.viewer, f.editor, f.outsider]) await assert.rejects(f.impact(user).preview(f.project.id, { shareId: f.share, permission: 'none' }), refusal(user === f.viewer ? 'view_only' : user === f.editor ? 'owner_required' : 'not_found'));
  await assert.rejects(f.impact().preview(f.otherProject.id, { shareId: f.share, permission: 'none' }), refusal('not_found'));
  await assert.rejects(f.impact().preview(f.project.id, { shareId: randomUUID(), permission: 'none' }), refusal('not_found'));
  const url = `/api/projects/${f.project.id}/pm/permission-impact`;
  assert.equal((await fetch(f.server.url(url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const response = await authedFetch(f.server, f.owner, url, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'preview-never-cached' }, body: JSON.stringify({ shareId: f.share, permission: 'none' }) });
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM pm_idempotency_keys WHERE idempotency_key=$1', ['preview-never-cached'])).rows[0].count, 0);
});

test('overlapping group grants preserve access; separately applied changes invalidate only the selected project', async t => {
  const f = await fixture(t), group = await seedGroup(f.owner.id);
  await addGroupMember(group.id, f.editor.id);
  const groupShare = await seedGroupShare(f.project.id, group.id, 'edit');
  assert.equal((await f.impact().preview(f.project.id, { shareId: f.share, permission: 'none' })).total, 0);
  assert.equal((await f.impact().preview(f.project.id, { shareId: groupShare, permission: 'view' })).total, 0);
  await pool.query('DELETE FROM pm_project_shares WHERE id=$1', [groupShare]);
  const ownerEvents = await connectLiveSSE(f.server, f.owner, f.project.id);
  f.cleanup.push(ownerEvents.close);
  const changed = await authedFetch(f.server, f.owner, `/api/projects/${f.project.id}/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.editor.email, permission: 'view' }) });
  assert.equal(changed.status, 201);
  await ownerEvents.waitFor(events => events.some(row => row.type === 'project-access-changed'));
  assert.equal((await f.context(f.editor).get(f.project.id, f.packet.id, f.packet.revision)).id, f.packet.id);
  assert.equal((await readProjectAccess(pool, f.editor.id, f.project.id))?.permission, 'view');
  const revoked = await authedFetch(f.server, f.owner, `/api/projects/${f.project.id}/shares/${f.share}`, { method: 'DELETE' }); assert.equal(revoked.status, 200);
  await ownerEvents.waitFor(events => events.filter(row => row.type === 'project-access-changed').length === 2);
  await assert.rejects(f.context(f.editor).get(f.project.id, f.packet.id, f.packet.revision));
  assert.equal((await f.context().get(f.project.id, f.packet.id, f.packet.revision)).revision, f.packet.revision);
});

test('500 seeded model sequences match preview to actual authorization, including old proposals, groups and audience revisions', async t => {
  const f = await fixture(t), group = await seedGroup(f.owner.id);
  const groupShare = await seedGroupShare(f.project.id, group.id, 'view');
  let seed = 0x273c91;
  const roles = ['none', 'view', 'edit'] as const;
  /** Deterministic generated transitions with an independent set-union grant model. */
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  const old: { permission: typeof roles[number]; group: typeof roles[number]; member: boolean }[] = [];
  let packet = f.packet, shareId = f.share;
  const nativePlan = (await f.pm.get(f.decision.planId)).item;
  for (let sequence = 0; sequence < 500; sequence++) {
    const generated = { permission: roles[random() % 3], group: roles[random() % 3], member: random() % 2 === 0 };
    const model = sequence % 7 === 0 && old.length ? old[random() % old.length] : generated; old.push(generated);
    const before = roles[1 + random() % 2];
    shareId = await seedUserShare(f.project.id, f.editor.id, before);
    await pool.query('UPDATE pm_project_shares SET permission=$1 WHERE id=$2', [model.group, groupShare]);
    if (model.member) await addGroupMember(group.id, f.editor.id); else await pool.query('DELETE FROM pm_group_members WHERE group_id=$1 AND user_id=$2', [group.id, f.editor.id]);
    const visible = random() % 3 !== 0;
    if (sequence % 25 === 0) packet = await f.context().publish(f.project.id, { ...f.input, question: sequence % 50 ? ' CRLF\r\n evidence ' : ' whitespace evidence ', viewers: visible ? [f.editor.id] : [] }, packet);
    const audience = packet.viewers.includes(f.editor.id);
    const effective = (direct: string) => direct === 'edit' || (model.member && model.group === 'edit') ? 'edit' : direct === 'view' || (model.member && model.group === 'view') ? 'view' : 'none';
    const pre = effective(before), post = effective(model.permission), readLost = pre !== 'none' && post === 'none', writeLost = pre === 'edit' && post !== 'edit';
    const preview = await f.impact().preview(f.project.id, { shareId: sequence % 2 ? shareId.toUpperCase() : shareId, permission: model.permission, limit: 1 });
    assert.equal(preview.counts.packets, Number(readLost && audience), `packet model sequence ${sequence}`);
    assert.equal(preview.counts.decisions, Number(readLost || writeLost), `decision model sequence ${sequence}`);
    // Apply outside preview, then read the resulting state through the public authenticated SDK.
    const applied = model.permission === 'none'
      ? await authedFetch(f.server, f.owner, `/api/projects/${f.project.id}/shares/${shareId}`, { method: 'DELETE' })
      : await authedFetch(f.server, f.owner, `/api/projects/${f.project.id}/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.editor.email, permission: model.permission }) });
    assert.equal(applied.status, model.permission === 'none' ? 200 : 201);
    if (post === 'none' || !audience) await assert.rejects(f.context(f.editor).get(f.project.id, packet.id, packet.revision));
    else assert.deepEqual(await f.context(f.editor).get(f.project.id, packet.id, packet.revision), packet);
    assert.equal((await readProjectAccess(pool, f.editor.id, f.project.id))?.permission ?? 'none', post);
    assert.equal((await listDecisionInbox(f.pmRoot)).requests[0].id, f.decision.id);
  }
  assert.deepEqual((await f.pm.get(f.input.items![0])).item.parent, undefined);
  assert.deepEqual((await f.pm.get(f.decision.planId)).item, nativePlan);
});

test('native CLI emits bounded TOON/JSON with no git executable, with real authenticated HTTP', async t => {
  const f = await fixture(t);
  const { json, toon } = await nativeConsumer(f);
  assert.equal(JSON.parse(json.stdout).losses.length, 2); assert.ok(Buffer.byteLength(json.stdout) < 3500);
  assert.match(toon.stdout, /applied: false/); assert.match(toon.stdout, /unknownCapabilities: "disabled"/);
});

test('a peer grant transition at every SQL boundary preserves the read-only snapshot and is seen on refresh', async t => {
  const f = await fixture(t), peer = await pool.connect();
  t.after(() => peer.release());
  for (let boundary = 1; boundary <= 6; boundary++) {
    await peer.query("UPDATE pm_project_shares SET permission='edit' WHERE id=$1", [f.share]);
    let step = 0;
    const restorations: (() => void)[] = [];
    /** Instrument real database calls, injecting a separately committed peer write after each chosen boundary. */
    function instrument(client: PoolClient): void {
      const original = client.query;
      Object.defineProperty(client, 'query', { configurable: true, value: async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(original, client, args);
        if (++step === boundary) await peer.query("UPDATE pm_project_shares SET permission='none' WHERE id=$1", [f.share]);
        return result;
      } });
      restorations.push(() => Object.defineProperty(client, 'query', { configurable: true, value: original }));
    }
    pool.on('acquire', instrument);
    try {
      const page = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'view' });
      assert.equal(page.counts.decisions, boundary === 1 ? 0 : 1);
      assert.equal(page.applied, false);
      assert.equal(step, 6);
    } finally {
      pool.off('acquire', instrument);
      for (const restore of restorations) restore();
    }
    assert.equal((await f.impact().preview(f.project.id, { shareId: f.share, permission: 'view' })).total, 0);
    assert.equal((await readProjectAccess(pool, f.editor.id, f.project.id)), null);
  }
});

test('random custom status registries cannot hide a still-pending decision or change native relationships', async t => {
  const f = await fixture(t);
  const roles = [['active'], ['blocked'], ['terminal', 'terminal_done'], ['terminal', 'terminal_canceled']];
  for (let seed = 17; seed < 25; seed++) {
    const registered = await f.pm.schemaAddStatus(`custom-${seed * 3571}`, { role: roles[seed % roles.length] });
    await f.pm.focus(f.input.items![0]);
    await f.pm.update(f.decision.planId, { status: registered.status.id, unset: ['parent', 'goal', 'objective', 'sprint', 'release'] });
    const before = (await f.pm.get(f.decision.planId)).item;
    assert.equal(before.status, registered.status.id);
    const preview = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'view' });
    assert.equal(preview.counts.decisions, 1);
    assert.deepEqual((await f.pm.get(f.decision.planId)).item, before);
    assert.equal(before.parent, undefined);
  }
});

/** Reproduce filtered-offset drift with real SDK writes at the producer's post-capture boundary. */
test('one 51-request snapshot survives a peer answer during projection across SDK, JSON and TOON consumers', async t => {
  const f = await fixture(t);
  const captured = [f.decision];
  for (let i = 1; i < 51; i++) captured.push(await requestDecision(f.pmRoot, { author: f.owner.id, permission: 'edit' }, { planId: f.decision.planId, question: `Choice ${i}`, alternatives: ['A', 'B'], evidence: 'Public synthetic evidence' }));
  const last = captured.at(-1)!;
  const response = { planId: f.decision.planId, requestId: f.decision.id, revision: f.decision.revision, action: 'approve', alternative: 0, reason: 'Independent peer answer after SDK corpus capture' };
  const script = `import { respondToDecision } from ${JSON.stringify(pathToFileURL(path.resolve('src/services/decision-inbox.ts')).href)}; await respondToDecision(${JSON.stringify(f.pmRoot)}, ${JSON.stringify({ author: f.owner.id, permission: 'edit' })}, ${JSON.stringify(response)});`;
  const original = Buffer.byteLength;
  let answered = false;
  // Instrument only serialization of an actual projected record, after the real SDK read.
  // The SDK itself is never replaced, and the peer commits through its real mutation path.
  Buffer.byteLength = (value, encoding) => {
    const bytes = original(value, encoding);
    if (!answered && typeof value === 'string' && value.includes(`"planId":${JSON.stringify(f.decision.planId)}`) && value.includes(`"id":${JSON.stringify(last.id)}`) && value.includes('"status":"pending"')) {
      answered = true;
      const peer = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, env: process.env, encoding: 'utf8', timeout: 60000 });
      assert.equal(peer.status, 0, peer.stderr);
    }
    return bytes;
  };
  let preview: PermissionImpactPage;
  try {
    const offset = captured.map(row => row.id).sort((a, b) => a.localeCompare(b)).indexOf(last.id) === 50 ? 1 : 0;
    preview = await f.impact().preview(f.project.id, { shareId: f.share, permission: 'none', offset, limit: 50 });
  } finally { Buffer.byteLength = original; }
  assert.equal(answered, true, 'the peer must commit at the real post-read projection boundary');
  assert.equal(preview.counts.decisions, 51, 'one captured corpus must not silently omit a pending request');
  assert.ok(preview.losses.some(row => row.kind === 'decision' && row.id === last.id));
  assert.deepEqual((await readDecisionInboxSnapshot(f.pmRoot)).map(row => row.id).sort(), captured.slice(1).map(row => row.id).sort());
  assert.equal((await f.impact().preview(f.project.id, { shareId: f.share, permission: 'none' })).counts.decisions, 50, 'a new proposal must read fresh state');
  const { json, toon } = await nativeConsumer(f);
  assert.equal(JSON.parse(json.stdout).counts.decisions, 50);
  assert.match(toon.stdout, /decisions: 50/);
});

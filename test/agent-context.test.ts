import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PmClient, type PmReadOutputReceipt, type PmReadOutputSessionReceipt } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../src/index.ts';
import { AgentContextClient, AgentContextError, coreContextEvidence, packContextEvidence, type AgentContextInput, type AgentContextPacket } from '../src/agent-context.ts';
import { validateAgentContext } from '../src/services/agent-context.ts';
import { agentContextMarkup } from '../public/src/views/agent-context.ts';
import { authedFetch, ensureSchema, seedUser, seedProject, seedUserShare, startApp } from './helpers/pg-harness.ts';
import { signToken } from '../src/auth.ts';
import { pool } from '../src/db.ts';

const exec = promisify(execFile);
/** Create isolated real identities and project capabilities against the test database. */
async function fixture(t: TestContext) {
  await ensureSchema();
  const owner = await seedUser(), viewer = await seedUser(), other = await seedUser();
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, viewer.id, 'view');
  await seedUserShare(project.id, other.id, 'edit');
  const input: AgentContextInput = { agent: 'delivery-agent', question: 'Which evidence is still missing?', consent: true, viewers: [viewer.id], receipts: [{ source: 'core-output-session', receiptId: 'session-a', revision: 'source-revision-a', servedAt: '2026-10-23T00:00:00Z', omission: [{ reason: 'Two facts suppressed', remedy: 'Restore with pm get <item-id> --brief' }] }], gaps: [{ reason: 'Review unavailable', remedy: 'Obtain an independent review.' }] };
  const server = await startApp();
  t.after(async () => { await server.close(); await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id, other.id]]); });
  return { owner, viewer, other, project, input, server };
}
/** Initialize a genuine plain tracker for SDK and native-host acceptance. */
async function plainTracker(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-context-plain-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true });
  await pm.init('synthetic', { defaults: true, agentGuidance: 'skip' });
  return { cwd, pmRoot, pm };
}
/** Bind a server-verified principal to the public SDK client. */
function client(url: string, user: { id: string; email: string }): AgentContextClient { return new AgentContextClient(url, signToken({ userId: user.id, email: user.email })); }
/** Match a stable typed refusal and require a useful recovery instruction. */
function refusal(code: AgentContextError['code']) { return (error: unknown) => error instanceof AgentContextError && error.code === code && error.remedy.length > 10; }

test('scope isolation, immutable revision binding and atomic revocation through real SDK/HTTP', async t => {
  const f = await fixture(t); const { server } = f;
  const owner = client(server.url('/'), f.owner), viewer = client(server.url('/'), f.viewer), other = client(server.url('/'), f.other);
  const packet = await owner.publish(f.project.id, f.input);
  assert.equal(packet.publisher, f.owner.id);
  assert.deepEqual(await viewer.get(f.project.id, packet.id, packet.revision), packet);
  assert.equal((await other.list(f.project.id)).packets.length, 0);
  await assert.rejects(other.get(f.project.id, packet.id, packet.revision), refusal('not_found'));
  await assert.rejects(viewer.publish(f.project.id, f.input), error => refusal('view_only')(error) && (error as AgentContextError).status === 403);
  await assert.rejects(other.publish(f.project.id, f.input, packet), refusal('revision_conflict'));
  await assert.rejects(other.revoke(f.project.id, packet.id, packet.revision), refusal('revision_conflict'));
  const replies = await Promise.allSettled([owner.publish(f.project.id, { ...f.input, question: 'Updated question' }, packet), owner.publish(f.project.id, f.input, packet)]);
  assert.equal(replies.filter(row => row.status === 'fulfilled').length, 1);
  const next = replies.find(row => row.status === 'fulfilled'); assert.ok(next && next.status === 'fulfilled');
  const updated = next.value;
  assert.notEqual(packet.revision, updated.revision);
  await assert.rejects(viewer.get(f.project.id, packet.id, packet.revision), refusal('revision_conflict'));
  const reduced = await owner.publish(f.project.id, { ...f.input, viewers: [] }, updated);
  await assert.rejects(viewer.get(f.project.id, reduced.id, reduced.revision), refusal('not_found'));
  assert.equal((await viewer.list(f.project.id)).packets.length, 0);
  const renewed = await owner.publish(f.project.id, f.input, reduced);
  await pool.query('DELETE FROM pm_project_shares WHERE project_id=$1 AND shared_with_user_id=$2', [f.project.id, f.viewer.id]);
  await assert.rejects(viewer.get(f.project.id, renewed.id, renewed.revision), refusal('not_found'));
  assert.deepEqual(await owner.revoke(f.project.id, renewed.id, renewed.revision), { revoked: true });
  await assert.rejects(owner.get(f.project.id, renewed.id, renewed.revision), refusal('not_found'));
  await assert.rejects(owner.revoke(f.project.id, renewed.id, renewed.revision), refusal('revision_conflict'));
});

test('API and UI retain identical omission receipts, remedies and hostile text as escaped content', async t => {
  const f = await fixture(t); const { server } = f;
  f.input.receipts[0].omission.push({ reason: '<script>never execute</script>', remedy: '<img src=x onerror=alert(1)>' });
  const packet = await client(server.url('/'), f.owner).publish(f.project.id, f.input);
  const response = await authedFetch(server, f.viewer, `/api/projects/${f.project.id}/pm/agent-context/${packet.id}?revision=${packet.revision}`);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const retrieved = await response.json() as AgentContextPacket;
  assert.deepEqual(retrieved.receipts, f.input.receipts); assert.deepEqual(retrieved.gaps, f.input.gaps);
  const markup = agentContextMarkup(retrieved);
  assert.ok(markup.includes('Two facts suppressed')); assert.ok(markup.includes('Restore with pm get &lt;item-id&gt; --brief'));
  assert.ok(markup.includes('&lt;script&gt;never execute&lt;/script&gt;')); assert.ok(!markup.includes('<script>'));
  assert.ok(markup.includes(f.input.gaps[0].remedy));
  const privateProject = await seedProject(f.owner.id);
  await assert.rejects(client(server.url('/'), f.owner).get(privateProject.id, packet.id, packet.revision), refusal('not_found'));
});

test('input refuses implicit consent, unbounded evidence, invalid bindings and unauthenticated retrieval', async t => {
  const f = await fixture(t); const { server } = f;
  const sdk = client(server.url('/'), f.owner);
  for (const patch of [{ consent: false }, { consent: undefined }, { question: '' }, { viewers: ['invalid'] }, { viewers: [f.viewer.id, f.viewer.id] }, { receipts: [null] }, { receipts: [{ ...f.input.receipts[0], source: 'inference' }] }, { gaps: [{ reason: 'Missing', remedy: '' }] }, { question: 'x'.repeat(2001) }, { gaps: Array.from({ length: 21 }, () => f.input.gaps[0]) }]) {
    await assert.rejects(sdk.publish(f.project.id, { ...f.input, ...patch } as AgentContextInput), refusal('invalid_input'));
  }
  assert.deepEqual(validateAgentContext({ ...f.input, publisher: f.other.id }), f.input);
  const packet = await sdk.publish(f.project.id, f.input);
  for (const revision of ['', 'invalid']) await assert.rejects(sdk.get(f.project.id, packet.id, revision), refusal('invalid_input'));
  assert.equal((await fetch(server.url(`/api/projects/${f.project.id}/pm/agent-context`))).status, 401);
  for (const url of ['http://example.test', 'invalid', 'https://secret@example.test', 'https://example.test/path', 'https://example.test?query=1']) assert.throws(() => new AgentContextClient(url, 'x'), refusal('invalid_input'));
  assert.ok(new AgentContextClient('https://example.test', 'x'));
  assert.ok(new AgentContextClient('http://[::1]:4000', 'x'));
});

test('core and pm-context adapters preserve source receipt identity without inventing usage evidence', async t => {
  const { pm } = await plainTracker(t);
  const item = await pm.create({ title: 'Evidence task' });
  const output = await pm.list({ outputBudget: 2000, outputSession: { version: 1, id: 'real-session', token_budget: 4000, spent_tokens: 0, seen_item_ids: [item.item.id] } }) as { read_session: PmReadOutputSessionReceipt; read_output: PmReadOutputReceipt };
  const adapted = coreContextEvidence(output.read_session, output.read_output, 'snapshot-a', '2026-10-23T00:00:00Z');
  assert.equal(adapted.receiptId, 'real-session'); assert.ok(adapted.omission.some(row => row.reason.includes('repeated items')));
  const compacted = coreContextEvidence(output.read_session, { ...output.read_output, rows_compacted: true }, 'snapshot-a', '2026-10-23T00:00:00Z');
  assert.ok(compacted.omission.some(row => row.reason.includes('budget')));
  const pack = packContextEvidence({ protocol: 'pm-context-usage/v1', receipt_id: 'pack-a', served_at: '2026-10-23T00:00:00Z' }, 'source-a', adapted.omission);
  assert.deepEqual(pack.omission, adapted.omission); assert.equal(pack.source, 'pm-context-pack');
});

test('real extension commands work in a non-git tracker with no git executable and emit JSON/TOON', async t => {
  const f = await fixture(t); const { server } = f;
  const { cwd, pmRoot, pm } = await plainTracker(t);
  const host = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] }); t.after(() => host.deactivate());
  const oldToken = process.env.PM_WEB_TOKEN; process.env.PM_WEB_TOKEN = signToken({ userId: f.owner.id, email: f.owner.email });
  t.after(() => { if (oldToken === undefined) delete process.env.PM_WEB_TOKEN; else process.env.PM_WEB_TOKEN = oldToken; });
  const options = { url: server.url('/'), project: f.project.id };
  await assert.rejects(host.runCommand({ command: 'web agent-context publish', pmRoot, options: { ...options, input: '{' } }), /invalid_input/);
  const created = await host.runCommand({ command: 'web agent-context publish', pmRoot, options: { ...options, input: JSON.stringify(f.input) } });
  const packet = created.result as AgentContextPacket;
  for (const command of ['web agent-context', 'web agent-context get', 'web agent-context revoke']) {
    const result = await host.runCommand({ command, pmRoot, options: { ...options, id: packet.id, revision: packet.revision } }); assert.ok(result.result);
  }
  await client(server.url('/'), f.owner).publish(f.project.id, f.input);
  const bin = path.join(cwd, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
  // Exercise the native host renderer with the actual locally installed extension, not a CLI-shaped mock.
  const extensionDir = path.join(pmRoot, 'extensions', 'pm-web'); await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify({ name: 'pm-web', version: '1.0.0', entry: './index.js', capabilities: ['commands', 'schema'] }));
  await writeFile(path.join(extensionDir, 'index.js'), `export { default } from ${JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)};`);
  await pm.packageActivate('pm-web', { project: true });
  const env = { ...process.env, PM_PATH: pmRoot, PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
  await assert.rejects(exec('git', ['--version'], { env }));
  for (const format of [['--json'], []]) {
    const result = await exec(process.execPath, [path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js'), 'web', 'agent-context', '--url', server.url('/'), '--project', f.project.id, ...format], { cwd, env });
    assert.match(result.stdout, /packets/); assert.ok(Buffer.byteLength(result.stdout) < 16384);
  }
});


test('authorized discovery is bounded and paginated, including invalid offsets and hidden editors', async t => {
  const f = await fixture(t); const { server } = f;
  const sdk = client(server.url('/'), f.owner);
  for (let index = 0; index < 21; index++) await sdk.publish(f.project.id, { ...f.input, agent: `agent-${index}` });
  const first = await sdk.list(f.project.id);
  assert.equal(first.packets.length, 20); assert.equal(first.nextOffset, 20); assert.equal(first.returned, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 8192);
  const next = await sdk.list(f.project.id, first.nextOffset!);
  assert.equal(next.packets.length, 1); assert.equal(next.nextOffset, null);
  assert.ok(!first.packets.some(row => row.id === next.packets[0].id));
  for (const offset of [-1, 0.5, Number.NaN, Number.MAX_VALUE]) await assert.rejects(sdk.list(f.project.id, offset), refusal('invalid_input'));
  assert.equal((await client(server.url('/'), f.other).list(f.project.id)).returned, 0);
  const duplicate = await authedFetch(server, f.owner, `/api/projects/${f.project.id}/pm/agent-context?offset=0&offset=1`);
  assert.equal(duplicate.status, 400);
});


test('SDK transport failures and CLI setup refusals retain typed remedies', async t => {
  await assert.rejects(new AgentContextClient('http://127.0.0.1:1', 'synthetic').list('synthetic-project'), refusal('unavailable'));
  const { pmRoot } = await plainTracker(t);
  const host = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] });
  t.after(() => host.deactivate());
  await assert.rejects(host.runCommand({ command: 'web agent-context', pmRoot, options: {} }), /invalid_input/);
});

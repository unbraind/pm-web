import { IDEMPOTENT_MUTATION_ROUTES } from '../src/idempotency-routes.ts';
/** Real HTTP/PostgreSQL regressions for current authorization of immutable mutation outcomes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { pool } from '../src/db.ts';
import { createTierLimiters } from '../src/rate-limit.ts';
import { idempotencyGuard, requestFingerprint } from '../src/idempotency.ts';
import { signToken } from '../src/auth.ts';
import { authedFetch, ensureSchema, seedUser, seedProject, seedUserShare, seedGroup, startApp, type SeedUser } from './helpers/pg-harness.ts';
import { startEphemeralServer } from './helpers/ephemeral-server.ts';

/** Allocate only synthetic principals and a real plain tracker; every permission decision uses SQL. */
async function fixture(t: TestContext) {
  await ensureSchema();
  const root = await mkdtemp(path.join(os.tmpdir(), 'replay-access-'));
  const saved = process.env.PROJECTS_ROOT; process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(), editor = await seedUser(), viewer = await seedUser();
  const project = await seedProject(owner.id);
  const share = await seedUserShare(project.id, editor.id, 'edit');
  const cwd = path.join(root, owner.id, project.slug); await mkdir(cwd, { recursive: true });
  const pm = new PmClient({ cwd, pmRoot: path.join(cwd, '.agents', 'pm'), noExtensions: true });
  await pm.init('replay', { defaults: true, agentGuidance: 'skip' });
  const server = await startApp();
  t.after(async () => {
    await server.close();
    await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, editor.id, viewer.id]]);
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = saved;
  });
  const base = `/api/projects/${project.id}`;
  const input = { agent: 'review-agent', question: 'A revoked packet must disappear', consent: true, viewers: [owner.id], receipts: [], gaps: [{ reason: 'Private gap', remedy: 'Obtain authorized evidence.' }] };
  /** Run a genuine keyed mutation and wait for its asynchronous outcome settlement. */
  async function request(user: SeedUser, route: string, body: unknown, key: string, method = 'POST') {
    const response = await authedFetch(server, user, route, { method, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    return response;
  }
  return { owner, editor, viewer, project, share, pm, server, base, input, request };
}

/** Do not confuse response completion with the asynchronous PostgreSQL settlement. */
async function settled(user: string, key: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query('SELECT id FROM pm_idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND status_code IS NOT NULL', [user, key]);
    if (result.rowCount) return;
    await delay(10);
  }
  assert.fail('The original keyed outcome did not settle');
}

/** Assert a typed refusal, no replay marker and no previously authorized private content. */
async function denied(response: Response, status: number, secret: string): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('idempotency-replayed'), null);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const body = await response.text();
  assert.match(body, /PM_IDEMPOTENCY_REPLAY_.*remedy/);
  assert.equal(body.includes(secret), false);
}

/** Settlement returns only the original status and bounded identifiers, never a formerly readable body. */
async function acknowledged(response: Response, status: number, secret: string): Promise<{ status: number; ids: string[] }> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('idempotency-replayed'), 'true');
  assert.equal(response.headers.get('idempotency-outcome-only'), 'true');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const text = await response.text(); assert.equal(text.includes(secret), false);
  const body = JSON.parse(text) as { status: number; ids: string[] };
  assert.deepEqual(Object.keys(body).sort(), ['ids', 'status']);
  assert.equal(body.status, status); assert.ok(Array.isArray(body.ids)); assert.ok(body.ids.length <= 50);
  assert.ok(body.ids.every(value => typeof value === 'string'));
  return body;
}

test('keyed context publish cannot resurrect a deleted packet or replay its private question', async t => {
  const f = await fixture(t); const key = randomUUID(); const route = `${f.base}/pm/agent-context`;
  const first = await f.request(f.editor, route, f.input, key); assert.equal(first.status, 201);
  const packet = await first.json() as { id: string; revision: string }; await settled(f.editor.id, key);
  const replay = await f.request(f.editor, route, f.input, key);
  assert.equal(replay.status, 201); assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal((await replay.json() as { question: string }).question, f.input.question, 'currently authorized content replay remains intact');
  const replacement = await authedFetch(f.server, f.editor, route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f.input, id: packet.id, revision: packet.revision, question: 'Replacement consent revision' }) });
  assert.equal(replacement.status, 201);
  const current = await replacement.json() as { revision: string };
  await acknowledged(await f.request(f.editor, route, f.input, key), 201, f.input.question);
  const remove = await authedFetch(f.server, f.editor, `${route}/${packet.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: current.revision }) });
  assert.equal(remove.status, 200);
  await acknowledged(await f.request(f.editor, route, f.input, key), 201, f.input.question);
  assert.equal((await pool.query('SELECT id FROM pm_agent_context WHERE id=$1', [packet.id])).rowCount, 0);
});

test('keyed context publish rechecks the publisher project grant on every replay', async t => {
  const f = await fixture(t); const key = randomUUID(); const route = `${f.base}/pm/agent-context`;
  assert.equal((await f.request(f.editor, route, f.input, key)).status, 201); await settled(f.editor.id, key);
  assert.equal((await authedFetch(f.server, f.owner, `${f.base}/shares/${f.share}`, { method: 'DELETE' })).status, 200);
  await acknowledged(await f.request(f.editor, route, f.input, key), 201, f.input.question);
  assert.equal((await pool.query('SELECT id FROM pm_agent_context WHERE project_id=$1', [f.project.id])).rowCount, 1, 'the original is retained, never reexecuted');
});

test('another idempotent PM route settles without content after editor capability is downgraded', async t => {
  const f = await fixture(t); const key = randomUUID(); const route = `${f.base}/pm/create`;
  const body = { type: 'Task', title: 'Confidential cached task' };
  assert.equal((await f.request(f.editor, route, body, key)).status, 201); await settled(f.editor.id, key);
  await pool.query("UPDATE pm_project_shares SET permission='view' WHERE id=$1", [f.share]);
  await acknowledged(await f.request(f.editor, route, body, key), 201, body.title);
  assert.equal((await f.pm.listAllComplete({})).items.length, 1);
});

test('cached item creation settles without deleted item content or another execution', async t => {
  const f = await fixture(t); const key = randomUUID(); const route = `${f.base}/pm/create`;
  const body = { type: 'Task', title: 'Deleted cached task' };
  const first = await f.request(f.editor, route, body, key);
  const result = await first.json() as { id: string }; await settled(f.editor.id, key);
  assert.equal((await f.request(f.editor, route, body, key)).status, 201);
  assert.equal((await authedFetch(f.server, f.editor, `${f.base}/pm/delete/${result.id}`, { method: 'DELETE' })).status, 200);
  await acknowledged(await f.request(f.editor, route, body, key), 201, body.title);
});

test('group creation replay withholds content after ownership transfer and deletion', async t => {
  const f = await fixture(t); const key = randomUUID(); const body = { name: 'Private cached group' };
  const first = await f.request(f.owner, '/api/groups', body, key); assert.equal(first.status, 201);
  const result = await first.json() as { group: { id: string } }; await settled(f.owner.id, key);
  await pool.query('UPDATE pm_groups SET owner_id=$1 WHERE id=$2', [f.editor.id, result.group.id]);
  await acknowledged(await f.request(f.owner, '/api/groups', body, key), 201, body.name);
  await pool.query('DELETE FROM pm_groups WHERE id=$1', [result.group.id]);
  await acknowledged(await f.request(f.owner, '/api/groups', body, key), 201, body.name);
});

test('share and group-member cached bodies cannot reveal withdrawn associations', async t => {
  const f = await fixture(t); const shareKey = randomUUID(); const shareRoute = `${f.base}/shares`;
  const shareBody = { email: f.viewer.email, permission: 'view' };
  const share = await (await f.request(f.owner, shareRoute, shareBody, shareKey)).json() as { share: { id: string } }; await settled(f.owner.id, shareKey);
  assert.equal((await f.request(f.owner, shareRoute, shareBody, shareKey)).status, 201);
  await authedFetch(f.server, f.owner, `${shareRoute}/${share.share.id}`, { method: 'DELETE' });
  await acknowledged(await f.request(f.owner, shareRoute, shareBody, shareKey), 201, f.viewer.email);
  const group = await seedGroup(f.owner.id); const memberKey = randomUUID(); const memberRoute = `/api/groups/${group.id}/members`;
  const memberBody = { email: f.viewer.email };
  assert.equal((await f.request(f.owner, memberRoute, memberBody, memberKey)).status, 201); await settled(f.owner.id, memberKey);
  assert.equal((await f.request(f.owner, memberRoute, memberBody, memberKey)).status, 201);
  await pool.query('DELETE FROM pm_group_members WHERE group_id=$1 AND user_id=$2', [group.id, f.viewer.id]);
  await acknowledged(await f.request(f.owner, memberRoute, memberBody, memberKey), 201, f.viewer.email);
});

test('admin replay checks the live admin role instead of trusting the signed token', async t => {
  const f = await fixture(t); await pool.query('UPDATE pm_users SET is_admin=TRUE WHERE id=$1', [f.owner.id]);
  const key = randomUUID(); const route = `/api/admin/users/${f.editor.id}`; const body = { isAdmin: true };
  assert.equal((await f.request(f.owner, route, body, key, 'PATCH')).status, 200); await settled(f.owner.id, key);
  assert.equal((await f.request(f.owner, route, body, key, 'PATCH')).status, 200);
  await pool.query('UPDATE pm_users SET is_admin=FALSE WHERE id=$1', [f.owner.id]);
  await acknowledged(await f.request(f.owner, route, body, key, 'PATCH'), 200, f.editor.email);
});

test('opaque provider successes settle without content while unregistered policies fail closed', async t => {
  const f = await fixture(t);
  for (const route of [`${f.base}/github/push`, `${f.base}/github/import`, `${f.base}/extensions/pm-context/run`, `${f.base}/pm/graph/query`, `${f.base}/unregistered`]) {
    const key = randomUUID(); const body = {}; const secret = 'Opaque private provider output';
    await pool.query(`INSERT INTO pm_idempotency_keys(user_id,idempotency_key,method,path,request_fingerprint,status_code,response_body,response_content_type,outcome_state) VALUES($1,$2,'POST',$3,$4,200,$5,'application/json','completed')`, [f.editor.id, key, route, requestFingerprint('POST', route, body), route.endsWith('/import') ? secret : JSON.stringify({ id: 'SensitiveProviderToken', results: [{ id: 'OtherOpaqueContent' }], secret })]);
    if (route.endsWith('/unregistered')) await denied(await f.request(f.editor, route, body, key), 403, secret);
    else assert.deepEqual((await acknowledged(await f.request(f.editor, route, body, key), 200, secret)).ids, [f.project.id]);
  }
});

test('an embedding without a replay authorizer refuses duplicates and preserves at-most-once execution', async t => {
  const f = await fixture(t); const app = express(); app.use(express.json()); app.use(createTierLimiters(process.env).write); app.use(idempotencyGuard());
  let calls = 0; app.post('/probe', (_req, res) => { calls++; res.json({ secret: 'Protected probe' }); });
  const server = await startEphemeralServer(app); t.after(() => server.close()); const key = randomUUID();
  const options = { method: 'POST', headers: { authorization: `Bearer ${signToken({ userId: f.owner.id, email: f.owner.email })}`, 'idempotency-key': key } };
  assert.equal((await fetch(server.url('/probe'), options)).status, 200); await settled(f.owner.id, key);
  await denied(await fetch(server.url('/probe'), options), 403, 'Protected probe'); assert.equal(calls, 1);
});


test('every canonical keyed mutation is covered by the explicit replay route audit', async () => {
  const prefixes: Record<string, string> = { projects: '/api/projects', pm: '/api/projects/:projectId/pm', 'agent-context': '/api/projects/:projectId/pm', extensions: '/api/projects/:projectId/extensions', sharing: '/api/projects/:id/shares', github: '/api/projects/:id/github', groups: '/api/groups', admin: '/api/admin' };
  const discovered: string[] = [];
  for (const [module, prefix] of Object.entries(prefixes)) {
    const source = await readFile(`src/routes/${module}.ts`, 'utf8');
    const registrations = [...source.matchAll(/^\s*(?:router|sharesRouter)\.(post|put|patch|delete)\(/gm)];
    const literals = [...source.matchAll(/^\s*(?:router|sharesRouter)\.(post|put|patch|delete)\((['"])(.*?)\2/gm)];
    assert.equal(literals.length, registrations.length, 'Nonliteral route registration needs an explicit authorization audit.');
    for (const match of literals) discovered.push(`${match[1].toUpperCase()} ${prefix}${match[3] === '/' ? '' : match[3]}`);
  }
  assert.deepEqual(discovered.sort(), IDEMPOTENT_MUTATION_ROUTES.map(route => `${route.method} ${route.path}`).sort());
});


test('successful packet DELETE settles after resource and access removal only for its original principal', async t => {
  const f = await fixture(t); const route = `${f.base}/pm/agent-context`;
  const packet = await (await f.request(f.editor, route, f.input, randomUUID())).json() as { id: string; revision: string };
  const key = randomUUID(), remove = `/API/PROJECTS/${f.project.id}/PM/AGENT-CONTEXT/${packet.id}/`, body = { revision: packet.revision };
  assert.equal((await f.request(f.editor, remove, body, key, 'DELETE')).status, 200); await settled(f.editor.id, key);
  await authedFetch(f.server, f.owner, `${f.base}/shares/${f.share}`, { method: 'DELETE' });
  const receipt = await acknowledged(await f.request(f.editor, remove, body, key, 'DELETE'), 200, f.input.question);
  assert.deepEqual(new Set(receipt.ids), new Set([f.project.id, packet.id]));
  for (const [principal, status] of [[f.owner, 409], [f.viewer, 404]] as const) {
    const other = await f.request(principal, remove, body, key, 'DELETE');
    assert.equal(other.status, status); assert.equal(other.headers.get('idempotency-replayed'), null);
    assert.equal(other.headers.get('idempotency-outcome-only'), null, 'another principal has no original success receipt');
  }
  assert.equal((await f.request(f.editor, remove, { revision: randomUUID() }, key, 'DELETE')).status, 422, 'a success receipt cannot be rebound to another request');
  assert.equal((await pool.query('SELECT id FROM pm_agent_context WHERE id=$1', [packet.id])).rowCount, 0);
});

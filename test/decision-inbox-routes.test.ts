import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { authedFetch, ensureSchema, seedUser, seedProject, seedUserShare, startApp } from './helpers/pg-harness.ts';
import type { DecisionRequest } from '../src/services/decision-inbox.ts';

/** Seed real PostgreSQL permissions and a plain tracker; no hosted workspace participates. */
async function setup(t: TestContext) {
  await ensureSchema();
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-http-'));
  const previous = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(); const viewer = await seedUser(); const editor = await seedUser(); const stranger = await seedUser();
  const project = await seedProject(owner.id, undefined, { name: 'Decision workspace', prefix: 'inbox' });
  await seedUserShare(project.id, viewer.id, 'view');
  await seedUserShare(project.id, editor.id, 'edit');
  const cwd = path.join(root, owner.id, project.slug);
  await mkdir(cwd, { recursive: true });
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const client = new PmClient({ pmRoot, cwd, noExtensions: true });
  await client.init('inbox', { defaults: true, agentGuidance: 'skip' });
  const plan = await client.planCreate({ title: 'Delivery strategy' });
  const server = await startApp();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previous;
  });
  const base = `/api/projects/${project.id}/pm/decision-inbox`;
  const input = { planId: plan.plan.id, question: 'Which strategy?', alternatives: ['Local', 'Remote'], evidence: 'Synthetic capacity receipt' };
  return { server, owner, viewer, editor, stranger, base, input, client, pmRoot };
}

/** Build a JSON mutation crossing the real CSRF middleware. */
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

test('real HTTP enforces membership, editor capability and revision checks without lifecycle approval', async t => {
  const f = await setup(t);
  const create = await authedFetch(f.server, f.owner, `${f.base}/requests`, post(f.input));
  assert.equal(create.status, 201, await create.clone().text());
  const request = await create.json() as DecisionRequest;
  assert.equal(request.author, f.owner.id);
  const viewerPage = await authedFetch(f.server, f.viewer, f.base);
  assert.equal(viewerPage.status, 200);
  assert.equal((await viewerPage.json() as { total: number }).total, 1);
  for (const user of [f.viewer, f.stranger]) {
    const attempt = await authedFetch(f.server, user, `${f.base}/responses`, post({ planId: f.input.planId, requestId: request.id, revision: request.revision, action: 'approve', alternative: 0, reason: 'Unauthorized' }));
    assert.equal(attempt.status, user.id === f.viewer.id ? 403 : 404);
    if (attempt.status === 403) assert.match(await attempt.text(), /view_only.*remedy/);
  }
  const response = { planId: f.input.planId, requestId: request.id, revision: request.revision, action: 'approve', alternative: 0, reason: 'Explicit editor choice' };
  const replies = await Promise.all([f.owner, f.editor].map(user => authedFetch(f.server, user, `${f.base}/responses`, post(response))));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const success = await replies.find(reply => reply.status === 200)!.json() as { codeReview: boolean; taskCompletion: boolean };
  assert.equal(success.codeReview, false); assert.equal(success.taskCompletion, false);
  const conflict = await replies.find(reply => reply.status === 409)!.json() as { code: string; remedy: string };
  assert.equal(conflict.code, 'revision_conflict'); assert.match(conflict.remedy, /Refresh/);
  const plan = await f.client.planShow(f.input.planId, { depth: 'deep' });
  assert.equal(plan.plan.mode, 'draft'); assert.equal(plan.plan.status, 'open');
  assert.equal(plan.plan.decisions?.length, 2);
});

test('HTTP reports actionable validation, missing project/request and unavailable storage failures', async t => {
  const f = await setup(t);
  for (const [suffix, body] of [['requests', {}], ['responses', {}]] as const) {
    const bad = await authedFetch(f.server, f.owner, `${f.base}/${suffix}`, post(body));
    assert.equal(bad.status, 400); assert.match(await bad.text(), /invalid_input.*remedy/);
  }
  const badLimit = await authedFetch(f.server, f.owner, `${f.base}?limit=500`);
  assert.equal(badLimit.status, 400);
  const unknown = await authedFetch(f.server, f.stranger, f.base);
  assert.equal(unknown.status, 404);
  await rm(f.pmRoot, { recursive: true, force: true });
  const unavailable = await authedFetch(f.server, f.owner, f.base);
  assert.equal(unavailable.status, 503); assert.match(await unavailable.text(), /unavailable.*remedy/);
});

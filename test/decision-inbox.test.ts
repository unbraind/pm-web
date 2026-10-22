import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { PmClient, EXIT_CODE, isPmCliExpectedError, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../src/index.ts';
import { DecisionInboxError, listDecisionInbox, requestDecision, respondToDecision, type DecisionRequestInput } from '../src/services/decision-inbox.ts';
import { respond } from '../public/src/views/decision-inbox.ts';
import { state } from '../public/src/state.js';

const exec = promisify(execFile);
const editor = { author: 'synthetic-agent', permission: 'edit' as const };

/** Initialize a genuine tracker with its discovery ceiling above a non-git scratch directory. */
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pm-inbox-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const client = new PmClient({ cwd, pmRoot, noExtensions: true, author: editor.author });
  await client.init('inbox', { defaults: true, agentGuidance: 'skip' });
  const plan = await client.planCreate({ title: 'Choose a delivery strategy', step: ['Implement', 'Review'] });
  const input: DecisionRequestInput = { planId: plan.plan.id, question: 'Which storage strategy?', alternatives: ['Local files', 'Remote database'], evidence: 'Synthetic benchmark: 4 ms local; 7 ms remote.' };
  return { cwd, pmRoot, client, input };
}

/** Match the stable typed refusal and its actionable remedy. */
function refusal(code: DecisionInboxError['code']) {
  return (error: unknown) => error instanceof DecisionInboxError && error.code === code && error.remedy.length > 10;
}

/** Install a local extension through the real package activation path in a plain tracker. */
async function installExtension(pmRoot: string, client: PmClient, name: string, entry: string, capabilities: string[]): Promise<void> {
  const installed = path.join(pmRoot, 'extensions', name);
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', entry: './index.js', capabilities }));
  await writeFile(path.join(installed, 'index.js'), `export { default } from ${JSON.stringify(pathToFileURL(path.resolve(entry)).href)};`);
  await client.packageActivate(name, { project: true });
}

/** Activate the real inbox command host and register teardown for every CLI regression. */
async function inboxHost(t: TestContext) {
  const host = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] });
  t.after(() => host.deactivate());
  return host;
}

test('requests preserve core plan state; acknowledgment is pending and invalidates the old revision', async t => {
  const { pmRoot, client, input } = await fixture(t);
  const before = await client.planShow(input.planId, { depth: 'deep' });
  const request = await requestDecision(pmRoot, editor, input);
  assert.equal(request.status, 'pending');
  assert.equal(request.evidence, input.evidence);
  assert.equal(request.author, editor.author);
  const response = { planId: request.planId, requestId: request.id, revision: request.revision, action: 'acknowledge' as const, reason: 'Read the evidence; awaiting the operator.' };
  const ack = await respondToDecision(pmRoot, editor, response);
  assert.equal(ack.request.status, 'pending');
  assert.equal(ack.request.acknowledgments, 1);
  assert.equal(ack.codeReview, false);
  assert.equal(ack.taskCompletion, false);
  assert.notEqual(ack.request.revision, request.revision);
  await assert.rejects(respondToDecision(pmRoot, editor, response), refusal('revision_conflict'));
  const approved = await respondToDecision(pmRoot, editor, { ...response, revision: ack.request.revision, action: 'approve', alternative: 1, reason: 'Shared access is required.' });
  assert.equal(approved.request.status, 'answered');
  assert.equal((await listDecisionInbox(pmRoot)).total, 0);
  await assert.rejects(respondToDecision(pmRoot, editor, { ...response, revision: approved.request.revision }), refusal('already_answered'));
  const after = await client.planShow(input.planId, { depth: 'deep' });
  assert.equal(after.plan.status, before.plan.status);
  assert.equal(after.plan.mode, before.plan.mode);
  assert.deepEqual(after.plan.steps, before.plan.steps);
  assert.match(JSON.stringify(after.plan.decisions), /Approved: Remote database/);
  const history = await readFile(path.join(pmRoot, 'history', `${input.planId}.jsonl`), 'utf8');
  assert.match(history, /Respond to a human-agent decision/);
  assert.match(history, /synthetic-agent/);
});

test('bounded listing ignores ordinary decisions and paginates every pending request', async t => {
  const { pmRoot, client, input } = await fixture(t);
  assert.deepEqual(await listDecisionInbox(pmRoot), { requests: [], total: 0, nextOffset: null, codeReview: false, taskCompletion: false });
  await client.planDecision(input.planId, { decisionText: 'An ordinary recorded decision' });
  const first = await requestDecision(pmRoot, editor, input);
  const second = await requestDecision(pmRoot, editor, { ...input, question: 'Which backup strategy?' });
  const page = await listDecisionInbox(pmRoot, { limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
  assert.equal(page.requests[0].id, first.id);
  const next = await listDecisionInbox(pmRoot, { limit: 1, offset: page.nextOffset! });
  assert.equal(next.requests[0].id, second.id); assert.equal(next.nextOffset, null);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1800);
  await assert.rejects(listDecisionInbox(pmRoot, { limit: 0 }), refusal('invalid_input'));
  await assert.rejects(listDecisionInbox(pmRoot, { limit: 51 }), refusal('invalid_input'));
  await assert.rejects(listDecisionInbox(pmRoot, { offset: -1 }), refusal('invalid_input'));
});

test('refusals reject view-only actors and malformed input without appending a decision', async t => {
  const { pmRoot, client, input } = await fixture(t);
  const viewer = { ...editor, permission: 'view' as const };
  await assert.rejects(requestDecision(pmRoot, viewer, input), refusal('view_only'));
  await assert.rejects(respondToDecision(pmRoot, viewer, {} as never), refusal('view_only'));
  for (const patch of [{ question: '' }, { evidence: '' }, { question: 'x'.repeat(1001) }, { alternatives: ['One'] }, { alternatives: ['One', 'One'] }, { alternatives: ['One', 2] }, { alternatives: Array.from({ length: 9 }, (_, index) => String(index)) }]) {
    await assert.rejects(requestDecision(pmRoot, editor, { ...input, ...patch } as DecisionRequestInput), refusal('invalid_input'));
  }
  await assert.rejects(requestDecision(pmRoot, { ...editor, author: '' }, input), refusal('invalid_input'));
  await assert.rejects(requestDecision(pmRoot, editor, { ...input, planId: '' }), refusal('invalid_input'));
  await assert.rejects(requestDecision(pmRoot, editor, { ...input, planId: 'inbox-missing' }), refusal('not_found'));
  const request = await requestDecision(pmRoot, editor, input);
  const response = { planId: input.planId, requestId: request.id, revision: request.revision, action: 'approve' as const, reason: 'Choice' };
  for (const patch of [{ alternative: -1 }, { alternative: 2 }, { alternative: 0.5 }, { reason: '' }, { action: 'complete' }, { revision: '' }]) {
    await assert.rejects(respondToDecision(pmRoot, editor, { ...response, ...patch } as typeof response), refusal('invalid_input'));
  }
  await assert.rejects(respondToDecision(pmRoot, editor, { ...response, requestId: 'missing' }), refusal('not_found'));
  assert.equal((await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length, 1);
});

test('independent processes race on one revision without git; exactly one response is audited', { timeout: 60000 }, async t => {
  const { pmRoot, client, input, cwd } = await fixture(t);
  const bin = path.join(cwd, 'bin'); await mkdir(bin);
  if (process.platform === 'win32') return;
  await symlink(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
  assert.ok(spawnSync('git', ['--version'], { env }).error);
  const helper = path.resolve('test/helpers/inbox-child.ts');
  const created = await exec(process.execPath, [helper, 'request', pmRoot, JSON.stringify(input)], { env, cwd });
  const request = JSON.parse(created.stdout) as { id: string; revision: string };
  const response = { planId: input.planId, requestId: request.id, revision: request.revision, action: 'approve', alternative: 0, reason: 'Selected after comparing evidence' };
  const runs = await Promise.allSettled([0, 1].map(index => exec(process.execPath, [helper, 'respond', pmRoot, JSON.stringify({ ...response, planId: index === 0 ? input.planId : input.planId.toUpperCase() })], { env, cwd })));
  assert.equal(runs.filter(row => row.status === 'fulfilled').length, 1);
  const failed = runs.find(row => row.status === 'rejected');
  assert.equal(failed?.status, 'rejected');
  if (failed?.status === 'rejected') assert.match(String(failed.reason.stdout), /revision_conflict/);
  const listed = await exec(process.execPath, [helper, 'list', pmRoot], { env, cwd });
  assert.equal(JSON.parse(listed.stdout).total, 0);
  assert.equal((await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length, 2);
});

test('real extension host dispatches inbox commands and structured refusals', async t => {
  const { pmRoot, input } = await fixture(t);
  const host = await inboxHost(t);
  const created = await host.runCommand({ command: 'web inbox request', pmRoot, options: { input: JSON.stringify(input), actor: editor.author } });
  assert.ok(created);
  const page = await host.runCommand({ command: 'web inbox', pmRoot, options: { limit: '1' } });
  assert.equal((page.result as { total: number }).total, 1);
  await assert.rejects(host.runCommand({ command: 'web inbox request', pmRoot, options: { input: '{' } }), /invalid_input/);
});

test('byte budget paginates large evidence without truncating a request', async t => {
  const { pmRoot, input } = await fixture(t);
  const large = { ...input, question: 'Q'.repeat(1000), alternatives: Array.from({ length: 8 }, (_, i) => `${i}${'A'.repeat(239)}`), evidence: 'E'.repeat(2000) };
  for (let count = 0; count < 4; count += 1) await requestDecision(pmRoot, editor, large);
  const page = await listDecisionInbox(pmRoot, { limit: 50 });
  assert.ok(page.requests.length < 4); assert.ok(page.nextOffset); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16384);
  assert.equal(page.requests[0].evidence, large.evidence);
  await assert.rejects(requestDecision(pmRoot, editor, { ...large, question: '界'.repeat(1000), evidence: '界'.repeat(2000), alternatives: Array.from({ length: 8 }, (_, index) => `${index}${'界'.repeat(239)}`) }), refusal('invalid_input'));
});

test('native CLI emits bounded JSON and TOON in a non-git tracker with no git executable', { timeout: 60000 }, async t => {
  const { cwd, pmRoot, input, client } = await fixture(t);
  if (process.platform === 'win32') return;
  await installExtension(pmRoot, client, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  const bin = path.join(cwd, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(cwd), PM_AUTHOR: editor.author };
  const cli = path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js');
  const invoke = (args: string[]) => exec(process.execPath, [cli, '--pm-path', pmRoot, ...args], { cwd, env });
  const request = await invoke(['web', 'inbox', 'request', '--input', JSON.stringify(input), '--json']);
  const created = JSON.parse(request.stdout) as { id: string; revision: string };
  assert.ok(created.id); assert.ok(created.revision);
  const json = await invoke(['web', 'inbox', '--limit', '1', '--json']);
  assert.equal(JSON.parse(json.stdout).total, 1);
  assert.ok(Buffer.byteLength(json.stdout) < 2000);
  const toon = await invoke(['web', 'inbox', '--limit', '1']);
  assert.match(toon.stdout, /total: 1/); assert.match(toon.stdout, /taskCompletion: false/);
  await assert.rejects(invoke(['web', 'inbox', 'request', '--input', '{}', '--json']), error => {
    const result = error as { stdout: string; stderr: string; code: number };
    assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /invalid_input/); return true;
  });
});

test('committed response survives a real lock provider cleanup failure', { timeout: 60000 }, async t => {
  const { cwd, pmRoot, input, client } = await fixture(t);
  const request = await requestDecision(pmRoot, editor, input);
  await installExtension(pmRoot, client, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  await installExtension(pmRoot, client, 'inbox-lock-fault', 'test/helpers/inbox-lock-extension.ts', ['services']);
  const response = { planId: input.planId, requestId: request.id, revision: request.revision, action: 'approve' as const, alternative: 0, reason: 'Selected explicitly' };
  const body = await runWithActiveExtensions({ cwd, path: pmRoot }, () => respondToDecision(pmRoot, editor, response));
  assert.equal(body.request.status, 'answered'); assert.equal(body.codeReview, false); assert.equal(body.taskCompletion, false);
  assert.match(await readFile(path.join(pmRoot, 'release-fault-observed'), 'utf8'), /cleanup failed/);
  await assert.rejects(runWithActiveExtensions({ cwd, path: pmRoot }, () => respondToDecision(pmRoot, editor, response)), refusal('revision_conflict'));
  assert.equal((await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length, 2);
  assert.equal((await listDecisionInbox(pmRoot)).total, 0);
});


test('CLI inbox refusals distinguish unavailable trackers from invalid input and missing plans', async t => {
  const { pmRoot, input } = await fixture(t);
  const host = await inboxHost(t);
  for (const [options, code] of [
    [{ input: '{}' }, EXIT_CODE.USAGE],
    [{ input: JSON.stringify({ ...input, planId: 'inbox-missing' }) }, EXIT_CODE.NOT_FOUND],
  ] as const) {
    await assert.rejects(host.runCommand({ command: 'web inbox request', pmRoot, options }), error => isPmCliExpectedError(error) && error.exitCode === code);
  }
  await writeFile(path.join(pmRoot, 'plans', `${input.planId}.toon`), 'malformed tracker item');
  await assert.rejects(host.runCommand({ command: 'web inbox request', pmRoot, options: { input: JSON.stringify(input) } }), error => {
    assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, EXIT_CODE.DEPENDENCY_FAILED);
    assert.match(error.message, /unavailable/); return true;
  });
  await rm(pmRoot, { recursive: true, force: true });
  await assert.rejects(host.runCommand({ command: 'web inbox', pmRoot }), error => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.DEPENDENCY_FAILED);
});

test('CLI inbox pagination refuses blank and structured values before coercion', async t => {
  const { pmRoot } = await fixture(t);
  const host = await inboxHost(t);
  for (const options of [{ offset: '' }, { offset: '  ' }, { limit: '' }, { offset: ['0'] }, { offset: null }, { offset: false }]) {
    await assert.rejects(host.runCommand({ command: 'web inbox', pmRoot, options }), error => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE);
  }
  for (const options of [{}, { limit: '1', offset: '0' }]) {
    const page = await host.runCommand({ command: 'web inbox', pmRoot, options });
    assert.equal((page.result as { total: number }).total, 0);
  }
});

test('malformed stored envelopes name the affected Plan without reporting caller input errors', async t => {
  const prefix = 'pm-web:decision-inbox:v1:';
  const badRows = ['{', 'null', JSON.stringify({ kind: 'request', id: '' }), JSON.stringify({ kind: 'request', id: 'bad', question: 'Q', alternatives: ['one'] })];
  for (const rationale of badRows) {
    const { pmRoot, client, input } = await fixture(t);
    await requestDecision(pmRoot, editor, input);
    await client.planDecision(input.planId, { decisionText: 'Malformed stored record', decisionRationale: prefix + rationale });
    await assert.rejects(listDecisionInbox(pmRoot), error => error instanceof DecisionInboxError && error.code === 'invalid_record' && error.status === 503 && error.remedy.includes(input.planId));
    const before = (await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length;
    await assert.rejects(requestDecision(pmRoot, editor, input), refusal('invalid_record'));
    assert.equal((await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length, before, 'invalid stored logs must refuse before appending another request');
  }
  for (const defect of ['duplicate', 'evidence', 'author']) {
    const { pmRoot, client, input } = await fixture(t);
    const request = await requestDecision(pmRoot, editor, input);
    if (defect === 'duplicate') {
      const plan = await client.planShow(input.planId, { depth: 'deep' });
      await client.planDecision(input.planId, { decisionText: 'Duplicate', decisionRationale: plan.plan.decisions![0].rationale, decisionEvidence: input.evidence, author: editor.author });
    } else {
      const itemFile = path.join(pmRoot, 'plans', `${input.planId}.toon`);
      const source = await readFile(itemFile, 'utf8');
      await writeFile(itemFile, source.replace(defect === 'evidence' ? input.evidence : `,${editor.author},`, defect === 'evidence' ? '' : `,${'A'.repeat(161)},`));
    }
    await assert.rejects(listDecisionInbox(pmRoot), error => error instanceof DecisionInboxError && error.code === 'invalid_record' && error.remedy.includes(input.planId), defect);
    await assert.rejects(respondToDecision(pmRoot, editor, { planId: input.planId, requestId: request.id, revision: request.revision, action: 'acknowledge', reason: 'Read' }), refusal('invalid_record'));
  }
  const { pmRoot, client, input } = await fixture(t);
  const oversized = { kind: 'request', id: 'oversized', question: 'Q' + '\u0001'.repeat(999), alternatives: Array.from({ length: 8 }, (_, index) => String(index) + '\u0001'.repeat(239)) };
  await client.planDecision(input.planId, { decisionText: 'Oversized stored envelope', decisionRationale: prefix + JSON.stringify(oversized), decisionEvidence: 'E' + '\u0001'.repeat(1999), author: editor.author });
  await assert.rejects(listDecisionInbox(pmRoot), error => error instanceof DecisionInboxError && error.code === 'invalid_record' && error.status === 503 && error.remedy.includes(input.planId));
  await assert.rejects(requestDecision(pmRoot, editor, input), refusal('invalid_record'));
  assert.equal((await client.planShow(input.planId, { depth: 'deep' })).plan.decisions?.length, 1, 'oversized stored records must refuse before append');
});

test('offline-queued decision responses are reported as not yet recorded', async t => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { fetch: globalThis.fetch, document: globals.document, FormData: globals.FormData, project: state.currentProject };
  t.after(() => { globalThis.fetch = previous.fetch; globals.document = previous.document; globals.FormData = previous.FormData; state.currentProject = previous.project; });
  globals.document = { cookie: '' };
  globals.FormData = class { get(name: string) { return name === 'reason' ? 'Because' : '1'; } };
  state.currentProject = { id: 'fixture', permission: 'edit' } as NonNullable<typeof state.currentProject>;
  const request = { planId: 'p', id: 'r', revision: 'rev', question: 'q', alternatives: ['a', 'b'], evidence: 'e', author: 'x', createdAt: 'now', acknowledgments: 0 };
  const run = async (body: unknown, status: number, action: 'approve' | 'acknowledge') => {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
    const result = { textContent: '' };
    const form = { querySelector: (selector: string) => selector === '.decision-result' ? result : null, querySelectorAll: () => [] } as unknown as HTMLFormElement;
    await respond(form, request, 'fixture', action);
    return result.textContent;
  };
  assert.equal(await run({ queued: true }, 202, 'approve'), 'Alternative queued. It has not been recorded in the plan yet.');
  assert.equal(await run({ queued: true }, 202, 'acknowledge'), 'Acknowledgment queued. It has not been recorded yet.');
  assert.match(await run({ ok: true }, 200, 'approve'), /^Alternative approved and recorded in the plan/);
  assert.match(await run({ ok: true }, 200, 'acknowledge'), /^Acknowledged\. The request remains pending/);
});

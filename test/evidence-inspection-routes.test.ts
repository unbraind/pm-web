import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installExtension } from './helpers/install-runtime-extension.ts';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { decodePmTableRows, type PmEncodedTableRows, type PmTableCellEncoding } from '@unbrained/pm-cli/sdk';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cite } from 'pm-evidence';
import { EvidenceInspectionClient } from '../src/evidence-inspection-client.ts';
import { EvidenceInspectionError, evidenceInspectionPageSchema, parseEvidenceInspectionPage } from '../src/evidence-inspection.ts';
import { inspectEvidence } from '../src/services/evidence-inspection.ts';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import { evidenceTracker } from './helpers/evidence-tracker.ts';
import { authedFetch, ensureSchema, seedProject, seedUser, seedUserShare, startApp } from './helpers/pg-harness.ts';

test('authorized HTTP, SDK and UI facts match; viewers cannot write schemas, select sources or cross projects', async t => {
  await ensureSchema();
  const previous = process.env.PROJECTS_ROOT, root = await mkdtemp(path.join(tmpdir(), 'evidence-http-'));
  process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(), viewer = await seedUser(), outsider = await seedUser();
  const project = await seedProject(owner.id), other = await seedProject(outsider.id);
  await seedUserShare(project.id, viewer.id, 'view');
  const host = await evidenceTracker(path.join(root, owner.id, project.slug));
  const foreign = await evidenceTracker(path.join(root, outsider.id, other.slug));
  await writeFile(path.join(foreign.root, 'source-0.txt'), 'Other project private source');
  const { item: protectedItem } = await host.client.create({ type: 'Task', title: 'Synthetic protected-source probe', unset: ['parent', 'assignee', 'sprint', 'release', 'goal', 'objective'] });
  const privateMarker = 'SYNTHETIC_VIEWER_PRIVATE_BYTES';
  await writeFile(path.join(host.root, '.private-evidence.txt'), privateMarker);
  await symlink('.private-evidence.txt', path.join(host.root, 'allowed-alias.txt'));
  await cite(protectedItem.id, 'allowed-alias.txt', { ...host, author: 'synthetic-policy', selector: { kind: 'lines', start: 1, end: 1 }, retain: true });
  const exactSource = '{"value":9007199254740993,"__proto__":{"value":1e309},"text":"literal\\ntext"}';
  await writeFile(path.join(host.root, 'exact.json'), exactSource);
  for (const pointer of ['/value', '/__proto__/value', '/text', '']) await cite(protectedItem.id, 'exact.json', { ...host, author: 'exact-source', selector: { kind: 'pointer', pointer } });
  const server = await startApp();
  t.after(async () => { await server.close(); await pool.query('DELETE FROM pm_users WHERE id IN ($1,$2,$3)', [owner.id, viewer.id, outsider.id]); await rm(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previous; });
  const url = `/api/projects/${project.id}/pm/evidence/${host.id}`;
  const sdk = new EvidenceInspectionClient(server.url('/'), signToken({ userId: viewer.id, email: viewer.email }));
  const settings = await readFile(path.join(host.workspace, 'settings.json'));
  const history = await readFile(path.join(host.workspace, 'history', `${host.id}.jsonl`));
  const response = await authedFetch(server, viewer, url);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  const protectedPage = await sdk.inspect(project.id, { item: protectedItem.id });
  assert.equal(protectedPage.rows[0].code, 'boundary');
  assert.equal(protectedPage.rows[0].cited.text, null); assert.equal(protectedPage.rows[0].current.text, null);
  assert.ok(!JSON.stringify(protectedPage).includes(privateMarker));
  assert.deepEqual(protectedPage.rows.slice(1).map(row => row.current.text), ['9007199254740993', '1e309', '"literal\\ntext"', exactSource]);
  const local = await inspectEvidence(host, { item: host.id });
  assert.deepEqual(await response.json(), local); assert.deepEqual(await sdk.inspect(project.id, { item: host.id }), local);
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const refusal = await authedFetch(server, viewer, url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: true }) });
    assert.equal(refusal.status, 405); const body = await refusal.json(); assert.equal(body.code, 'unsupported'); assert.match(body.remedy, /read-only/);
  }
  for (const query of ['root=other', 'source=other', 'record=true', 'item=other', 'offset=Infinity', 'limit=', 'limit=1&limit=2', 'budget=-1']) assert.equal((await authedFetch(server, viewer, `${url}?${query}`)).status, 400, query);
  assert.equal((await authedFetch(server, outsider, url)).status, 404);
  assert.equal((await authedFetch(server, viewer, `/api/projects/${other.id}/pm/evidence/${foreign.id}`)).status, 404);
  assert.equal((await fetch(server.url(url))).status, 401);
  await assert.rejects(sdk.inspect(other.id, { item: foreign.id }), error => error instanceof EvidenceInspectionError && error.code === 'not_found');
  await writeFile(path.join(host.root, 'source-0.txt'), 'before one\nnew public fragment\nafter one');
  const refreshed = await sdk.inspect(project.id, { item: host.id });
  assert.equal(refreshed.rows[0].freshness, 'changed'); assert.deepEqual(refreshed.rows[1], local.rows[1]);
  for (const [relative, expected] of [['settings.json', settings], [`history/${host.id}.jsonl`, history]] as const) assert.deepEqual(await readFile(path.join(host.workspace, relative)), expected);
  // Use the real host dispatcher and both agent formats while the HTTP server stays live.
  await installExtension(host.workspace, host.client, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  const args = [path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js'), '--pm-path', host.workspace, 'web', 'evidence', '--url', server.url('/'), '--project', project.id, '--item'];
  const childEnv = { ...process.env, PM_WEB_TOKEN: signToken({ userId: viewer.id, email: viewer.email }), GIT_CEILING_DIRECTORIES: tmpdir() };
  for (const [selected, expected] of [[host.id, refreshed], [protectedItem.id, protectedPage]] as const) {
    const json = await promisify(execFile)(process.execPath, [...args, selected, '--json'], { env: childEnv, timeout: 30000 });
    assert.deepEqual(JSON.parse(json.stdout), expected); assert.ok(!json.stdout.includes(privateMarker));
    const toon = await promisify(execFile)(process.execPath, [...args, selected], { env: childEnv, timeout: 30000 });
    assert.match(toon.stdout, /pm-web-evidence\/v1/); assert.match(toon.stdout, /truthAssessed: false/);
    assert.ok(!toon.stdout.includes(privateMarker));
    const { rows_encoding, criterionGaps_encoding, ...decoded } = decodeToon(toon.stdout) as Record<string, unknown>;
    for (const [key, encoding] of [['rows', rows_encoding], ['criterionGaps', criterionGaps_encoding]] as const) if (encoding !== undefined) decoded[key] = decodePmTableRows({ rows: decoded[key] as PmEncodedTableRows['rows'], encoding: encoding as PmTableCellEncoding });
    const validated = evidenceInspectionPageSchema.safeParse(decoded);
    assert.ok(validated.success, JSON.stringify(validated.error?.issues.map(issue => ({ path: issue.path, code: issue.code }))));
    assert.deepEqual(parseEvidenceInspectionPage(decoded), expected);
  }
  await pool.query('DELETE FROM pm_project_shares WHERE project_id=$1 AND shared_with_user_id=$2', [project.id, viewer.id]);
  await assert.rejects(sdk.inspect(project.id, { item: host.id }), error => error instanceof EvidenceInspectionError && error.code === 'not_found');
  // An empty legacy item has no evidence schema requirement and causes no schema bootstrap.
  const blank = await host.client.create({ type: 'Task', title: 'No citations', unset: ['parent', 'assignee', 'sprint', 'release', 'goal', 'objective'] });
  assert.equal((await authedFetch(server, owner, `/api/projects/${project.id}/pm/evidence/${blank.item.id}`)).status, 200);
});

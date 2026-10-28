import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { access, mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db.ts';
import { ItemHistoryError, itemHistoryLimit, normalizeItemHistory, readItemHistoryPage, type ItemHistoryPage } from '../src/services/item-history.ts';
import { authedRequest, startEphemeralServer } from './helpers/ephemeral-server.ts';
import { itemHistoryHarness } from './helpers/item-history-harness.ts';
import { runPm, EXIT_CODE } from '../src/services/pm-runner.ts';

after(() => pool.end());

test('authorized real non-git route returns chronological panel data ending in close without git on PATH', async () => {
  const h = await itemHistoryHarness();
  const previousPath = process.env.PATH;
  try {
    await assert.rejects(access(path.join(h.cwd, '.git')));
    const bin = path.join(h.root, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
    process.env.PATH = bin;
    const response = await authedRequest(h.app, 'GET', `/api/projects/${h.project}/pm/history/${h.itemId}`, h.owner);
    assert.equal(response.status, 200);
    const page = JSON.parse(response.text) as ItemHistoryPage;
    assert.equal(page.history.length, 4);
    assert.deepEqual(page.history.map(row => row.action), ['create', 'update', 'update', 'close']);
    assert.equal(page.order, 'oldest_first');
    assert.ok(page.history.every(row => row.timestamp && row.author && row.index));
    assert.equal(page.history.at(-1)?.action, 'close');
    assert.equal(page.has_more, false); assert.equal(page.next_cursor, null);
    const denied = await authedRequest(h.app, 'GET', `/api/projects/${h.project}/pm/history/${h.itemId}`, '55555555-5555-4551-8555-555555555555');
    assert.equal(denied.status, 404);
    const server = await startEphemeralServer(h.app);
    try { assert.equal((await fetch(server.url(`/api/projects/${h.project}/pm/history/${h.itemId}`))).status, 401); }
    finally { await server.close(); }
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await h.cleanup(); }
});

test('bounded route pages cover older entries without duplicates while new writes append', async () => {
  const h = await itemHistoryHarness();
  try {
    const base = `/api/projects/${h.project}/pm/history/${h.itemId}`;
    const first = JSON.parse((await authedRequest(h.app, 'GET', `${base}?limit=2`, h.owner)).text) as ItemHistoryPage;
    assert.deepEqual(first.history.map(row => row.index), [3, 4]); assert.equal(first.has_more, true); assert.ok(first.next_cursor);
    await h.client.update(h.itemId, { title: 'A later append' });
    const second = JSON.parse((await authedRequest(h.app, 'GET', `${base}?limit=2&cursor=${first.next_cursor}`, h.owner)).text) as ItemHistoryPage;
    assert.deepEqual(second.history.map(row => row.index), [1, 2]); assert.equal(second.has_more, false); assert.equal(second.next_cursor, null);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=2&limit=3', 'cursor=invalid', `cursor=${first.next_cursor}&cursor=duplicate`]) {
      const result = await authedRequest(h.app, 'GET', `${base}?${query}`, h.owner);
      assert.equal(result.status, 400, query); assert.ok(JSON.parse(result.text).remedy);
    }
    const other = await h.client.create({ type: 'Task', title: 'Different history' });
    assert.equal((await authedRequest(h.app, 'GET', `/api/projects/${h.project}/pm/history/${other.item.id}?cursor=${first.next_cursor}`, h.owner)).status, 400);
    const missing = await authedRequest(h.app, 'GET', `/api/projects/${h.project}/pm/history/demo-missing`, h.owner);
    assert.equal(missing.status, 404); assert.equal(JSON.parse(missing.text).code, 'history_not_found');
  } finally { await h.cleanup(); }
});

test('latest default response remains bounded on a longer real timeline', async () => {
  const h = await itemHistoryHarness();
  try {
    for (let index = 0; index < 52; index++) await h.client.update(h.itemId, { title: `Synthetic change ${index}` });
    const response = await authedRequest(h.app, 'GET', `/api/projects/${h.project}/pm/history/${h.itemId}`, h.owner);
    const page = JSON.parse(response.text) as ItemHistoryPage;
    assert.equal(page.history.length, 50); assert.equal(page.has_more, true); assert.ok(page.next_cursor);
    assert.ok(response.text.length < 25_000); assert.ok(!response.text.includes('patch'));
  } finally { await h.cleanup(); }
});

test('normalizer validates refusals and retains older full and compact data, including timestamp ties', async () => {
  const h = await itemHistoryHarness();
  try {
    const run = (args: string[]) => runPm({ userId: h.owner, slug: 'history-proof', args, jsonOutput: true });
    const compact = (await run(['history', h.itemId, '--compact'])).parsed as { compact_history: Record<string, unknown>[] };
    const expected = normalizeItemHistory(compact);
    assert.equal(expected.length, 4);
    const newest = { ...compact, compact_history: [...compact.compact_history].reverse(), order: 'newest_first' };
    assert.deepEqual(normalizeItemHistory(newest), expected);
    const full = (await run(['history', h.itemId, '--full'])).parsed;
    assert.deepEqual(normalizeItemHistory(full), expected);
    const tied = { ...compact, compact_history: compact.compact_history.map(row => ({ ...row, ts: '2026-10-28T00:00:00Z' })) };
    assert.deepEqual(normalizeItemHistory(tied).map(row => row.action), ['create', 'update', 'update', 'close']);
    for (const bad of [null, 5, {}, { history: [] , order: 'unknown' }, { history: [null] }, { history: [{}] }, { history: [{ ts: 'x', op: 'x', author: 5 }] }, { compact: true, compact_history: [{ ts: 'x', op: 'x', author: 'x', index: 0 }] }]) {
      assert.throws(() => normalizeItemHistory(bad), ItemHistoryError);
    }
    assert.deepEqual(normalizeItemHistory({ history: [] }), []);
    assert.equal(itemHistoryLimit(undefined), 50); assert.equal(itemHistoryLimit('100'), 100);
    for (const invalid of ['', '-1', '1e2', 'Infinity', ' 5 ', [], '0']) assert.throws(() => itemHistoryLimit(invalid), ItemHistoryError);
    const limited = await readItemHistoryPage(run, h.itemId, h.project, { limit: '2' });
    assert.ok(limited.next_cursor);
    const cursor = JSON.parse(Buffer.from(limited.next_cursor, 'base64url').toString()) as { anchor: string; before: number };
    for (const changed of [{ ...cursor, anchor: 'f'.repeat(64) }, { ...cursor, before: 100 }]) {
      await assert.rejects(readItemHistoryPage(run, h.itemId, h.project, { cursor: Buffer.from(JSON.stringify(changed)).toString('base64url') }), (error: unknown) => error instanceof ItemHistoryError && error.code === 'history_cursor_stale');
    }
    // These are transport failures, never SDK mocks: the real runner above supplies all successful history reads.
    for (const result of [{ ok: false, stdout: '', stderr: 'private detail', exitCode: EXIT_CODE.NOT_FOUND }, { ok: false, stdout: '', stderr: 'private detail' }]) {
      await assert.rejects(readItemHistoryPage(async () => result, h.itemId, h.project, {}), (error: unknown) => error instanceof ItemHistoryError && !error.message.includes('private detail') && Boolean(error.remedy));
    }
    assert.ok((await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8')).split('\n').length >= 4);
  } finally { await h.cleanup(); }
});

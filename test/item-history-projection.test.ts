import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { access, mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db.ts';
import { ItemHistoryError, itemHistoryLimit, normalizeItemHistory, readItemHistoryPage, type ItemHistoryPage } from '../src/services/item-history.ts';
import { ItemHistoryError as BuiltHistoryError, readItemHistoryPage as readBuiltHistoryPage } from '../dist/services/item-history.js';
import { authedRequest, startEphemeralServer } from './helpers/ephemeral-server.ts';
import { itemHistoryHarness } from './helpers/item-history-harness.ts';
import { runPm, EXIT_CODE } from '../src/services/pm-runner.ts';
import { signToken } from '../src/auth.ts';

after(() => pool.end());

test('production history harness blocks cookie CSRF and accepts a token bootstrapped by the real client path', async () => {
  const h = await itemHistoryHarness();
  const server = await startEphemeralServer(h.app);
  try {
    const session = `pm_token=${signToken({ userId: h.owner, email: 'history@example.test' })}`;
    const before = await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8');
    const missing = await fetch(server.url(`/api/projects/${h.project}/pm/comments/${h.itemId}`), { method: 'POST', headers: { cookie: session, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Must not be written' }) });
    assert.equal(missing.status, 403);
    assert.equal(await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8'), before);
    const bootstrap = await fetch(server.url('/api/auth/me'), { headers: { cookie: session } });
    assert.equal(bootstrap.status, 200);
    const csrfCookie = bootstrap.headers.getSetCookie().find(cookie => cookie.startsWith('csrf_token='))?.split(';')[0];
    const token = bootstrap.headers.get('x-csrf-token');
    assert.ok(csrfCookie && token); assert.equal(csrfCookie, `csrf_token=${token}`);
    const cookie = `${session}; ${csrfCookie}`;
    const refusals: Record<string, string>[] = [
      { cookie, 'x-csrf-token': 'wrong-token' },
      { cookie, 'x-csrf-token': token, 'sec-fetch-site': 'cross-site', origin: 'https://foreign.example.test' },
      { cookie, 'x-csrf-token': token, 'sec-fetch-site': 'same-site', origin: 'https://sibling.example.test' },
    ];
    for (const headers of refusals) {
      const refused = await fetch(server.url(`/api/projects/${h.project}/pm/comments/${h.itemId}`), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Must not be written' }) });
      assert.equal(refused.status, 403);
      assert.equal(await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8'), before);
    }
    const accepted = await fetch(server.url(`/api/projects/${h.project}/pm/comments/${h.itemId}`), { method: 'POST', headers: { cookie, 'x-csrf-token': token, 'content-type': 'application/json', origin: server.url('/') }, body: JSON.stringify({ text: 'Comment through production CSRF protection' }) });
    assert.equal(accepted.status, 201, await accepted.text());
    const comments = await fetch(server.url(`/api/projects/${h.project}/pm/comments/${h.itemId}`), { headers: { cookie } });
    assert.equal(comments.status, 200); assert.match(await comments.text(), /Comment through production CSRF protection/);
  } finally { await server.close(); await h.cleanup(); }
});

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
    assert.equal(page.history[1].message, 'exercise update flags');
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
    const fullRows = normalizeItemHistory(full);
    assert.deepEqual(fullRows.map(({ index, timestamp, action, author }) => ({ index, timestamp, action, author })), expected);
    assert.equal(fullRows[1].message, 'exercise update flags');
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
    let cursorReads = 0;
    const racingRun = async (args: string[]) => {
      const result = await run(args);
      if (++cursorReads === 1) {
        for (let index = 0; index < 5; index++) await h.client.update(h.itemId, { title: `Concurrent append ${index}` });
      }
      return result;
    };
    await assert.rejects(readItemHistoryPage(racingRun, h.itemId, h.project, { limit: '2', cursor: limited.next_cursor }), (error: unknown) => error instanceof ItemHistoryError && error.code === 'history_cursor_stale');
    // These are transport failures, never SDK mocks: the real runner above supplies all successful history reads.
    for (const result of [{ ok: false, stdout: '', stderr: 'private detail', exitCode: EXIT_CODE.NOT_FOUND }, { ok: false, stdout: '', stderr: 'private detail' }]) {
      await assert.rejects(readItemHistoryPage(async () => result, h.itemId, h.project, {}), (error: unknown) => error instanceof ItemHistoryError && !error.message.includes('private detail') && Boolean(error.remedy));
    }
    assert.ok((await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8')).split('\n').length >= 4);
  } finally { await h.cleanup(); }
});

test('every older page proves complete coverage despite adversarial appends between history reads', async t => {
  const h = await itemHistoryHarness();
  try {
    // Six entries, limit=2 and two inter-read appends is the original false-end case.
    await h.client.update(h.itemId, { title: 'Fifth entry' });
    await h.client.update(h.itemId, { title: 'Sixth entry' });
    const run = (args: string[]) => runPm({ userId: h.owner, slug: 'history-proof', args, jsonOutput: true });
    let schedules = 0;
    for (const readPage of [readItemHistoryPage, readBuiltHistoryPage]) {
      for (const limit of [2, 1, 3]) {
        for (const appends of [2, 1, 3, 4, 0]) {
          for (const afterRead of [1, 2]) {
            const latest = await readPage(run, h.itemId, h.project, { limit: String(limit) });
            assert.ok(latest.next_cursor);
            const before = latest.history[0].index;
            // Independent oracle: physical JSONL positions, never the paginator's output.
            const lines = (await readFile(path.join(h.pmRoot, 'history', `${h.itemId}.jsonl`), 'utf8')).trim().split('\n');
            const expected = lines.map((_, offset) => offset + 1).filter(index => index < before).slice(-limit);
            let reads = 0;
            const scheduledRun = async (args: string[]) => {
              const result = await run(args);
              if (++reads === afterRead) {
                for (let append = 0; append < appends; append++) await h.client.update(h.itemId, { title: `Schedule ${schedules}, append ${append}` });
              }
              return result;
            };
            const request = readPage(scheduledRun, h.itemId, h.project, { limit: String(limit), cursor: latest.next_cursor });
            if (afterRead === 1 && appends > 0) {
              await assert.rejects(request, (error: unknown) => (error instanceof ItemHistoryError || error instanceof BuiltHistoryError) && error.status === 409 && error.code === 'history_cursor_stale' && Boolean(error.remedy));
            } else {
              const page = await request;
              assert.deepEqual(page.history.map(row => row.index), expected);
              assert.equal(page.has_more, expected[0] > 1);
              assert.equal(Boolean(page.next_cursor), page.has_more);
            }
            assert.equal(reads, 2);
            // Restarting always permits complete, duplicate-free traversal to entry one.
            const seen: number[] = [];
            let page = await readPage(run, h.itemId, h.project, { limit: '100' });
            seen.unshift(...page.history.map(row => row.index));
            while (page.has_more) {
              page = await readPage(run, h.itemId, h.project, { limit: '100', cursor: page.next_cursor });
              seen.unshift(...page.history.map(row => row.index));
            }
            assert.deepEqual(seen, Array.from({ length: seen.at(-1)! }, (_, index) => index + 1));
            schedules++;
          }
        }
      }
    }
    t.diagnostic(`${schedules} real non-git schedules: source and packed build, 3 page sizes, 5 append counts, 2 interleavings; every successful page complete`);
  } finally { await h.cleanup(); }
});

/** Verify the real item detail and live-copy paths using the existing Playwright/ephemeral-server harness. */
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { itemHistoryHarness } from '../test/helpers/item-history-harness.ts';
import { startEphemeralServer } from '../test/helpers/ephemeral-server.ts';
import { fixtureResponse, fixtureUser } from './brand-fixtures.ts';
import { signToken } from '../src/auth.ts';
import { pool } from '../src/db.ts';
import type { AppBridge } from '../public/src/app.ts';
import type { HistoryResponse } from '../public/src/api-types.ts';

interface HistoryWindow extends Window { __app: AppBridge; __historyEmit: (data: Record<string, unknown>) => void }

const output = path.resolve(process.env.HISTORY_SCREENSHOTS || 'artifacts/item-history');
const h = await itemHistoryHarness();
await h.client.reopen(h.itemId, 'Exercise browser pagination');
for (let index = 0; index < 48; index++) await h.client.update(h.itemId, { title: `Item history verification ${index}` });
await h.client.close(h.itemId, 'Browser verification ready');
h.app.use('/api', (req, res) => {
  if (req.originalUrl === '/api/auth/me') { res.json({ user: { ...fixtureUser, id: h.owner } }); return; }
  if (req.originalUrl === '/api/projects') { res.json({ projects: [{ id: h.project, name: 'Item history verification', slug: 'history-proof', prefix: 'demo' }] }); return; }
  res.json(fixtureResponse(req.originalUrl));
});
h.app.use(express.static(path.resolve('public')));
h.app.use((_req, res) => res.sendFile(path.resolve('public/index.html')));
const server = await startEphemeralServer(h.app);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
try {
  await mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'pm_token', value: signToken({ userId: h.owner, email: 'history@example.test' }), url: server.url('/') }]);
    await context.addInitScript(() => {
      localStorage.setItem('pmLocale', 'en');
      class HistorySource extends EventTarget {
        static CLOSED = 2;
        readyState = 1;
        /** Deliver synthetic notification transport while all item and history reads use the real route. */
        constructor() { super(); (window as unknown as HistoryWindow).__historyEmit = data => this.dispatchEvent(new MessageEvent('item-updated', { data: JSON.stringify(data) })); }
        /** Match the browser event stream lifecycle without opening unrelated database listeners. */
        close(): void { this.readyState = 2; }
      }
      window.EventSource = HistorySource as unknown as typeof EventSource;
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url('/'));
    await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
    await page.locator(`#project-selector option[value="${h.project}"]`).waitFor({ state: 'attached' });
    await page.selectOption('#project-selector', h.project);
    await page.evaluate(id => (window as unknown as HistoryWindow).__app.openItemDetail(id), h.itemId);
    await page.locator('#item-detail-modal .tab').filter({ hasText: /^History$/ }).click();
    const entries = page.locator('#tab-history [data-live-entry]');
    await page.waitForFunction(() => document.querySelectorAll('#tab-history [data-live-entry]').length === 50);
    const latest = await page.request.get(server.url(`/api/projects/${h.project}/pm/history/${h.itemId}`));
    const api = await latest.json() as HistoryResponse;
    assert.equal(latest.status(), 200); assert.equal(api.order, 'oldest_first'); assert.equal(api.history.at(-1)?.action, width === 1440 ? 'close' : 'update');
    assert.equal(await entries.first().locator('p').innerText(), api.history.at(-1)?.action);
    assert.ok(await entries.first().locator('time').innerText());
    await page.getByRole('button', { name: 'Load older history', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#tab-history [data-live-entry]').length > 50);
    assert.equal(await entries.last().locator('p').innerText(), 'create');
    assert.equal(await page.locator('[data-history-older]').isHidden(), true);
    const indices = await entries.evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.liveEntry?.split(':')[1])));
    assert.equal(new Set(indices).size, indices.length); assert.deepEqual(indices, [...indices].sort((a, b) => b - a));
    // Refreshing via the shipped live-copy path must show a newly committed entry first and reset the older cursor.
    await h.client.update(h.itemId, { title: `Live history ${width}` });
    await page.evaluate(({ itemId, projectId }) => (window as unknown as HistoryWindow).__historyEmit({ itemId, projectId, userId: 'synthetic-collaborator', author: 'History reviewer', surface: 'pm-web' }), { itemId: h.itemId, projectId: h.project });
    await page.waitForFunction(() => document.querySelectorAll('#tab-history [data-live-entry]').length === 50 && document.querySelector('#tab-history [data-live-entry] p')?.textContent === 'update');
    assert.equal(await page.locator('[data-history-older]').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `item-history-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ screenshots: 2, viewports: [1440, 390], initialRows: 50, olderPages: true, newestFirst: true, liveCopyRefresh: true, duplicateRows: 0, horizontalOverflow: false }));
} finally { await browser.close(); await server.close(); await h.cleanup(); await pool.end(); }

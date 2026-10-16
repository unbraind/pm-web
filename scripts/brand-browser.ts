/** Fixture-only screenshots and browser acceptance. Set CHROMIUM_PATH to a local Chromium. */
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { fixtureResponse, fixtureItems } from './brand-fixtures.ts';
import type { AppBridge } from '../public/src/app.ts';
import { auditTextContrast } from './brand-browser-contrast.ts';

interface ReviewWindow extends Window { __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }
const app = express();
app.use('/api', (req, res) => {
  if (req.originalUrl === '/api/auth/me' && !req.headers.cookie?.includes('fixture-auth=1')) { res.status(401).json({ error: 'Sign in to continue' }); return; }
  res.json(fixtureResponse(new URL(req.originalUrl, 'http://fixture.test').pathname));
});
app.use(express.static('public'));
app.use((_req, res) => res.sendFile(path.resolve('public/index.html')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => { server.once('listening', resolve); });
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const output = process.env.BRAND_SCREENSHOTS;
assert.ok(output, 'Set BRAND_SCREENSHOTS to an external evidence directory');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
browser.on('disconnected', () => server.closeAllConnections());
const strict = process.env.BRAND_ACCEPTANCE === '1';
const report: unknown[] = [];
let screenshotCount = 0;

/** Capture a stable view and audit its responsive and keyboard affordances. */
async function capture(page: Page, name: string, width: number, theme: string, screenshot = true): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
  if (strict) {
    const contrast = await auditTextContrast(page);
    assert.deepEqual(contrast.failures, [], `${name}/${width}/${theme}: text contrast`);
    const audit = await page.evaluate(() => {
      const visible = (el: HTMLElement): boolean => el.checkVisibility() && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const scope = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter(visible).at(-1) ?? document;
      const actions = [...scope.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,canvas[tabindex],[onclick],[role="button"],[tabindex="0"]')].filter(el => visible(el) && !el.matches(':disabled,[aria-hidden="true"]'));
      actions.forEach((el, index) => { el.dataset.keyboardReview = String(index); });
      actions[0]?.focus({ preventScroll: true });
      return { overflow: document.documentElement.scrollWidth > innerWidth, unreachable: actions.filter(el => el.tabIndex < 0).map(el => el.outerHTML.slice(0, 200)), count: actions.length };
    });
    assert.equal(audit.overflow, false, `${name}/${width}/${theme}: horizontal overflow`);
    assert.deepEqual(audit.unreachable, [], `${name}: keyboard-unreachable actions`);
    // Actually traverse the tab sequence; every focused action must expose a ring.
    const visited = new Set<string>();
    for (let i = 0; i < audit.count + 2; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body) return null;
        const css = getComputedStyle(el);
        return { key: el.dataset.keyboardReview, label: el.id || el.outerHTML.slice(0, 220), ring: css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) >= 2 };
      });
      if (focused) { assert.ok(focused.ring, `${name}: missing focus ring on ${focused.label}`); if (focused.key !== undefined) visited.add(focused.key); }
    }
    assert.equal(visited.size, audit.count, `${name}: Tab did not reach every action`);
    report.push({ name, width, theme, ...audit, tabStops: visited.size, contrastPairs: contrast.pairs });
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      document.querySelectorAll<HTMLElement>('*').forEach(el => { if (el.scrollTop) el.scrollTop = 0; });
      window.scrollTo(0, 0);
    });
  }
  if (!screenshot) return;
  screenshotCount++;
  await page.screenshot({ path: path.join(output!, `${name}-${width}-${theme}.png`), timeout: 60000, animations: name === 'live-arrival' ? 'allow' : 'disabled' });
}

try {
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, serviceWorkers: 'block', reducedMotion: 'no-preference' });
    await context.addInitScript(() => {
      localStorage.setItem('pmLocale', 'en');
      // Fixed time makes relative timestamps and the calendar reproducible.
      const NativeDate = Date;
      window.Date = new Proxy(NativeDate, {
        construct(target, args) { return Reflect.construct(target, args.length ? args : ['2026-10-17T12:00:00Z']); },
        get(target, key) { return key === 'now' ? () => new NativeDate('2026-10-17T12:00:00Z').getTime() : Reflect.get(target, key); },
      });
      class FixtureSource extends EventTarget {
        static CLOSED = 2; readyState = 1;
        constructor() { super(); (window as unknown as ReviewWindow).__fixtureEmit = data => this.dispatchEvent(new MessageEvent('item-updated', { data: JSON.stringify(data) })); }
        close(): void { this.readyState = 2; }
      }
      window.EventSource = FixtureSource as unknown as typeof EventSource;
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => assert.ok(request.url().startsWith(base) || request.url().startsWith('data:'), 'Unexpected external request'));
    await page.goto(base);
    await page.locator('#auth-screen').waitFor({ state: 'visible' });
    await capture(page, 'sign-in', width, theme);
    await page.locator('#tab-register').click();
    await capture(page, 'register', width, theme);
    await context.addCookies([{ name: 'fixture-auth', value: '1', url: base }]);
    await page.reload();
    await page.locator('.project-card').waitFor();
    // Keep the cookie notice visible in the authentication evidence only.
    await page.evaluate(() => { const banner = document.getElementById('cookie-consent'); if (banner) banner.hidden = true; });
    await capture(page, 'projects', width, theme);
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.selectProject('fixture-project'));
    await page.locator('.item-row').first().waitFor();
    await capture(page, 'items', width, theme);
    const board = page.locator('[data-items-layout="board"]');
    if (await board.count()) await board.click();
    await capture(page, 'board', width, theme);
    if (await board.count()) await page.locator('[data-items-layout="list"]').click();
    for (const [index, status] of ['open', 'in-progress', 'blocked', 'closed'].entries()) {
      await page.evaluate(id => (window as unknown as ReviewWindow).__app.openItemDetail(id), `note-${index + 1}`);
      await page.locator('.item-detail-title').waitFor();
      await capture(page, `detail-${status}`, width, theme);
      await page.evaluate(() => (window as unknown as ReviewWindow).__app.hideModal('item-detail-modal'));
    }
    for (const view of ['create', 'graph', 'calendar', 'packages', 'settings', 'sharing', 'admin']) {
      await page.evaluate(view => (window as unknown as ReviewWindow).__app.showView(view), view);
      await page.waitForTimeout(view === 'graph' ? 1200 : 220);
      await capture(page, view, width, theme);
      if (strict && view === 'create') {
        await page.locator('#content-create summary').focus();
        await page.keyboard.press('Enter');
        await capture(page, 'create-advanced', width, theme, false);
      }
    }
    await page.goto(`${base}/privacy-policy.html`);
    await capture(page, 'legal', width, theme);
    await page.goto(base);
    await page.locator('.project-card').waitFor();
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.selectProject('fixture-project'));
    await page.locator('.item-row').first().waitFor();
    fixtureItems[0].title = 'Make the shared next step clear';
    await page.evaluate(() => (window as unknown as ReviewWindow).__fixtureEmit({ itemId: 'note-1', userId: 'fixture-reviewer', author: 'Alex' }));
    await page.waitForTimeout(220);
    await capture(page, 'live-arrival', width, theme);
    console.log(`Captured ${width}/${theme}`);
    fixtureItems[0].title = 'Make the next step clear';
    if (strict) assert.deepEqual(errors, [], 'Browser errors');
    await context.close();
  }
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(`Captured ${screenshotCount} fixture screenshots; ${report.length} browser audits`);
} finally { await browser.close(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }

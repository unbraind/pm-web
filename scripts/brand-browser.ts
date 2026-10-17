/** Fixture-only screenshots and browser acceptance. Set CHROMIUM_PATH to a local Chromium. */
import assert from 'node:assert/strict';
import express from 'express';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { fixtureResponse, fixtureItems, fixtureUser, fixtureComments, fixtureHistory, fixturePatches } from './brand-fixtures.ts';
import type { AppBridge } from '../public/src/app.ts';
import { holdArrivalFrame, checkLiveArrivals } from './brand-browser-live.ts';
import { auditTextContrast } from './brand-browser-contrast.ts';

interface ReviewWindow extends Window { __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }
const app = express();
// Freeze built assets so another acceptance build cannot replace in-flight modules.
const staticRoot = await mkdtemp(path.join(tmpdir(), 'pm-web-brand-browser-'));
await cp(path.resolve('public'), staticRoot, { recursive: true });
app.use(express.json());
app.use('/api', (req, res) => {
  if (req.originalUrl === '/api/auth/me' && !req.headers.cookie?.includes('fixture-auth=1')) { res.status(401).json({ error: 'Sign in to continue' }); return; }
  const pathname = new URL(req.originalUrl, 'http://fixture.test').pathname;
  if (req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(pathname)) { res.cookie('fixture-auth', '1').json({ user: fixtureUser }); return; }
  if (pathname === '/api/auth/logout') { res.clearCookie('fixture-auth').json({ ok: true }); return; }
  if (req.method === 'PATCH' && pathname.includes('/pm/update/')) {
    const patch = req.body as Record<string, unknown>;
    fixturePatches.push(patch);
    const item = fixtureItems.find(item => item.id === pathname.split('/').at(-1));
    if (item) Object.assign(item, patch);
    res.json({ item }); return;
  }
  res.json(fixtureResponse(pathname));
});
app.use(express.static(staticRoot));
app.use((_req, res) => res.sendFile(path.join(staticRoot, 'index.html')));
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
const widths = process.env.BRAND_QUICK ? [1440] : process.env.BRAND_WIDTHS ? process.env.BRAND_WIDTHS.split(',').map(Number) : [1440, 768, 390];
assert.ok(widths.length && widths.every(width => [1440, 768, 390].includes(width)), 'Use review widths 1440, 768 or 390');
const originalItems = structuredClone(fixtureItems);
const originalComments = structuredClone(fixtureComments);
const originalHistory = structuredClone(fixtureHistory);

/** Submit the synthetic account credentials through the keyboard. */
async function submitFixtureCredentials(page: Page): Promise<void> {
  await page.locator('#auth-email').fill('editor@example.test');
  await page.locator('#auth-password').fill('fixture-passphrase-only');
  await page.locator('#auth-submit').focus();
  await page.keyboard.press('Enter');
}

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
      return { overflow: document.documentElement.scrollWidth > innerWidth, unreachable: actions.filter(el => el.tabIndex < 0).map(el => el.outerHTML.slice(0, 200)), count: actions.length, primaries: [...scope.querySelectorAll<HTMLElement>('.btn-primary')].filter(visible).length, cookieCoversForm: (() => { const form = document.querySelector<HTMLElement>('.auth-right'); const notice = document.getElementById('cookie-consent'); if (!form || !notice || !visible(form) || !visible(notice)) return false; const a = form.getBoundingClientRect(), b = notice.getBoundingClientRect(); return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; })() };
    });
    assert.equal(audit.overflow, false, `${name}/${width}/${theme}: horizontal overflow`);
    assert.deepEqual(audit.unreachable, [], `${name}: keyboard-unreachable actions`);
    assert.equal(audit.cookieCoversForm, false, `${name}: cookie notice covers the form`);
    assert.ok(audit.primaries <= 1, `${name}: competing primary actions`);
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
    console.log(`Audited ${name}/${width}/${theme}: ${visited.size} actions, ${contrast.pairs} text pairs`);
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
  for (const width of widths) for (const theme of (process.env.BRAND_QUICK ? ['light'] : ['light', 'dark']) as ('light' | 'dark')[]) {
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
    page.on('pageerror', error => { errors.push(error.message); console.error(`Browser error: ${error.message}`); });
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('401')) console.error(`Browser console: ${message.text()}`); });
    page.on('request', request => assert.ok(request.url().startsWith(base) || request.url().startsWith('data:'), 'Unexpected external request'));
    await page.goto(base);
    await page.locator('#auth-screen').waitFor({ state: 'visible' });
    await capture(page, 'sign-in', width, theme);
    await page.locator('#tab-register').focus();
    await page.keyboard.press('Enter');
    await capture(page, 'register', width, theme);
    if (strict) {
      await page.locator('#auth-name').fill('Morgan');
      await submitFixtureCredentials(page);
      await page.locator('.project-card').waitFor();
      await page.locator('#user-avatar').focus();
      await page.keyboard.press('Enter');
      await capture(page, 'account-actions', width, theme, false);
      await page.locator('#mobile-command-sheet .modal-footer button').focus();
      await page.keyboard.press('Enter');
      await page.locator('#auth-screen').waitFor({ state: 'visible' });
      await page.locator('#tab-login').focus();
      await page.keyboard.press('Enter');
      await submitFixtureCredentials(page);
    } else {
      await context.addCookies([{ name: 'fixture-auth', value: '1', url: base }]);
      await page.reload();
    }
    await page.locator('.project-card').waitFor();
    // Keep the cookie notice visible in the authentication evidence only.
    await page.evaluate(() => { const banner = document.getElementById('cookie-consent'); if (banner) banner.hidden = true; });
    await capture(page, 'projects', width, theme);
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.selectProject('fixture-project'));
    await page.locator('.item-row').first().waitFor();
    await capture(page, 'items', width, theme);
    if (strict) {
      await page.locator('#user-avatar').focus();
      await page.keyboard.press('Enter');
      await capture(page, 'project-actions', width, theme, false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#user-avatar').evaluate(el => document.activeElement === el), true, 'Dialog did not return keyboard focus');
    }
    const board = page.locator('[data-items-layout="board"]');
    if (await board.count()) await board.click();
    await capture(page, 'board', width, theme);
    if (await board.count()) await page.locator('[data-items-layout="list"]').click();
    for (const [index, status] of ['open', 'in-progress', 'blocked', 'closed'].entries()) {
      await page.evaluate(id => (window as unknown as ReviewWindow).__app.openItemDetail(id), `note-${index + 1}`);
      await page.locator('.item-detail-title').waitFor();
      await capture(page, `detail-${status}`, width, theme);
      if (strict && status === 'open') {
        for (const tab of ['Update', 'Notes', 'Deps', 'Graph', 'Learnings', 'Tests', 'Files', 'History', 'Close']) {
          await page.locator('#item-detail-modal .tab').filter({ hasText: new RegExp(`^(?:◎ )?${tab}(?: \\(|$)`) }).focus();
          await page.keyboard.press('Enter');
          await capture(page, `detail-tab-${tab.toLowerCase()}`, width, theme, false);
        }
      }
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
      if (strict && view === 'admin') {
        for (const tab of ['projects', 'groups', 'audit']) {
          await page.locator(`[onclick="window.__app.adminSwitchTab('${tab}')"]`).focus();
          await page.keyboard.press('Enter');
          await capture(page, `admin-${tab}`, width, theme, false);
        }
      }
    }
    if (strict) for (const view of ['activity', 'search', 'stats', 'context', 'groups', 'health', 'dedupe', 'validate', 'github', 'export', 'normalize', 'shared', 'templates', 'comments-audit', 'config', 'guide', 'plan']) {
      await page.evaluate(view => (window as unknown as ReviewWindow).__app.showView(view), view);
      await page.waitForTimeout(250);
      await capture(page, view, width, theme, false);
    }
    await page.goto(`${base}/privacy-policy.html`);
    await capture(page, 'legal', width, theme);
    await page.goto(base);
    await page.locator('.project-card').waitFor();
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.selectProject('fixture-project'));
    await page.locator('.item-row').first().waitFor();
    if (strict) await holdArrivalFrame(page);
    else {
      fixtureItems[0].title = 'Make the shared next step clear';
      await page.evaluate(() => (window as unknown as ReviewWindow).__fixtureEmit({ itemId: 'note-1', userId: 'fixture-reviewer', author: 'Alex' }));
      await page.waitForTimeout(220);
    }
    await capture(page, 'live-arrival', width, theme);
    if (strict) report.push({ width, theme, liveCases: await checkLiveArrivals(page) });
    console.log(`Captured ${width}/${theme}`);
    fixtureItems.splice(0, fixtureItems.length, ...structuredClone(originalItems));
    fixtureComments.splice(0, fixtureComments.length, ...structuredClone(originalComments));
    fixtureHistory.splice(0, fixtureHistory.length, ...structuredClone(originalHistory));
    if (strict) assert.deepEqual(errors, [], 'Browser errors');
    await context.close();
  }
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  const views = report.filter(record => 'name' in (record as Record<string, unknown>)).length;
  console.log(`Captured ${screenshotCount} fixture screenshots; ${views} keyboard/contrast audits; ${report.length - views} live scenario groups`);
} finally { await browser.close(); await new Promise<void>(resolve => { server.close(() => resolve()); }); await rm(staticRoot, { recursive: true, force: true }); }

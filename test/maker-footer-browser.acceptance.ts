/** Check the shipped maker footer with the browser's HTML parser, layout engine and cache keys. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

let browser: Browser | undefined;
let server: Server | undefined;
let origin = '';

before(async () => {
  const app = express();
  // Model a browser retaining the previous URL's stylesheet after deployment.
  app.get('/styles.css', (request, response, next) => {
    if (request.query.v !== '21') return next();
    response.set('Cache-Control', 'public, max-age=3600').type('css').send('/* Previous stylesheet without maker footer rules. */');
  });
  app.use(express.static('public'));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => { server?.close(() => resolve()); });
  }
});

/** Inspect native DOM ancestry, independently of closing-tag text in the source. */
async function assertCommonFooter(page: Page): Promise<void> {
  const ancestry = await page.locator('.app-footer').evaluate(footer => ({
    parent: footer.parentElement?.id,
    authentication: footer.closest('#auth-screen') !== null,
    application: footer.closest('#main-app') !== null,
  }));
  assert.deepEqual(ancestry, { parent: 'app', authentication: false, application: false });
}

test('native HTML parsing keeps the footer outside both screens and rejects a nested lookalike', async () => {
  assert.ok(browser);
  const page = await browser.newPage({ javaScriptEnabled: false, serviceWorkers: 'block' });
  try {
    await page.goto(origin);
    await assertCommonFooter(page);
    const html = await readFile('public/index.html', 'utf8');
    const footer = /<footer class="app-footer">[\s\S]*?<\/footer>/.exec(html)?.[0];
    assert.ok(footer);
    const misplaced = html.replace(footer, '').replace('<div id="app-body">', `<div id="app-body"><div><div></div></div>${footer}`);
    assert.match(misplaced, /<\/div>\s*<\/div>\s*<footer class="app-footer">/, 'the old text assertion would admit this wrong ancestry');
    await page.setContent(misplaced);
    await assert.rejects(assertCommonFooter(page), { name: 'AssertionError' });
  } finally { await page.close(); }
});

test('the application footer is visible at initial scroll position in phone, landscape and desktop layouts', async () => {
  assert.ok(browser);
  for (const [width, height] of [[375, 812], [812, 375], [1280, 800]]) {
    const page = await browser.newPage({ viewport: { width, height }, javaScriptEnabled: false, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      await page.goto(origin);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(async theme => {
          document.documentElement.dataset.theme = theme;
          document.querySelector<HTMLElement>('#auth-screen')!.style.display = 'none';
          document.querySelector<HTMLElement>('#main-app')!.style.display = 'flex';
          window.scrollTo(0, 0);
          await document.fonts.ready;
        }, theme);
        const layout = await page.locator('.app-footer').evaluate(footer => {
          const box = footer.getBoundingClientRect();
          return {
            visible: box.top >= 0 && box.bottom <= innerHeight + 1,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            links: [...footer.querySelectorAll('a')].map(link => {
              const rect = link.getBoundingClientRect();
              return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === link;
            }),
          };
        });
        assert.deepEqual(layout, { visible: true, horizontalOverflow: false, links: [true, true] }, `${width}x${height} ${theme}`);
      }
    } finally { await page.close(); }
  }
});

test('first-time authentication grows past a short landscape viewport without overlapping the notice or footer', async () => {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 740, height: 360 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  try {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: path === '/api/auth/me' ? 401 : 200,
        contentType: 'application/json',
        body: JSON.stringify(path === '/api/ui-config' ? { storageNotice: true } : { enabled: false }),
      });
    });
    await page.goto(origin);
    await page.locator('#auth-screen').waitFor({ state: 'visible' });
    await page.locator('#cookie-consent').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => localStorage.getItem('pm_cookie_preferences_v1')), null);
    for (const tab of ['login', 'register']) {
      await page.locator(`#tab-${tab}`).click();
      await page.evaluate(async () => { await document.fonts.ready; });
      const layout = await page.evaluate(() => {
        const form = document.querySelector('#auth-form')!.getBoundingClientRect();
        const auth = document.querySelector('#auth-screen')!.getBoundingClientRect();
        const footer = document.querySelector('.app-footer')!.getBoundingClientRect();
        const notice = document.querySelector('#cookie-consent')!.getBoundingClientRect();
        return { formBottom: form.bottom, authBottom: auth.bottom, footerTop: footer.top, footerBottom: footer.bottom, noticeTop: notice.top };
      });
      assert.ok(layout.formBottom <= layout.noticeTop, `${tab}: auth form must end before the cookie notice`);
      assert.ok(layout.authBottom <= layout.footerTop, `${tab}: footer must follow the auth screen`);
      assert.ok(layout.footerBottom <= layout.noticeTop, `${tab}: cookie notice must follow the footer`);
      for (const link of await page.locator('.app-footer a').all()) {
        await link.scrollIntoViewIfNeeded();
        assert.equal(await link.evaluate(element => {
          const box = element.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
        }), true, `${tab}: maker link remains reachable by scrolling`);
      }
    }
  } finally { await page.close(); }
});

test('updated HTML and worker precache share a fresh stylesheet key despite a cached previous version', async () => {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, javaScriptEnabled: false, serviceWorkers: 'block' });
  try {
    await page.goto(`${origin}/styles.css?v=21`);
    await page.goto(origin);
    const stylesheet = await page.locator('link[rel="stylesheet"][href^="/styles.css"]').getAttribute('href');
    assert.equal(stylesheet, '/styles.css?v=22');
    const workerResponse = await page.request.get(`${origin}/sw.js`);
    assert.equal(workerResponse.status(), 200);
    const worker = await workerResponse.text();
    const assets = /STATIC_ASSETS[^=]*=\s*\[([\s\S]*?)\]/.exec(worker)?.[1];
    assert.ok(assets?.includes(`'${stylesheet}'`), 'offline precache uses the same versioned request key');
    const cacheBehavior = await page.locator('.app-footer').evaluate(async (footer, stylesheet) => {
      const cache = await caches.open('maker-footer-previous-styles');
      await cache.put(new URL('/styles.css?v=21', location.href), new Response('previous styles'));
      const previous = await cache.match(new URL(stylesheet, location.href));
      return { previousKeyMatches: previous !== undefined, footerSpacing: parseFloat(getComputedStyle(footer).paddingBottom) > 0 };
    }, stylesheet);
    assert.deepEqual(cacheBehavior, { previousKeyMatches: false, footerSpacing: true });
  } finally { await page.close(); }
});

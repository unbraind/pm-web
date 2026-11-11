/** Exercise the shipped panel in desktop/mobile browsers against genuine SDK sources and project ACLs. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { evidenceTracker } from '../test/helpers/evidence-tracker.ts';
import { authenticatedBrowserPage } from '../test/helpers/browser-page.ts';
import { ensureSchema, seedUser, seedUserShare, seedProject, startApp } from '../test/helpers/pg-harness.ts';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import type { AppBridge } from '../public/src/app.ts';

await ensureSchema();
const root = await mkdtemp(path.join(tmpdir(), 'evidence-browser-')), previous = process.env.PROJECTS_ROOT;
process.env.PROJECTS_ROOT = root;
const owner = await seedUser(), viewer = await seedUser(), project = await seedProject(owner.id);
await seedUserShare(project.id, viewer.id, 'view');
const host = await evidenceTracker(path.join(root, owner.id, project.slug));
const server = await startApp(), browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  for (const width of [1440, 390]) {
    await writeFile(path.join(host.root, 'source-0.txt'), host.texts[0]);
    const session = await browser.newContext({ viewport: { width, height: 1100 }, serviceWorkers: 'block' });
    const page = await authenticatedBrowserPage(session, server.url('/'), signToken({ userId: viewer.id, email: viewer.email }));
    await page.locator(`#project-selector option[value="${project.id}"]`).waitFor({ state: 'attached' });
    await page.selectOption('#project-selector', project.id);
    await page.evaluate(id => (window as unknown as { __app: AppBridge }).__app.openItemDetail(id), host.id);
    const panel = page.locator('[data-evidence-panel]'); await panel.locator('summary').click();
    await panel.locator('.evidence-row').first().getByText('current', { exact: true }).waitFor();
    const unaffected = await panel.locator('.evidence-row').nth(1).textContent();
    await writeFile(path.join(host.root, 'source-0.txt'), 'before one\nchanged browser source\nafter one');
    await panel.getByRole('button', { name: 'Refresh evidence' }).click();
    await panel.getByText('changed browser source', { exact: true }).waitFor();
    assert.equal(await panel.locator('.evidence-row').nth(1).textContent(), unaffected);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const shot = process.env.EVIDENCE_SCREENSHOTS;
    if (shot) { await panel.locator('.evidence-row').first().scrollIntoViewIfNeeded(); await mkdir(shot, { recursive: true }); await page.screenshot({ path: path.join(shot, `evidence-${width}.png`), fullPage: true }); }
    await page.route('**/pm/evidence/**', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Access changed', remedy: 'Refresh project access.' }) }));
    await panel.getByRole('button', { name: 'Refresh evidence' }).click();
    await panel.getByText('Access changed', { exact: true }).waitFor();
    assert.equal(await panel.locator('.evidence-row').count(), 0);
    await session.close();
  }
  console.log(JSON.stringify({ viewports: [1440, 390], sourceEditAffectedRows: 1, unaffectedRows: 1, staleRowsAfterRefusal: 0, horizontalOverflow: false }));
} finally {
  await server.close(); await browser.close();
  try { await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id]]); }
  finally {
    await rm(root, { recursive: true, force: true });
    if (previous !== undefined) process.env.PROJECTS_ROOT = previous; else Reflect.deleteProperty(process.env, 'PROJECTS_ROOT');
  }
}

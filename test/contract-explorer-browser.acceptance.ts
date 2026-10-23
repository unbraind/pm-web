/** Browser evidence against genuine project permissions and SDK contract routes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import { ensureSchema, seedUser, seedProject, startApp } from './helpers/pg-harness.ts';
import type { AppBridge } from '../public/src/app.ts';

test('desktop and mobile review forms never dispatch destructive operations and disable on availability failure', async t => {
  await ensureSchema(); const output = process.env.CONTRACT_SCREENSHOTS; assert.ok(output);
  const root = await mkdtemp(path.join(os.tmpdir(), 'contract-browser-')); process.env.PROJECTS_ROOT = root;
  const owner = await seedUser(), project = await seedProject(owner.id), cwd = path.join(root, owner.id, project.slug);
  const { client: pm } = await createPlainContractTracker(cwd);
  const { item } = await pm.create({ type: 'Task', title: 'Keep this item', description: 'Synthetic browser fixture.' });
  const server = await startApp(), browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await server.close(); await pool.query('DELETE FROM pm_users WHERE id=$1', [owner.id]); await rm(root, { recursive: true, force: true }); });
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 1000 }]) {
    const session = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await session.addCookies([{ name: 'pm_token', value: signToken({ userId: owner.id, email: owner.email }), url: server.url('/') }]);
    const page = await session.newPage(); await page.goto(server.url('/'));
    await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
    await page.locator(`#project-selector option[value="${project.id}"]`).waitFor({ state: 'attached' });
    await page.selectOption('#project-selector', project.id);
    await page.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('contract-explorer'));
    const scope = page.locator('#content-contract-explorer');
    await scope.locator('table').waitFor();
    const deletion = scope.locator('[data-contract-action="delete"]');
    while (!(await deletion.count())) { await scope.getByRole('button', { name: 'Next operations' }).click(); await scope.locator('table').waitFor(); }
    await deletion.click(); await scope.getByRole('button', { name: 'Preview inputs' }).waitFor();
    await scope.getByRole('textbox', { name: 'Input JSON' }).fill(JSON.stringify({ id: item.id }));
    await scope.getByRole('button', { name: 'Preview inputs' }).click();
    await scope.locator('[data-contract-result]').filter({ hasText: '"executed": false' }).waitFor();
    assert.equal((await pm.get(item.id)).item.id, item.id);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `contract-explorer-${viewport.width}.png`), fullPage: true });
    await page.route('**/pm/contracts?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'unavailable', remedy: 'Check provider connectivity and refresh capabilities.' }) }));
    await scope.getByRole('button', { name: 'Refresh capabilities' }).click();
    await scope.getByText('unavailable: Check provider connectivity and refresh capabilities.', { exact: true }).waitFor();
    assert.equal(await scope.locator('[data-contract-action]').count(), 0); assert.equal(await scope.locator('form').count(), 0);
    await session.close();
  }
  console.log(JSON.stringify({ screenshots: 2, viewports: [1440, 390], previewExecuted: false, unavailableControls: 0, horizontalOverflow: false }));
});

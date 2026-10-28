import { authenticatedBrowserPage } from '../test/helpers/browser-page.ts';
/** Exercise removal preview, cancellation and access invalidation in the shipped desktop/mobile UI. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Route } from 'playwright-core';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import { createPlainContractTracker } from '../test/helpers/plain-contract-tracker.ts';
import { ensureSchema, seedProject, seedUser, seedUserShare, startApp } from '../test/helpers/pg-harness.ts';
import { PermissionImpactClient } from '../src/permission-impact-client.ts';
import type { AppBridge } from '../public/src/app.ts';
import { requestDecision } from '../src/services/decision-inbox.ts';

await ensureSchema();
const previous = process.env.PROJECTS_ROOT, root = await mkdtemp(path.join(os.tmpdir(), 'permission-browser-'));
process.env.PROJECTS_ROOT = root;
const owner = await seedUser(), viewer = await seedUser(), project = await seedProject(owner.id);
const share = await seedUserShare(project.id, viewer.id, 'edit');
const { client: pm, pmRoot } = await createPlainContractTracker(path.join(root, owner.id, project.slug));
const plan = await pm.create({ type: 'Plan', title: 'Browser choice', unset: ['parent', 'goal', 'objective', 'sprint', 'release'] });
await requestDecision(pmRoot, { author: owner.id, permission: 'edit' }, { planId: plan.item.id, question: 'Choose a browser strategy', alternatives: ['A', 'B'], evidence: 'Synthetic browser evidence.' });
const server = await startApp();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
const token = (user: typeof owner) => signToken({ userId: user.id, email: user.email });
const sdk = new PermissionImpactClient(server.url('/'), token(owner));
/** Open the selected project through real navigation, accepting only necessary browser storage. */
async function openPermissionView(session: BrowserContext, user: typeof owner, view: 'sharing' | 'decision-inbox') {
  const page = await authenticatedBrowserPage(session, server.url('/'), token(user));
  await page.waitForFunction(id => Array.from(document.querySelector<HTMLSelectElement>('#project-selector')?.options ?? []).some(option => option.value === id), project.id);
  await page.selectOption('#project-selector', project.id);
  await page.evaluate(selected => (window as unknown as { __app: AppBridge }).__app.showView(selected), view);
  return page;
}
try {
  for (const width of [1440, 390]) {
    const session = await browser.newContext({ viewport: { width, height: 1200 }, serviceWorkers: 'block' });
    const page = await openPermissionView(session, owner, 'sharing');
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const preview = await sdk.preview(project.id, { shareId: share, permission: 'none' });
    await page.getByText(`${preview.counts.packets} visible context packets, ${preview.counts.decisions} pending decisions and ${preview.counts.operations} known backend operations would lose access.`, { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await pool.query('SELECT permission FROM pm_project_shares WHERE id=$1', [share])).rows[0].permission, 'edit');
    await session.close();
  }
  const session = await browser.newContext({ serviceWorkers: 'block' });
  const page = await openPermissionView(session, viewer, 'decision-inbox');
  await page.getByText('Choose a browser strategy', { exact: true }).waitFor();
  await page.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('contract-explorer'));
  await page.locator('[data-contract-action]').first().waitFor();
  await page.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('decision-inbox'));
  await page.getByText('Choose a browser strategy', { exact: true }).waitFor();
  const response = await fetch(server.url(`/api/projects/${project.id}/shares`), { method: 'POST', headers: { Authorization: `Bearer ${token(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: viewer.email, permission: 'view' }) });
  assert.equal(response.status, 201);
  await page.getByText('Project access changed. Refresh decisions to recheck access.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve alternative' }).count(), 0);
  assert.equal(await page.locator('#content-contract-explorer [data-contract-action]').count(), 0);
  const projectUrl = server.url(`/api/projects/${project.id}`);
  let first = true;
  const captured = new Promise<Route>(resolve => {
    void page.route(projectUrl, async route => {
      if (first) { first = false; resolve(route); return; }
      const headers = route.request().headers(); delete headers['if-none-match'];
      await route.continue({ headers });
    });
  });
  /** Commit independent role transitions while deliberately reordering the browser's permission reads. */
  async function changeRole(permission: 'edit' | 'view'): Promise<void> {
    const changed = await fetch(server.url(`/api/projects/${project.id}/shares`), { method: 'POST', headers: { Authorization: `Bearer ${token(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: viewer.email, permission }) });
    assert.equal(changed.status, 201);
  }
  await changeRole('edit');
  const delayed = await captured;
  const freshRead = page.waitForResponse(result => result.url() === projectUrl);
  await changeRole('view');
  assert.equal((await (await freshRead).json()).project.permission, 'view');
  const oldRead = page.waitForResponse(result => result.url() === projectUrl);
  await delayed.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project: { permission: 'edit' } }) });
  await (await oldRead).finished();
  await page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
  await page.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('decision-inbox'));
  await page.getByText('Choose a browser strategy', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve alternative' }).isDisabled(), true);
  await session.close();
  console.log(JSON.stringify({ viewports: [1440, 390], cancellationPreservesShare: true, previewMatchesSdk: true, staleDecisionControlsCleared: true, staleOperationControlsCleared: true, latePermissionReadFenced: true }));
} finally {
  await browser.close(); await server.close();
  await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner.id, viewer.id]]);
  await rm(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previous;
}

/** Capture seeded local before/after screens and exercise editor/viewer browser behavior on real HTTP. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { build } from 'esbuild';
import type { AppBridge } from '../public/src/app.ts';
import { chromium, type Page } from 'playwright-core';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { createApp } from '../src/app.ts';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import { broadcastProjectEvent } from '../src/services/sse.ts';
import { requestDecision } from '../src/services/decision-inbox.ts';
import { startEphemeralServer } from '../test/helpers/ephemeral-server.ts';


/** Open a view through the same application router used by desktop and mobile navigation. */
async function openView(page: Page, view: 'plan' | 'decision-inbox'): Promise<void> {
  await page.evaluate(selected => (window as unknown as { __app: AppBridge }).__app.showView(selected), view);
}

/** Select the seeded workspace through the shipped project selector on either local server. */
async function selectWorkspace(page: Page, url: string, project: string): Promise<void> {
  page.on('pageerror', error => { console.error('Browser error:', error.message); });
  await page.goto(url);

  await page.waitForSelector('#project-selector option[value="' + project + '"]', { state: 'attached' });
  await page.selectOption('#project-selector', project);
}

/** Assert the live status stays separate from interactive results in every load state. */
async function assertInboxStatus(page: Page, message: string, busy = false): Promise<void> {
  const status = page.locator('[data-inbox-status]');
  await page.getByText(message, { exact: true }).waitFor();
  assert.equal(await status.count(), 1, 'loading and count feedback need a separate live status');
  assert.equal(await status.textContent(), message);
  assert.equal(await status.getAttribute('role'), 'status');
  assert.equal(await status.locator('input, textarea, button, form').count(), 0);
  const results = page.locator('[data-inbox-results]');
  assert.equal(await results.getAttribute('aria-busy'), String(busy));
  assert.equal(await results.evaluate(el => el.closest('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])') !== null), false);
  assert.equal(await results.locator('form').evaluateAll(forms => forms.some(form => form.closest('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])') !== null)), false);
}

const output = process.env.INBOX_SCREENSHOTS;
assert.ok(output, 'Set INBOX_SCREENSHOTS to an external evidence directory.');
const root = await mkdtemp(path.join(os.tmpdir(), 'decision-browser-'));
const projects = path.join(root, 'projects');
process.env.PROJECTS_ROOT = projects;
const baseline = path.join(root, 'baseline');
await mkdir(baseline);
await symlink(path.resolve('node_modules'), path.join(baseline, 'node_modules'), 'junction');
const archive = execFileSync('git', ['archive', process.env.INBOX_BASE_REF ?? 'origin/main', 'public'], { maxBuffer: 64 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', baseline], { input: archive });
await cp('public/brand', path.join(baseline, 'public/brand'), { recursive: true });
execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.join(baseline, 'public/tsconfig.json')], { stdio: 'pipe' });
execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.join(baseline, 'public/tsconfig.scripts.json')], { stdio: 'pipe' });
await build({ entryPoints: [path.join(baseline, 'public/src/brand.ts')], outfile: path.join(baseline, 'public/src/brand.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
const users: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let before: Awaited<ReturnType<typeof startEphemeralServer>> | undefined;
let after: Awaited<ReturnType<typeof startEphemeralServer>> | undefined;
try {
  const owner = (await pool.query<{ id: string }>("INSERT INTO pm_users(email,password_hash,display_name) VALUES ($1,'x','Fixture editor') RETURNING id", [`editor-${randomUUID()}@example.test`])).rows[0].id;
  const viewer = (await pool.query<{ id: string }>("INSERT INTO pm_users(email,password_hash,display_name) VALUES ($1,'x','Fixture viewer') RETURNING id", [`viewer-${randomUUID()}@example.test`])).rows[0].id;
  users.push(owner, viewer);
  const slug = `decisions-${randomUUID()}`;
  const project = (await pool.query<{ id: string }>("INSERT INTO pm_projects(user_id,name,slug,prefix) VALUES ($1,'Delivery planning',$2,'demo') RETURNING id", [owner, slug])).rows[0].id;
  await pool.query("INSERT INTO pm_project_shares(project_id,shared_with_user_id,permission) VALUES($1,$2,'view')", [project, viewer]);
  const cwd = path.join(projects, owner, slug); await mkdir(cwd, { recursive: true });
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const client = new PmClient({ pmRoot, cwd, noExtensions: true, author: 'fixture-agent' });
  await client.init('demo', { defaults: true, agentGuidance: 'skip' });
  const plan = await client.planCreate({ title: 'Choose shared storage', step: ['Compare measured alternatives', 'Implement selected strategy', 'Obtain independent code review'] });
  await requestDecision(pmRoot, { author: 'fixture-agent', permission: 'edit' }, { planId: plan.plan.id, question: 'Where should collaborators store project state?', alternatives: ['Keep local files — simple setup, one machine', 'Use a shared database — coordinated access across clients'], evidence: 'Synthetic validation: both options preserve audit history. The shared database supports concurrent remote clients; local files avoid a service dependency.\nEvidence: docs/storage-comparison.md and the isolated concurrency test.' });
  const oldApp = express(); oldApp.use(express.static(path.join(baseline, 'public'))); oldApp.use(createApp());
  before = await startEphemeralServer(oldApp);
  after = await startEphemeralServer(createApp());
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  await mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1080 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'pm_token', value: signToken({ userId: owner, email: 'editor@example.test' }), url: after.url('/') }]);
    const page = await context.newPage();
    // Cookies apply to the loopback host across the two ephemeral ports.
    await selectWorkspace(page, before.url('/'), project);
    await openView(page, 'plan');
    await page.locator('#content-plan').getByText('Choose shared storage', { exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, `before-${width}.png`), fullPage: true });
    await selectWorkspace(page, after.url('/'), project);
    await openView(page, 'decision-inbox');
    await page.getByText('Where should collaborators store project state?', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `after-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'inbox must fit a narrow viewport');
    await context.close();
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies([{ name: 'pm_token', value: signToken({ userId: viewer, email: 'viewer@example.test' }), url: after.url('/') }]);
  const page = await context.newPage(); await selectWorkspace(page, after.url('/'), project); await openView(page, 'decision-inbox');
  await page.getByText('View-only access.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve alternative' }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'view-only.png'), fullPage: true });
  await context.close();
  const editorContext = await browser.newContext({ serviceWorkers: 'block' });
  await editorContext.addCookies([{ name: 'pm_token', value: signToken({ userId: owner, email: 'editor@example.test' }), url: after.url('/') }]);
  const editorPage = await editorContext.newPage();
  // Create and select through shipped UI state without reloading the project list.
  await editorPage.goto(after.url('/'));
  await editorPage.locator('#project-selector option[value="' + project + '"]').waitFor({ state: 'attached' });
  await editorPage.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('projects'));
  await editorPage.getByRole('button', { name: '+ New project', exact: true }).click();
  const newName = `Owner capability ${randomUUID()}`;
  // Prepare genuine package state so project creation does not download a graph dependency.
  const freshCwd = path.join(projects, owner, newName.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const freshRoot = path.join(freshCwd, '.agents', 'pm');
  await mkdir(freshCwd, { recursive: true });
  const freshClient = new PmClient({ pmRoot: freshRoot, cwd: freshCwd, noExtensions: true, author: 'fixture-agent' });
  await freshClient.init('owner', { defaults: true, agentGuidance: 'skip' });
  await mkdir(path.join(freshRoot, 'extensions'), { recursive: true });
  const graphCopy = path.join(freshRoot, 'extensions', 'pm-graph');
  await cp(path.resolve('node_modules/pm-graph'), graphCopy, { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
  await symlink(path.resolve('node_modules'), path.join(graphCopy, 'node_modules'), 'junction');
  await freshClient.packageActivate('pm-graph', { project: true });
  await editorPage.locator('#cp-name').fill(newName);
  await editorPage.locator('#cp-prefix').fill('owner');
  const createdResponse = editorPage.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await editorPage.getByRole('button', { name: 'Create project', exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const freshProject = (await created.json() as { project: { id: string; slug: string } }).project;
  assert.equal(freshProject.slug, path.basename(freshCwd));
  const freshPlan = await freshClient.planCreate({ title: 'Immediate owner decision' });
  await requestDecision(freshRoot, { author: 'fixture-agent', permission: 'edit' }, { planId: freshPlan.plan.id, question: 'Can the new owner respond immediately?', alternatives: ['Proceed', 'Wait'], evidence: 'Synthetic project creation receipt' });
  await editorPage.locator('#project-selector option[value="' + freshProject.id + '"]').waitFor({ state: 'attached' });
  await editorPage.selectOption('#project-selector', freshProject.id);
  await openView(editorPage, 'decision-inbox');
  await assertInboxStatus(editorPage, '1 pending decision');
  assert.equal(await editorPage.getByRole('button', { name: 'Approve alternative' }).isEnabled(), true, 'a new owner can approve without reloading projects');
  assert.equal(await editorPage.getByRole('button', { name: 'Acknowledge only' }).isEnabled(), true);
  await editorPage.locator('textarea[name="reason"]').fill('Owner capability available immediately.');
  await editorPage.getByRole('button', { name: 'Acknowledge only' }).click();
  await editorPage.getByText('Acknowledged. The request remains pending.', { exact: false }).waitFor();
  await selectWorkspace(editorPage, after.url('/'), project);
  let resume = (): void => {};
  const held = new Promise<void>(resolve => { resume = resolve; });
  const inboxUrl = '**/pm/decision-inbox?*';
  await editorPage.route(inboxUrl, async route => { await held; await route.continue(); });
  await openView(editorPage, 'decision-inbox');
  try { await assertInboxStatus(editorPage, 'Loading decisions…', true); }
  finally { resume(); }
  await assertInboxStatus(editorPage, '1 pending decision');
  await editorPage.unroute(inboxUrl);
  // An SSE refresh must preserve the same boundary when no draft is present.
  const refreshed = editorPage.waitForResponse(response => response.url().includes('/pm/decision-inbox?'));
  broadcastProjectEvent(project, { type: 'workspace-changed', data: { userId: owner } });
  await refreshed;
  await assertInboxStatus(editorPage, '1 pending decision');
  const acknowledge = editorPage.getByRole('button', { name: 'Acknowledge only' });
  await acknowledge.click();
  await editorPage.getByText('Add a reason before responding.', { exact: true }).waitFor();
  await editorPage.locator('textarea[name="reason"]').fill('Evidence read; waiting for shared-access requirements.');
  broadcastProjectEvent(project, { type: 'workspace-changed', data: { userId: owner } });
  await editorPage.getByText('New activity is available.', { exact: false }).waitFor();
  assert.equal(await editorPage.locator('textarea[name="reason"]').inputValue(), 'Evidence read; waiting for shared-access requirements.');
  await acknowledge.click();
  await editorPage.getByText('Acknowledged. The request remains pending.', { exact: false }).waitFor();
  await editorPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await editorPage.getByText('1 acknowledged', { exact: false }).waitFor();
  await editorPage.locator('input[name="alternative"][value="1"]').check();
  await editorPage.locator('textarea[name="reason"]').fill('Remote collaborators require shared access.');
  await editorPage.getByRole('button', { name: 'Approve alternative' }).click();
  await editorPage.getByText('Alternative approved and recorded in the plan.', { exact: false }).waitFor();
  await editorPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await editorPage.getByText('No pending decisions.', { exact: false }).waitFor();
  await assertInboxStatus(editorPage, '0 pending decisions');
  await editorPage.route(inboxUrl, route => route.abort());
  await editorPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await editorPage.locator('[data-inbox-status]').filter({ hasText: 'Could not load decisions.' }).waitFor();
  await assertInboxStatus(editorPage, (await editorPage.locator('[data-inbox-status]').textContent())!);
  await editorPage.unroute(inboxUrl);
  await editorPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await assertInboxStatus(editorPage, '0 pending decisions');
  await client.planDecision(plan.plan.id, { decisionText: 'Malformed synthetic envelope', decisionRationale: 'pm-web:decision-inbox:v1:{' });
  const malformed = editorPage.waitForResponse(response => response.url().includes('/pm/decision-inbox?') && response.status() === 503);
  await editorPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await malformed;
  await editorPage.locator('[data-inbox-status]').filter({ hasText: 'Could not load decisions.' }).waitFor();
  const repair = (await editorPage.locator('[data-inbox-status]').textContent())!;
  assert.ok(repair.includes(`Inspect Plan ${plan.plan.id}`), 'load failures must preserve the server repair remedy and affected Plan');
  await assertInboxStatus(editorPage, repair);
  const unchanged = await client.planShow(plan.plan.id);
  assert.equal(unchanged.plan.mode, 'draft'); assert.equal(unchanged.plan.steps_summary.completed, 0);
  await editorContext.close();

  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ fixture: 'synthetic local tracker and throwaway PostgreSQL', screenshots: 5, widths: [1440, 390], newOwnerCanRespondWithoutReload: true, viewerCannotApply: true, noHorizontalOverflow: true, unsentReasonPreserved: true, acknowledgmentRemainsPending: true, approvalRecordedWithoutCompletion: true }, null, 2) + '\n');
  console.log('5 local seeded screenshots; desktop/mobile fit and view-only controls verified.');
} finally {
  await browser?.close(); await before?.close(); await after?.close();
  for (const id of users) await pool.query('DELETE FROM pm_users WHERE id=$1', [id]);
  await pool.end(); await rm(root, { recursive: true, force: true });
}

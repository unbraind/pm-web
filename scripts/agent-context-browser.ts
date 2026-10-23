/** Capture synthetic desktop/mobile receipt views through a real local server and assert API/UI parity. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { createApp } from '../src/app.ts';
import { pool } from '../src/db.ts';
import { signToken } from '../src/auth.ts';
import { AgentContextClient, type AgentContextPacket } from '../src/agent-context.ts';
import { startEphemeralServer } from '../test/helpers/ephemeral-server.ts';
import type { AppBridge } from '../public/src/app.ts';

const output = process.env.CONTEXT_SCREENSHOTS;
assert.ok(output, 'Set CONTEXT_SCREENSHOTS to the screenshot output directory.');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-context-browser-'));
process.env.PROJECTS_ROOT = root;
const users: string[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
const server = await startEphemeralServer(createApp());
try {
  const owner = (await pool.query<{ id: string }>("INSERT INTO pm_users(email,password_hash,display_name) VALUES($1,'x','Synthetic publisher') RETURNING id", [`publisher-${randomUUID()}@example.test`])).rows[0].id;
  const viewer = (await pool.query<{ id: string }>("INSERT INTO pm_users(email,password_hash,display_name) VALUES($1,'x','Synthetic viewer') RETURNING id", [`viewer-${randomUUID()}@example.test`])).rows[0].id;
  users.push(owner, viewer);
  const slug = `context-${randomUUID()}`;
  const project = (await pool.query<{ id: string }>("INSERT INTO pm_projects(user_id,name,slug,prefix) VALUES($1,'Release evidence',$2,'demo') RETURNING id", [owner, slug])).rows[0].id;
  await pool.query("INSERT INTO pm_project_shares(project_id,shared_with_user_id,permission) VALUES($1,$2,'view')", [project, viewer]);
  const cwd = path.join(root, owner, slug); await mkdir(cwd, { recursive: true });
  const pm = new PmClient({ pmRoot: path.join(cwd, '.agents', 'pm'), cwd, noExtensions: true });
  await pm.init('demo', { defaults: true, agentGuidance: 'skip' });
  const sdk = new AgentContextClient(server.url('/'), signToken({ userId: owner, email: 'publisher@example.test' }));
  const packet = await sdk.publish(project, { agent: 'release-agent', question: 'Do we have enough evidence to approve the release?', consent: true, viewers: [viewer], receipts: [{ source: 'core-output-session', receiptId: 'release-read-session', revision: 'public-snapshot-42', servedAt: '2026-10-23T08:00:00Z', omission: [{ reason: '3 repeated items represented by references', remedy: 'Restore with pm get <item-id> --brief.' }] }, { source: 'pm-context-pack', receiptId: 'review-pack-7', revision: 'public-snapshot-42', servedAt: '2026-10-23T08:02:00Z', omission: [{ reason: 'Full test logs were outside the context budget', remedy: 'Read the linked CI run before approving.' }] }], gaps: [{ reason: 'Independent review is pending', remedy: 'Wait for a reviewer to inspect the exact revision.' }] });
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1200 }, { width: 390, height: 1900 }]) {
    const width = viewport.width;
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'pm_token', value: signToken({ userId: viewer, email: 'viewer@example.test' }), url: server.url('/') }]);
    const page = await context.newPage(); await page.goto(server.url('/'));
    await page.getByRole('button', { name: 'Necessary only', exact: true }).click();
    await page.locator(`#project-selector option[value="${project}"]`).waitFor({ state: 'attached' });
    await page.selectOption('#project-selector', project);
    await page.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('agent-context'));
    await page.getByText(packet.question, { exact: true }).waitFor();
    const response = await page.request.get(server.url(`/api/projects/${project}/pm/agent-context/${packet.id}?revision=${packet.revision}`));
    assert.equal(response.status(), 200); const api = await response.json() as AgentContextPacket;
    for (const row of [...api.receipts.flatMap(receipt => receipt.omission), ...api.gaps]) { await page.getByText(row.reason, { exact: true }).waitFor(); await page.getByText(row.remedy, { exact: true }).waitFor(); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `agent-context-${width}.png`), fullPage: true });
    assert.equal(await page.getByRole('button', { name: 'Revoke this packet' }).count(), 0);
    if (width === 390) {
      const publisher = await browser.newContext({ serviceWorkers: 'block' });
      await publisher.addCookies([{ name: 'pm_token', value: signToken({ userId: owner, email: 'publisher@example.test' }), url: server.url('/') }]);
      const publisherPage = await publisher.newPage();
      await publisherPage.goto(server.url('/agent-context'));
      await publisherPage.locator(`#project-selector option[value="${project}"]`).waitFor({ state: 'attached' });
      await publisherPage.selectOption('#project-selector', project);
      await publisherPage.evaluate(() => (window as unknown as { __app: AppBridge }).__app.showView('agent-context'));
      await publisherPage.getByText(packet.question, { exact: true }).waitFor();
      // Model the service worker's explicit queue acknowledgment at the browser transport boundary.
      await publisherPage.route('**/pm/agent-context/*', async route => {
        if (route.request().method() === 'DELETE') await route.fulfill({ status: 200, contentType: 'application/json', body: '{"queued":true}' });
        else await route.continue();
      });
      await publisherPage.getByRole('button', { name: 'Revoke this packet' }).click();
      await publisherPage.getByText('Revocation queued. Access remains until the server confirms it;', { exact: false }).waitFor();
      assert.equal(await publisherPage.getByText(packet.question, { exact: true }).count(), 1);
      assert.equal((await sdk.get(project, packet.id, packet.revision)).id, packet.id);
      await publisher.close();
      await sdk.revoke(project, packet.id, packet.revision);
      await page.getByRole('button', { name: 'Refresh access' }).click();
      await page.getByText('This scope is no longer available.', { exact: false }).waitFor();
      assert.equal(await page.getByText(packet.question, { exact: true }).count(), 0);
    }
    await context.close();
  }
  console.log(JSON.stringify({ screenshots: 2, viewports: [1440, 390], omissionReasons: 2, gaps: 1, apiUiParity: true, revocationRefresh: true, queuedRevocation: true, horizontalOverflow: false }));
} finally {
  await browser.close(); await server.close();
  for (const id of users) await pool.query('DELETE FROM pm_users WHERE id=$1', [id]);
  await pool.end(); await rm(root, { recursive: true, force: true });
}

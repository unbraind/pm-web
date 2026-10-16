import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { fixtureItems, fixtureUser, fixtureComments, fixturePatches, updateFixtureItem } from './brand-fixtures.ts';
import type { AppBridge } from '../public/src/app.ts';

interface LiveWindow extends Window { __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }

/** Emit a fixture event through the production EventSource listener, without bypassing the client. */
async function emit(page: Page, own = false): Promise<void> {
  await page.evaluate(data => (window as unknown as LiveWindow).__fixtureEmit(data), { itemId: 'note-1', userId: own ? fixtureUser.id : 'fixture-reviewer', author: own ? 'Morgan' : 'Alex' });
}

/** Hold the real CSS animation at its 350 ms frame while its removal timer is paused. */
export async function holdArrivalFrame(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const row = page.locator('.item-row[data-item-id="note-1"]');
  const original = await row.boundingBox();
  await page.clock.install({ time: new Date('2026-10-17T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-17T12:01:00Z'));
  updateFixtureItem('note-1', { title: 'Make the shared next step clear' });
  await emit(page);
  await page.locator('.live-copy-sheet').first().waitFor({ state: 'attached' });
  const durations = await page.locator('.live-copy-sheet').evaluateAll(copies => copies.map(copy => {
    const animation = copy.getAnimations()[0];
    if (!animation) return 0;
    animation.pause();
    animation.currentTime = 350;
    return animation.effect?.getComputedTiming().duration;
  }));
  assert.ok(durations.length && durations.every(duration => duration === 700), 'Live arrival must last 700 ms');
  assert.deepEqual(await row.boundingBox(), original, 'The arrival moved its item row');
  assert.equal(await page.locator('#live-copy-caption').textContent(), 'Updated by Alex just now');
}

/** Exercise real readonly patches, draft isolation, echo suppression, border expiry and reduced motion. */
export async function checkLiveArrivals(page: Page): Promise<string[]> {
  const passed: string[] = [];
  await page.clock.runFor(650);
  assert.ok(await page.locator('.live-copy-sheet').count());
  await page.clock.runFor(100);
  assert.equal(await page.locator('.live-copy-sheet').count(), 0);
  assert.ok(await page.locator('.item-title.live-changed').count());
  await page.clock.runFor(4000);
  assert.ok(await page.locator('.item-title.live-changed').count());
  await page.clock.runFor(300);
  assert.equal(await page.locator('.live-changed').count(), 0);
  passed.push('700 ms settle and five-second border');

  await page.evaluate(() => (window as unknown as LiveWindow).__app.openItemDetail('note-1'));
  await page.locator('.item-detail-title').waitFor();
  const draft = page.locator('#new-comment');
  await draft.fill('This draft stays local');
  await draft.focus();
  const before = await draft.boundingBox();
  updateFixtureItem('note-1', { title: 'Review the shared field notes' });
  updateFixtureItem('note-1', { status: 'blocked' });
  updateFixtureItem('note-1', { blockedReason: 'Ask the reviewer to confirm the remaining check.' });
  await emit(page);
  await page.locator('.item-detail-title.live-changed').waitFor();
  assert.equal(await page.locator('.item-row[data-item-id="note-1"] .item-title').textContent(), 'Review the shared field notes', 'The list behind the detail became stale');
  assert.equal(await draft.inputValue(), 'This draft stays local');
  assert.equal(await draft.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await draft.boundingBox(), before, 'A remote edit moved the comment field');
  assert.equal(await page.locator('.item-detail-title').evaluate(el => el.style.getPropertyValue('--live-copy-ink')), 'var(--pm-rose)');
  assert.equal(await page.locator('#live-copy-announcement').getAttribute('aria-live'), 'polite');
  assert.equal(await page.locator('#live-copy-announcement').textContent(), 'Updated by Alex just now');
  passed.push('blocked rose, polite announcement, stable geometry and draft focus');
  await page.clock.runFor(800);

  updateFixtureItem('note-1', { title: 'My own echoed title' });
  await emit(page, true);
  await page.waitForFunction(() => document.querySelector('.item-detail-title')?.textContent === 'My own echoed title');
  assert.equal(await page.locator('.item-detail-title.live-changed').count(), 0);
  assert.equal(await page.locator('.live-copy-sheet').count(), 0);
  passed.push('own account updates never animate');

  await page.locator('.tab[onclick*="tab-update"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('#edit-desc').fill('My description draft');
  await page.locator('#edit-desc').focus();
  const editBox = await page.locator('#edit-desc').boundingBox();
  updateFixtureItem('note-1', { title: 'The other editor keeps this title' });
  await emit(page);
  await page.waitForFunction(() => document.querySelector('.item-detail-title')?.textContent?.includes('The other editor keeps this title'));
  assert.equal(await page.locator('#edit-desc').inputValue(), 'My description draft');
  assert.equal(await page.locator('#edit-desc').evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await page.locator('#edit-desc').boundingBox(), editBox);
  fixturePatches.length = 0;
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/pm/update/note-1'));
  await page.locator('button[onclick*="window.__app.updateItem"]').focus();
  await page.keyboard.press('Enter');
  await saved;
  assert.deepEqual(fixturePatches.at(-1), { description: 'My description draft' }, 'Saving a draft overwrote untouched remote fields');
  await page.locator('#new-comment').waitFor();
  assert.equal(fixtureItems[0].title, 'The other editor keeps this title');
  passed.push('stale drafts submit only the fields edited locally');

  await page.clock.runFor(800);
  fixtureComments.push({ text: 'Alex linked the final check results.', timestamp: '2026-10-17T12:02:00Z' });
  await page.locator('#new-comment').fill('Another local draft');
  await page.locator('#new-comment').focus();
  const commentBox = await page.locator('#new-comment').boundingBox();
  const firstEntry = page.locator('[data-live-field="comments"] [data-live-entry]').first();
  const firstEntryBox = await firstEntry.boundingBox();
  await emit(page);
  await page.waitForFunction(() => document.querySelector('[data-live-field="comments"]')?.textContent?.includes('Alex linked the final check results.'));
  assert.equal(await page.locator('#new-comment').inputValue(), 'Another local draft');
  assert.equal(await page.locator('#new-comment').evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await page.locator('#new-comment').boundingBox(), commentBox);
  assert.deepEqual(await firstEntry.boundingBox(), firstEntryBox, 'A new comment displaced the existing entry');
  assert.ok(await page.locator('.live-copy-sheet').count(), 'A different authenticated author was suppressed after a local save');
  passed.push('comment copies append without displacing existing entries');

  await page.clock.runFor(800);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  updateFixtureItem('note-1', { title: 'A reduced motion update' });
  await emit(page);
  await page.waitForFunction(() => document.querySelector('.item-detail-title')?.textContent === 'A reduced motion update');
  assert.equal(await page.locator('.live-copy-sheet').count(), 0);
  assert.ok(await page.locator('.item-detail-title.live-changed').count());
  assert.equal(await page.locator('.item-detail-title').evaluate(el => getComputedStyle(el).borderLeftWidth), '3px');
  assert.equal(await page.locator('#new-comment').evaluate(el => document.activeElement === el), true);
  passed.push('reduced motion keeps the border and caption without a sliding copy');
  return passed;
}

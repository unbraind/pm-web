/** Browser regressions for the sixth Triplicate review round. */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { Item } from '../public/src/types.ts';
import type { AppBridge } from '../public/src/app.ts';
import { fixtureResponse, updateFixtureItem } from './brand-fixtures.ts';
import { freezeFixtureClock, holdArrivalFrame } from './brand-browser-live.ts';

interface ReviewWindow extends Window { __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }

/** Deliver a fixture edit through the production EventSource listener. */
async function changeDetailFixture(page: Page, patch: Partial<Item>): Promise<void> {
  updateFixtureItem('note-1', patch);
  await page.evaluate(() => (window as unknown as ReviewWindow).__fixtureEmit({ itemId: 'note-1', userId: 'fixture-reviewer', author: 'Alex', surface: 'pm-web' }));
}

/** Check real action failures, metadata counts and the single live detail heading. */
export async function checkRound6(page: Page, only: string, capture: (name: string) => Promise<void>): Promise<string[]> {
  const run = (name: string): boolean => only === 'round6' || only === `round6-${name}`;
  const passed: string[] = [];
  if (run('errors')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('export'));
    await page.locator('#export-status').waitFor({ state: 'attached' });
    for (const action of ['Export', 'Import'] as const) {
      const endpoint = action === 'Export' ? '**/pm/export?format=csv' : '**/pm/import';
      await page.route(endpoint, route => route.fulfill({ status: 500, json: { error: '<img src=x onerror=alert(1)> fixture failure' } }));
      if (action === 'Export') await page.evaluate(() => (window as unknown as ReviewWindow).__app.exportData('csv'));
      else await page.evaluate(() => (window as unknown as ReviewWindow).__app.importData(new File(['[{"title":"Fixture"}]'], 'fixture.json', { type: 'application/json' })));
      assert.equal(await page.locator('#export-status').textContent(), `${action} failed. <img src=x onerror=alert(1)> fixture failure Try again.`);
      assert.equal(await page.locator('#export-status img').count(), 0, 'Error details must stay escaped');
      await page.unroute(endpoint);
    }
    passed.push('errors: export/import name the failed action, escape details and offer retry');
  }
  if (run('metadata')) {
    for (const count of [2, 0]) {
      await page.route('**/pm/graph*', route => {
        const data = fixtureResponse('/api/graph') as { graph: { nodes: unknown[] } };
        data.graph.nodes.push(...Array.from({ length: count }, (_, index) => ({ id: `tag:fixture-${index}`, labels: ['PmFacet'], properties: { name: `Facet ${index}`, kind: 'tag' } })));
        return route.fulfill({ json: data });
      });
      await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('graph'));
      const chip = page.locator('[data-graph-preset="metadata"]');
      await chip.waitFor();
      assert.equal(await chip.locator('strong').textContent(), count ? String(count) : 'none', 'Metadata follows the count-or-none rule');
      assert.equal(await chip.getAttribute('aria-label'), `Metadata: ${count || 'none'}`);
      if (count) { await page.waitForTimeout(1200); await capture('graph'); }
      await page.unroute('**/pm/graph*');
      await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('items'));
    }
    passed.push('metadata: two facets and zero facets show count/none with matching accessible names');
  }
  if (run('detail') || run('live') || run('geometry')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.openItemDetail('note-1'));
    const modal = page.locator('#item-detail-modal');
    await modal.locator('.item-detail-title').waitFor();
    if (run('detail')) {
      assert.equal(await modal.locator('[data-live-field="strip"]').count(), 1, 'One strip per detail sheet');
      assert.equal(await modal.locator('[data-live-field="title"]').count(), 1, 'One title per detail sheet');
      assert.equal(await modal.locator('[data-live-caption]').count(), 1, 'One caption per detail sheet');
      assert.equal(await modal.locator('[data-live-field="title"]').evaluate(el => el.nextElementSibling?.hasAttribute('data-live-caption')), true, 'Caption is directly after the title');
      await capture('detail-open');
      passed.push('detail: one strip, one title and one title-adjacent caption');
    }
    if (run('live') || run('geometry')) {
      await page.locator('#new-comment').fill('Keep this local draft');
      await page.locator('#new-comment').focus();
      const before = await page.locator('#new-comment').boundingBox();
      await freezeFixtureClock(page);
      await holdArrivalFrame(page, 'detail');
      const title = modal.locator('[data-live-field="title"]');
      assert.equal(await title.locator('.live-copy-sheet').getAttribute('data-live-origin'), 'Alex · pm-web');
      assert.equal(await title.locator('.live-copy-sheet').count(), 1, 'The title owns its live arrival slip');
      assert.equal(await modal.locator('.modal-body .live-copy-sheet').count(), 0, 'A title change does not tint unchanged body rows');
      assert.equal(await page.locator('#new-comment').inputValue(), 'Keep this local draft');
      assert.deepEqual(await page.locator('#new-comment').boundingBox(), before, 'Live title changes preserve draft geometry');
      await capture('live-arrival-detail');
      await page.clock.runFor(800);
      assert.equal(await title.locator('.live-copy-sheet').count(), 0);
      assert.equal(await title.evaluate(el => el.classList.contains('live-changed')), true);
      await capture('live-arrival-detail-settled');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await changeDetailFixture(page, { title: 'A reduced motion title update' });
      await page.waitForFunction(() => document.querySelector('#item-detail-modal [data-live-field="title"]')?.textContent === 'A reduced motion title update');
      assert.equal(await title.locator('.live-copy-sheet').count(), 0);
      assert.equal(await title.evaluate(el => getComputedStyle(el).borderLeftWidth), '3px');
      assert.equal(await modal.locator('[data-live-caption]').textContent(), 'Alex · pm-web · now');
      await modal.locator('[data-live-caption]').evaluate(el => { el.textContent = ''; });
      await changeDetailFixture(page, { status: 'blocked' });
      await page.waitForFunction(() => document.querySelector('#item-detail-modal .detail-status-slot')?.getAttribute('data-live-value') === 'blocked');
      assert.equal(await modal.locator('[data-live-caption]').textContent(), 'Alex · pm-web · now', 'Body-only changes use the single sheet caption');
      passed.push('live: title owns slip and tint, caption stays adjacent; draft is stable and reduced motion keeps the end state');
    }
    await page.keyboard.press('Escape');
  }
  console.log(`Round 6 cases passed: ${passed.join('; ')}`);
  return passed;
}

import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { AppBridge } from '../public/src/app.ts';
import { fixtureItems, updateFixtureItem } from './brand-fixtures.ts';
import type { GraphCanvas as CanvasGraph } from '../public/src/views/graph-canvas.ts';

interface ReviewWindow extends Window { __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }
interface GraphReviewWindow extends Window { __reviewGraphCanvas: typeof CanvasGraph }

/** Commit a synthetic status before notifying the production SSE listener. */
async function updateStatus(page: Page, status: string): Promise<void> {
  updateFixtureItem('note-1', { status });
  await page.evaluate(() => (window as unknown as ReviewWindow).__fixtureEmit({ itemId: 'note-1', userId: 'fixture-reviewer', author: 'Alex' }));
}

/** Assert that membership reconciliation leaves the focused local comment draft intact. */
async function assertLocalDraft(page: Page): Promise<void> {
  const draft = page.locator('#new-comment');
  assert.equal(await draft.inputValue(), 'Keep this local draft');
  assert.equal(await draft.evaluate(el => document.activeElement === el), true);
}

/** Finished sheets hide only Start/Pause/Claim and retain a usable Release action. */
export async function assertFinishedActions(page: Page): Promise<void> {
  for (const name of ['start', 'pause', 'claim']) {
    const action = page.locator(`[data-item-action="${name}"]`);
    assert.equal(await action.getAttribute('aria-disabled'), 'true');
    assert.match(await action.getAttribute('title') || '', /unavailable/);
    assert.equal(await action.isVisible(), false, 'Finished items hide Start, Pause and Claim');
  }
  const release = page.locator('[data-item-action="release"]');
  assert.equal(await release.isVisible(), true);
  assert.equal(await release.getAttribute('aria-disabled'), 'false');
  const geometry = await page.locator('.claim-btn-wrap').evaluate(root => {
    const bounds = root.getBoundingClientRect();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.checkVisibility()).map(button => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, clipped: button.scrollWidth > button.clientWidth + 1 };
    });
    return { outside: buttons.some(box => box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.clipped), overlap: buttons.some((box, index) => buttons.slice(index + 1).some(other => box.left < other.right - 1 && box.right > other.left + 1 && box.top < other.bottom - 1 && box.bottom > other.top + 1)) };
  });
  assert.equal(geometry.outside, false, 'Finished actions must remain inside the sheet without clipping');
  assert.equal(geometry.overlap, false, 'Finished actions must not overlap');
}

/** Regress the reviewed lifecycle, dialog, canvas and compact-row behavior through built browser modules. */
export async function checkReviewRegressions(page: Page, only = ''): Promise<string[]> {
  const passed: string[] = [];
  const run = (name: string): boolean => !only || only === name;
  await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('items'));
  await page.locator('.item-row').first().waitFor();
  if (run('membership')) {
    await page.locator('#filter-status').selectOption('open');
    await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 1);
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.openItemDetail('note-1'));
    const draft = page.locator('#new-comment');
    await draft.fill('Keep this local draft');
    await draft.focus();
    await updateStatus(page, 'blocked');
    await page.waitForFunction(() => !document.querySelector('.item-row[data-item-id="note-1"]'));
    await assertLocalDraft(page);
    await updateStatus(page, 'open');
    await page.locator('.item-row[data-item-id="note-1"]').waitFor();
    await assertLocalDraft(page);
    await page.keyboard.press('Escape');
    await page.locator('#filter-status').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('.item-row').length === 5);
    await page.locator('[data-items-layout="board"]').click();
    await page.locator('.item-row[data-item-id="note-1"]').focus();
    await updateStatus(page, 'blocked');
    await page.locator('section[aria-label="blocked"] .item-row[data-item-id="note-1"]').waitFor();
    assert.equal(await page.locator('.item-row[data-item-id="note-1"]').evaluate(el => document.activeElement === el), true);
    assert.match(await page.locator('section[aria-label="blocked"] h2').textContent() || '', /2$/);
    await updateStatus(page, 'open');
    await page.locator('section[aria-label="open"] .item-row[data-item-id="note-1"]').waitFor();
    await page.locator('[data-items-layout="list"]').click();
    const order = await page.locator('.item-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-id')));
    const originalTitle = fixtureItems.find(item => item.id === 'note-1')!.title;
    await page.locator('.item-row[data-item-id="note-1"]').focus();
    fixtureItems.reverse();
    try {
      updateFixtureItem('note-1', { title: 'Refresh this row without reordering its neighbors' });
      const response = page.waitForResponse(response => response.url().includes('/pm/list-all?limit=200'));
      await updateStatus(page, 'open');
      await (await response).finished();
      await page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
      assert.deepEqual(await page.locator('.item-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-id'))), order, 'A reordered response must preserve existing row order');
      assert.equal(await page.locator('.item-row[data-item-id="note-1"]').evaluate(el => document.activeElement === el), true);
    } finally {
      fixtureItems.reverse();
      updateFixtureItem('note-1', { title: originalTitle });
    }
    passed.push('membership: filtered exit/entry, board relocation/counts, stable order, local draft and focus');
  }
  if (run('closed-actions') || run('confirmation')) {
    for (const id of run('closed-actions') ? ['note-4', 'note-5'] : ['note-4']) {
      await page.evaluate(id => (window as unknown as ReviewWindow).__app.openItemDetail(id), id);
      await page.locator('#new-comment').waitFor();
      if (run('closed-actions')) {
        await assertFinishedActions(page);
        await page.locator('.tab[onclick*="tab-close"]').focus();
        await page.keyboard.press('Enter');
        await page.locator('#tab-close button').filter({ hasText: 'Delete item' }).waitFor({ state: 'visible' });
        assert.equal(await page.locator('#tab-close [data-item-action="close"]').first().getAttribute('aria-disabled'), 'true');
      }
      await page.locator('.claim-btn-wrap button').filter({ hasText: 'Delete item' }).focus();
      await page.keyboard.press('Enter');
      if (run('confirmation')) {
        await page.getByRole('dialog', { name: 'Delete item?' }).waitFor();
        assert.equal(await page.getByRole('dialog', { name: 'Delete item?' }).getAttribute('aria-modal'), 'true');
      }
      await page.keyboard.press('Escape');
      if (run('closed-actions')) {
        const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes(`/pm/update/${id}`));
        await page.locator('[data-item-action="reopen"]').focus();
        await page.keyboard.press('Enter');
        await saved;
        assert.equal(fixtureItems.find(item => item.id === id)?.status, 'open');
        await page.locator('[data-item-action="start"][aria-disabled="false"]').waitFor();
        updateFixtureItem(id, { status: id === 'note-4' ? 'closed' : 'canceled' });
      }
      await page.evaluate(() => (window as unknown as ReviewWindow).__app.hideModal('item-detail-modal'));
    }
    if (run('closed-actions')) passed.push('closed-actions: Delete panel and direct action, valid Reopen, disabled lifecycle actions');
    if (run('confirmation')) passed.push('confirmation: accessible name equals visible prompt');
  }
  if (run('graph-escape')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('graph'));
    for (const kind of ['add', 'remove']) {
      const trigger = page.locator(`#graph-${kind}-dep-btn`);
      for (let repeat = 0; repeat < 2; repeat++) {
        await trigger.focus();
        await page.keyboard.press('Enter');
        const dialog = page.locator(`#graph-${kind}-dep-modal`);
        await dialog.waitFor();
        assert.equal(await dialog.count(), 1);
        if (kind === 'add') {
          await page.locator('#graph-dep-submit').click();
          await page.locator('#graph-dep-error').waitFor({ state: 'visible' });
        } else {
          await page.locator('#graph-remove-dep-select').selectOption([]);
          await page.locator('#graph-remove-dep-submit').click();
          await page.locator('#graph-remove-dep-error').waitFor({ state: 'visible' });
        }
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0, 'Escape must remove directly inserted graph dialogs');
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Escape must return focus to the graph action');
      }
    }
    passed.push('graph-escape: add/remove dialogs reopen twice with working controls and unique ids');
  }
  if (run('graph-status') || run('graph-opacity')) {
    await page.addScriptTag({ type: 'module', content: "import { GraphCanvas } from '/src/views/graph-canvas.js'; window.__reviewGraphCanvas = GraphCanvas;" });
    await page.waitForFunction(() => !!(window as unknown as GraphReviewWindow).__reviewGraphCanvas);
    const results = await page.evaluate(() => {
      const GraphCanvas = (window as unknown as GraphReviewWindow).__reviewGraphCanvas;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      const graph = Object.create(GraphCanvas.prototype) as { ctx: CanvasRenderingContext2D; scale: number; pulseT: number; filter: { criticalPathIds: Set<string>; colorMode: 'status' | 'type' | 'tag' }; computeNodeColor: (node: { lane: string; status: string; type: string }) => string; drawNode: (node: { id: string; label: string; type: string; status: string; lane: string; x: number; y: number; r: number; color: string }, opacity: number, selected: boolean, hovered: boolean) => void };
      Object.assign(graph, { ctx, scale: 1, pulseT: 0, filter: { criticalPathIds: new Set<string>(), colorMode: 'status' } });
      const calls: { kind: string; color: string; alpha: number; text?: string }[] = [];
      for (const name of ['fill', 'stroke', 'fillText'] as const) {
        const original = ctx[name].bind(ctx);
        if (name === 'fillText') ctx.fillText = (text, x, y) => { calls.push({ kind: name, color: String(ctx.fillStyle), alpha: ctx.globalAlpha, text }); (original as typeof ctx.fillText)(text, x, y); };
        else ctx[name] = () => { calls.push({ kind: name, color: String(name === 'fill' ? ctx.fillStyle : ctx.strokeStyle), alpha: ctx.globalAlpha }); (original as () => void)(); };
      }
      const css = getComputedStyle(document.documentElement);
      const normalize = (token: string): string => { const tmp = document.createElement('canvas').getContext('2d')!; tmp.fillStyle = css.getPropertyValue(token).trim(); return String(tmp.fillStyle); };
      const neutralStatusColors = ['draft', 'custom', 'constructor', 'toString', '__proto__'].map(status => ({ status, color: graph.computeNodeColor({ lane: 'item', status, type: 'Task' }), expected: css.getPropertyValue('--pm-graphite').trim() }));
      const draws = (['status', 'type', 'tag'] as const).flatMap(mode => (['item', 'facet', 'external'] as const).flatMap(lane => ['in-progress', 'canceled', 'draft', 'custom', 'constructor', 'toString', '__proto__', 'open', 'in_progress', 'blocked', 'closed'].flatMap(status => [1, 0.07, 0.15].map(opacity => {
        calls.length = 0;
        graph.filter.colorMode = mode;
        graph.drawNode({ id: 'test-node', label: 'Reviewed label', type: 'Task', status, lane, x: 50, y: 50, r: 15, color: lane === 'item' && mode === 'status' ? normalize('--pm-carbon') : '#010203' }, opacity, false, false);
        const known = lane === 'item' && ['open', 'in_progress', 'blocked', 'closed', 'canceled'].includes(status.replace('-', '_'));
        const prefix = `--pm-status-${status.replace('-', '_')}`;
        return { status, mode, lane, opacity, calls: [...calls], expectedFill: normalize(known ? `${prefix}-bg` : '--pm-paper'), expectedBorder: lane === 'item' && mode === 'status' ? normalize(known ? `${prefix}-border` : '--pm-rule') : 'rgba(1, 2, 3, 0.72)' };
      }))));
      return { draws, neutralStatusColors };
    });
    if (run('graph-status')) for (const entry of results.neutralStatusColors) assert.equal(entry.color, entry.expected, `Graph ${entry.status}: neutral palette`);
    for (const result of results.draws) {
      if (run('graph-status')) {
        assert.equal(result.calls.find(call => call.kind === 'fill')?.color, result.expectedFill, `Graph ${result.status}: contract fill`);
        assert.equal(result.calls.find(call => call.kind === 'stroke')?.color, result.expectedBorder, `Graph ${result.status}/${result.lane}/${result.mode}: outline`);
        assert.equal(result.calls.filter(call => call.kind === 'stroke').length, result.status === 'canceled' && result.lane === 'item' ? 2 : 1, 'Only canceled item labels carry a strike');
      }
      if (run('graph-opacity')) for (const call of result.calls) assert.ok(Math.abs(call.alpha - result.opacity) < 0.001, `${result.status}: ${call.kind}/${call.text || 'shape'} lost node opacity`);
    }
    if (run('graph-status')) passed.push('graph-status: all five statuses, alias, draft and custom neutral, canceled strike, lane/type/tag outlines');
    if (run('graph-opacity')) passed.push('graph-opacity: shape, abbreviation, label pill and text at full, filtered and selected-neighbor opacity');
  }
  if (run('compact-rows')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('items'));
    await page.locator('.item-row').first().waitFor();
    const rows = await page.locator('.item-row').evaluateAll(rows => rows.map(row => {
      const strip = row.querySelector('.item-strip')!.getBoundingClientRect();
      const title = row.querySelector('.item-title')!.getBoundingClientRect();
      const caption = row.querySelector('[data-live-caption]')!;
      return { gap: title.top - strip.bottom, captionHeight: caption.getBoundingClientRect().height, empty: !caption.textContent };
    }));
    assert.equal(rows.length, 5);
    for (const row of rows) { assert.ok(row.empty); assert.equal(row.captionHeight, 0, 'An empty arrival caption must reserve no band'); assert.ok(row.gap < 20, `Excess gap before title: ${row.gap}`); }
    passed.push('compact-rows: all five empty captions have zero height and compact title gaps');
  }
  console.log(`Review regressions passed: ${passed.join('; ')}`);
  return passed;
}

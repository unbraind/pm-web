import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { GraphCanvas, CanvasNode } from '../public/src/views/graph-canvas.ts';
import type { AppBridge } from '../public/src/app.ts';
import { fixtureItems, updateFixtureItem } from './brand-fixtures.ts';

interface CanvasWindow extends Window { __round3Canvas: typeof GraphCanvas; __app: AppBridge; __fixtureEmit: (data: Record<string, unknown>) => void }

/** Notify the production listener after an authoritative synthetic edit. */
async function emitEdit(page: Page, patch: Partial<typeof fixtureItems[number]>): Promise<void> {
  updateFixtureItem('note-1', patch);
  await page.evaluate(() => (window as unknown as CanvasWindow).__fixtureEmit({ itemId: 'note-1', userId: 'fixture-reviewer', author: 'Alex' }));
}

/** Measure yielding, completion, coalescing and cancellation using real canvas physics. */
async function checkSettle(page: Page, baseline: boolean): Promise<string> {
  const measurement = await page.evaluate(async baseline => {
    const host = document.createElement('div');
    host.style.cssText = 'width:900px;height:600px';
    document.body.append(host);
    const graph = new (window as unknown as CanvasWindow).__round3Canvas(host, { onSelectNode() {}, onOpenNode() {}, onContextMenu() {} });
    const inspect = graph as unknown as { settleTimer: ReturnType<typeof setTimeout> | null; nodes: { x: number; y: number }[]; settleWorker: Worker | null };
    const nodes: CanvasNode[] = Array.from({ length: 2000 }, (_, index) => ({ id: `scale-${index}`, label: `Scale ${index}`, lane: 'item', type: 'Task', status: 'open', degree: 2 }));
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id, type: 'DEPENDS_ON' }));
    graph.setData(nodes, edges);
    let workers = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers++; }
    };
    const before = inspect.nodes.map(node => [node.x, node.y]);
    const start = performance.now();
    graph.reheat();
    const callMs = performance.now() - start;
    if (baseline || callMs >= 50) { graph.destroy(); host.remove(); window.Worker = NativeWorker; return { callMs, nodes: nodes.length, edges: edges.length, elapsedMs: callMs, workers, yielded: false, staticUntilDone: true, canceled: true }; }
    // Slider events from distinct tasks must coalesce to one 180-step simulation.
    graph.setPhysicsParams({ repulsion: 3000 });
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
    graph.setPhysicsParams({ repulsion: 3500 });
    let yielded = false;
    let staticUntilDone = true;
    await new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (inspect.settleTimer !== null || inspect.settleWorker !== null) {
          yielded = true;
          staticUntilDone &&= inspect.nodes.every((node, index) => node.x === before[index][0] && node.y === before[index][1]);
          if (performance.now() - start > 180000) { reject(new Error('Settle did not complete')); return; }
          setTimeout(poll, 20);
        } else resolve();
      };
      setTimeout(poll, 0);
    });
    const elapsedMs = performance.now() - start;
    const moved = inspect.nodes.some((node, index) => node.x !== before[index][0] || node.y !== before[index][1]);
    const waitForWorker = () => new Promise<void>(resolve => {
      const started = () => { if (inspect.settleWorker !== null) resolve(); else setTimeout(started, 1); };
      started();
    });
    const coalescedWorkers = workers;
    graph.reheat();
    await waitForWorker();
    graph.setData(nodes.slice(0, 2), []);
    const canceled = inspect.settleTimer === null && inspect.settleWorker === null && inspect.nodes.length === 2;
    graph.setData(nodes, edges);
    graph.reheat();
    await waitForWorker();
    graph.destroy();
    const destroyed = inspect.settleTimer === null && inspect.settleWorker === null;
    window.Worker = NativeWorker;
    host.remove();
    return { nodes: nodes.length, edges: edges.length, callMs, elapsedMs, workers: coalescedWorkers, yielded, staticUntilDone, canceled: canceled && destroyed, moved };
  }, baseline);
  console.log(`Round 3 settle measurement: ${JSON.stringify(measurement)}`);
  if (!baseline) {
    assert.ok(measurement.callMs < 50, 'Reflow must return without blocking input for 50ms');
    assert.equal(measurement.yielded, true, 'Input task must run while settling');
    assert.equal(measurement.staticUntilDone, true, 'Intermediate physics must not animate the painted graph');
    assert.equal(measurement.workers, 1, 'Slider requests across tasks must coalesce to one real worker');
    assert.equal(measurement.moved, true, 'Settling must publish actual computed positions');
    assert.equal(measurement.canceled, true, 'Data replacement and destroy must cancel queued settling');
  }
  return `settle: ${JSON.stringify(measurement)}`;
}

/** Regress all eleven third-round findings against rebuilt production browser modules. */
export async function checkRound3(page: Page, only = 'round3', capture?: (name: string) => Promise<void>): Promise<string[]> {
  const passed: string[] = [];
  const run = (name: string): boolean => only === 'round3' || (only === 'round3-ui' && name !== 'settle') || only === `round3-${name}`;
  await page.addScriptTag({ type: 'module', content: "import { GraphCanvas } from '/src/views/graph-canvas.js'; window.__round3Canvas = GraphCanvas;" });
  await page.waitForFunction(() => !!(window as unknown as CanvasWindow).__round3Canvas);
  if (run('settle') || only === 'round3-measure') passed.push(await checkSettle(page, only === 'round3-measure'));
  if (run('opener')) {
    const opener = page.locator('#filter-assignee');
    await opener.focus();
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.keyboard.press('Control+k');
      await page.locator('#global-search-input').waitFor({ state: 'visible' });
      await page.keyboard.press('Control+k');
      await page.keyboard.press('Escape');
      assert.equal(await opener.evaluate(el => el === document.activeElement), true, 'Repeated open must preserve the external opener');
    }
    passed.push('opener: Ctrl+K twice and Escape, repeated twice');
  }
  if (run('tags')) {
    const original = fixtureItems[0].tags;
    await emitEdit(page, { tags: ['<review>', 'two & three'] });
    const chips = page.locator('.item-row[data-item-id="note-1"] .item-tags .tag');
    await page.waitForFunction(() => document.querySelector('.item-row[data-item-id="note-1"] .item-tags')?.textContent === '<review>two & three');
    assert.deepEqual(await chips.allTextContents(), ['<review>', 'two & three']);
    assert.equal(await page.locator('.item-tags review').count(), 0, 'Tags must remain escaped');
    await capture?.('items-tags');
    await emitEdit(page, { tags: [] });
    await page.waitForFunction(() => !document.querySelector('.item-row[data-item-id="note-1"] .item-tags')?.textContent);
    await emitEdit(page, { tags: original });
    passed.push('tags: escaped chips, empty tags and authoritative row reuse');
  }
  if (run('stale')) {
    let releaseOld: (() => void) | undefined;
    let arrivedOld: (() => void) | undefined;
    const oldArrived = new Promise<void>(resolve => { arrivedOld = resolve; });
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const pattern = '**/pm/list-all?*';
    await page.route(pattern, async route => {
      const old = new URL(route.request().url()).searchParams.get('assignee') === 'Old';
      if (old) { arrivedOld?.(); await oldGate; }
      await route.fulfill({ json: { items: [fixtureItems[old ? 0 : 1]] } });
    });
    await page.locator('#filter-assignee').fill('Old');
    await oldArrived;
    await page.locator('#filter-assignee').fill('New');
    await page.waitForFunction(() => document.querySelector('#items-list .item-row')?.getAttribute('data-item-id') === 'note-2');
    const oldResponse = page.waitForResponse(response => response.url().includes('assignee=Old'));
    releaseOld?.();
    await (await oldResponse).finished();
    // Drain the browser's fetch continuation before checking the list and count.
    await page.evaluate(() => new Promise<void>(resolve => { setTimeout(resolve, 100); }));
    assert.deepEqual(await page.locator('#items-list .item-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-item-id'))), ['note-2']);
    assert.equal(await page.locator('#items-subtitle').textContent(), '1 item');
    await page.unroute(pattern);
    await page.locator('#filter-assignee').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#items-list .item-row').length === 5);
    passed.push('stale: earlier in-place filter response cannot overwrite current rows or count');
  }
  if (run('dedupe')) {
    await page.route('**/pm/dedupe-audit', route => route.fulfill({ json: { groups: [{ items: ['note-1', { id: 'note-2', title: 'Unknown status' }, fixtureItems[3]] }] } }));
    await page.evaluate(() => (window as unknown as CanvasWindow).__app.showView('dedupe'));
    await page.locator('#dedupe-content .item-row').first().waitFor();
    assert.equal(await page.locator('#dedupe-content .item-row[data-item-id="note-1"] .status-badge').count(), 0);
    assert.equal(await page.locator('#dedupe-content .item-row[data-item-id="note-2"] .status-badge').count(), 0);
    assert.equal(await page.locator('#dedupe-content .status-closed').count(), 1);
    await capture?.('dedupe');
    await page.unroute('**/pm/dedupe-audit');
    passed.push('dedupe: string and status-less object omit badge; known closed status retained');
  }
  if (run('active-view') || run('dependency-close') || run('legend')) {
    await page.evaluate(() => (window as unknown as CanvasWindow).__app.showView('graph'));
    await page.locator('#graph-add-dep-btn').waitFor();
  }
  if (run('active-view')) {
    await page.evaluate(() => (window as unknown as CanvasWindow).__app.openItemDetail('note-1'));
    await page.locator('#new-comment').fill('Retain my draft');
    await page.locator('#new-comment').focus();
    const response = page.waitForResponse(response => response.url().endsWith('/pm/graph'), { timeout: 5000 });
    await emitEdit(page, { title: 'Update the detail and the active graph' });
    await (await response).finished();
    assert.equal(await page.locator('#new-comment').inputValue(), 'Retain my draft');
    assert.equal(await page.locator('#new-comment').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    passed.push('active-view: detail arrival also fetches active graph and preserves focused draft');
  }
  if (run('dependency-close')) {
    for (const kind of ['add', 'remove']) for (const action of ['close', 'cancel', 'submit']) {
      const trigger = page.locator(`#graph-${kind}-dep-btn`);
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator(`#graph-${kind}-dep-modal`);
      await dialog.waitFor();
      if (action === 'submit') {
        if (kind === 'add') await page.locator('#graph-dep-to').selectOption('note-2');
        else await page.locator('#graph-remove-dep-select').selectOption('0');
        await page.locator(kind === 'add' ? '#graph-dep-submit' : '#graph-remove-dep-submit').click();
      } else await dialog.locator(action === 'close' ? '.modal-close' : '.modal-footer .btn-ghost').click();
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(id => document.activeElement?.id === id, `graph-${kind}-dep-btn`);
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, `${kind}/${action} restores the opener`);
    }
    passed.push('dependency-close: close, Cancel and submit restore focus for both dialogs');
  }
  if (run('legend')) {
    await page.locator('#graph-color-mode').selectOption('type', { force: true });
    const colors = await page.locator('#graph-legend-hud span').evaluateAll(spans => spans.flatMap(span => {
      const dot = span.querySelector<HTMLElement>('i');
      return dot && ['Task', 'Feature', 'Bug', 'Chore'].includes(span.textContent || '') ? [{ type: span.textContent, color: getComputedStyle(dot).backgroundColor }] : [];
    }));
    const carbon = await page.evaluate(() => { const el = document.createElement('i'); el.style.color = 'var(--pm-carbon)'; document.body.append(el); const color = getComputedStyle(el).color; el.remove(); return color; });
    assert.equal(colors.find(entry => entry.type === 'Task')?.color, carbon);
    await capture?.('graph-type');
    passed.push('legend: task swatch uses canvas carbon in type mode');
  }
  if (run('edge-opacity') || run('tab-hint')) {
    const drawing = await page.evaluate(() => {
      const Canvas = (window as unknown as CanvasWindow).__round3Canvas;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      const graph = Object.create(Canvas.prototype) as { ctx: CanvasRenderingContext2D; scale: number; filter: { criticalPathIds: Set<string>; selectedId: string | null }; biDirPairs: Set<string>; paused: boolean; w: number; h: number; drawEdge: (edge: unknown, opacity: number, active: boolean) => void; drawHud: () => void };
      Object.assign(graph, { ctx, scale: 1, filter: { criticalPathIds: new Set(), selectedId: null }, biDirPairs: new Set(), paused: true, nodes: [{}], edges: [], w: 900, h: 600 });
      const calls: { text: string; alpha: number }[] = [];
      const fills: number[] = [];
      ctx.fillText = text => { calls.push({ text, alpha: ctx.globalAlpha }); };
      ctx.fillRect = () => { fills.push(ctx.globalAlpha); };
      for (const opacity of [0.07, 0.15, 1]) graph.drawEdge({ type: 'DEPENDS_ON', source: { id: 'a', x: 10, y: 10, r: 2 }, target: { id: 'b', x: 100, y: 100, r: 2 } }, opacity, true);
      graph.drawHud();
      return { labels: calls.filter(call => call.text === 'DEPENDS_ON'), fills: fills.slice(0, 3), hint: calls.find(call => call.text.includes('Tab:'))?.text };
    });
    if (run('edge-opacity')) {
      for (const [index, opacity] of [0.07, 0.15, 1].entries()) {
        assert.ok(Math.abs(drawing.labels[index].alpha - opacity) < 0.001);
        assert.ok(Math.abs(drawing.fills[index] - opacity) < 0.001);
      }
      passed.push('edge-opacity: active label background/text retain filtered edge alpha');
    }
    if (run('tab-hint')) {
      assert.match(drawing.hint || '', /Tab: leave graph/);
      assert.doesNotMatch(drawing.hint || '', /Tab: next|Shift\+Tab: prev/);
      passed.push('tab-hint: painted HUD matches native Tab exit');
    }
  }
  if (run('plan')) {
    await page.route('**/pm/list-all?type=Plan', route => route.fulfill({ json: { items: [{ id: 'plan-a', title: 'First plan' }, { id: 'plan-b', title: 'Second plan' }] } }));
    await page.route('**/pm/plan/*', route => route.fulfill({ json: { plan: { id: route.request().url().split('/').at(-1), title: 'Review plan', steps: [] } } }));
    await page.evaluate(() => (window as unknown as CanvasWindow).__app.showView('plan'));
    await page.locator('[data-plan-id="plan-a"]').waitFor();
    for (const id of ['plan-a', 'plan-b']) {
      await page.locator(`[data-plan-id="${id}"]`).click();
      const states = await page.locator('[data-plan-id]').evaluateAll(rows => rows.map(row => {
        const el = row as HTMLElement;
        return { id: el.dataset.planId, bg: el.style.background, color: el.style.color, painted: getComputedStyle(el).backgroundColor, parent: getComputedStyle(el.parentElement!).backgroundColor };
      }));
      for (const entry of states) {
        assert.equal(entry.bg, entry.id === id ? 'var(--pm-stamp-wash)' : '');
        assert.equal(entry.color, entry.id === id ? 'var(--pm-stamp)' : '');
        if (entry.id === id) assert.notEqual(entry.painted, entry.parent);
      }
    }
    await capture?.('plan-selected');
    await page.unroute('**/pm/list-all?type=Plan');
    await page.unroute('**/pm/plan/*');
    passed.push('plan: distinct selected ink/wash and both cleared on previous row');
  }
  console.log(`Round 3 cases passed: ${passed.join('; ')}`);
  return passed;
}

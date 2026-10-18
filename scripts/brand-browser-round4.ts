import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { GraphCanvas, CanvasNode } from '../public/src/views/graph-canvas.ts';
import type { AppBridge } from '../public/src/app.ts';
import { auditTextContrast } from './brand-browser-contrast.ts';

interface ReviewNode { id: string; x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null; color: string }
interface InspectCanvas {
  nodes: ReviewNode[]; settleTimer: ReturnType<typeof setTimeout> | null; settleWorker: Worker | null;
  filter: { selectedId: string | null }; initialFitDone: boolean; canvas: HTMLCanvasElement; tx: number; ty: number; scale: number;
  draw: () => void; recolorNodes: () => void; beginPointerDrag: (x: number, y: number, cursor: boolean) => void;
  handleDragMove: (x: number, y: number, dx: number, dy: number, threshold: number, clear: boolean) => boolean;
  endNodeDrag: () => boolean;
}
interface ReviewWindow extends Window { __round4Canvas: typeof GraphCanvas; __round4Graph: GraphCanvas; __round4Latest: GraphCanvas; __app: AppBridge }

/** Capture the actual routed canvas only after its worker and initial fit finish. */
async function captureSettledGraph(page: Page, name: string, capture: (name: string) => Promise<void>): Promise<void> {
  await page.waitForFunction(() => { const graph = (window as unknown as ReviewWindow).__round4Latest as unknown as InspectCanvas; return graph.initialFitDone && graph.settleTimer === null && graph.settleWorker === null; });
  await capture(name);
}

/** Exercise real production browser paths for the fourth review round. */
export async function checkRound4(page: Page, only: string, capture: (name: string) => Promise<void>): Promise<string[]> {
  const passed: string[] = [];
  const run = (name: string): boolean => only === 'round4' || only === `round4-${name}`;
  if (run('locale')) {
    for (const [locale, label] of [['en', 'Open navigation and account actions'], ['de', 'Navigation und Kontoaktionen öffnen'], ['es', 'Abrir navegación y acciones de la cuenta'], ['zh', '打开导航和账户操作']]) {
      await page.evaluate(locale => (window as unknown as ReviewWindow).__app.changeLanguage(locale), locale);
      assert.equal(await page.locator('#user-avatar').getAttribute('aria-label'), label);
      assert.equal(await page.locator('#user-avatar').textContent(), 'M', 'Localization must preserve the icon');
    }
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.changeLanguage('en'));
    await page.locator('#user-avatar').click();
    await capture('account-actions');
    await page.keyboard.press('Escape');
    passed.push('locale: account action name follows all four shipped locales');
  }
  await page.addScriptTag({ type: 'module', content: "import { GraphCanvas } from '/src/views/graph-canvas.js'; window.__round4Canvas = GraphCanvas;" });
  await page.waitForFunction(() => !!(window as unknown as ReviewWindow).__round4Canvas);
  if (run('settle') || run('drag') || run('palette')) {
    const initial = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'round4-host'; host.style.cssText = 'position:fixed;left:10px;top:100px;width:300px;height:300px;z-index:99999'; document.body.append(host);
      (window as unknown as ReviewWindow).__round4Graph = new (window as unknown as ReviewWindow).__round4Canvas(host, { onSelectNode() {}, onOpenNode() {}, onContextMenu() {} });
      const nodes: CanvasNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `r4-${i}`, label: `Item ${i}`, lane: 'item', type: 'Task', status: 'open', degree: 2, tags: [`tag-${i % 3}`] }));
      (window as unknown as ReviewWindow).__round4Graph.setData(nodes, nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id, type: 'DEPENDS_ON' })));
      const inspect = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas;
      return { scheduled: inspect.settleTimer !== null || inspect.settleWorker !== null, fitted: inspect.initialFitDone };
    });
    if (run('settle')) {
      assert.equal(initial.scheduled, true, 'setData must schedule an initial force settle');
      assert.equal(initial.fitted, false, 'Force fit must wait for the worker');
    }
    await page.waitForFunction(() => {
      const graph = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas;
      return graph.settleTimer === null && graph.settleWorker === null;
    });
    if (run('settle')) {
      assert.equal(await page.evaluate(() => ((window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas).initialFitDone), true, 'Worker completion fits the initial result');
      const cancellation = await page.evaluate(async () => {
        const graph = (window as unknown as ReviewWindow).__round4Graph;
        const inspect = graph as unknown as InspectCanvas;
        const nodes: CanvasNode[] = Array.from({ length: 300 }, (_, i) => ({ id: `restart-${i}`, label: `Restart ${i}`, lane: 'item', type: 'Task', status: 'open', degree: 1 }));
        graph.setData(nodes, []);
        await new Promise<void>(resolve => { const poll = (): void => { if (inspect.settleWorker) resolve(); else setTimeout(poll, 1); }; poll(); });
        const stale = inspect.settleWorker!;
        const lifecycle = { stopped: false };
        stale.terminate = new Proxy(stale.terminate, { apply(target, receiver, args) { lifecycle.stopped = true; return Reflect.apply(target, receiver, args); } });
        graph.setData(nodes.slice(0, 3), []);
        const restarted = inspect.settleTimer !== null;
        // A queued stale result cannot corrupt the replacement data.
        stale.onmessage?.call(stale, new MessageEvent('message', { data: [{ x: 99999, y: 99999 }] }));
        const staleIgnored = inspect.nodes.every(node => node.x !== 99999);
        graph.setLayout('hierarchical');
        const hierarchyCanceled = inspect.settleTimer === null && inspect.settleWorker === null;
        const early = new (window as unknown as ReviewWindow).__round4Canvas(document.getElementById('round4-host')!, { onSelectNode() {}, onOpenNode() {}, onContextMenu() {} });
        const earlyState = early as unknown as InspectCanvas;
        early.setData([], []);
        await new Promise<void>(resolve => { const poll = (): void => { if (earlyState.settleTimer === null && earlyState.settleWorker === null) resolve(); else setTimeout(poll, 1); }; poll(); });
        const emptyDidNotFit = !earlyState.initialFitDone;
        early.setData(nodes.slice(0, 3), []);
        early.setLayout('hierarchical');
        const earlyHierarchyFitted = earlyState.initialFitDone && earlyState.settleTimer === null && earlyState.settleWorker === null;
        early.destroy();
        return { terminated: lifecycle.stopped, restarted, staleIgnored, hierarchyCanceled, emptyDidNotFit, earlyHierarchyFitted };
      });
      assert.deepEqual(cancellation, { terminated: true, restarted: true, staleIgnored: true, hierarchyCanceled: true, emptyDidNotFit: true, earlyHierarchyFitted: true });
      passed.push('settle: initial worker, delayed fit, replacement restart, stale rejection, empty data and early hierarchical fit');
    }
    if (run('drag')) {
      await page.evaluate(() => (window as unknown as ReviewWindow).__round4Graph.setLayout('force'));
      await page.waitForFunction(() => { const g = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas; return g.settleTimer === null && g.settleWorker === null; });
      const touch = await page.context().newCDPSession(page);
      try {
        for (const input of ['mouse', 'touch']) {
          await page.evaluate(() => (window as unknown as ReviewWindow).__round4Graph.fitView());
          await page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); }); }));
          const start = await page.evaluate(() => {
            const graph = (window as unknown as ReviewWindow).__round4Graph;
            const inspect = graph as unknown as InspectCanvas;
            const node = inspect.nodes[0], rect = inspect.canvas.getBoundingClientRect();
            node.vx = 9; node.vy = 7;
            graph.reheat(); // The gesture must cancel this pending worker request.
            return { x: Math.round(rect.left + node.x * inspect.scale + inspect.tx), y: Math.round(rect.top + node.y * inspect.scale + inspect.ty) };
          });
          if (input === 'mouse') { await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 40, start.y + 25, { steps: 5 }); }
          else {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y }] });
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + 40, y: start.y + 25 }] });
          }
          const drag = await page.evaluate(start => {
            const graph = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas;
            const node = graph.nodes[0], rect = graph.canvas.getBoundingClientRect();
            return { dx: rect.left + node.x * graph.scale + graph.tx - start.x, dy: rect.top + node.y * graph.scale + graph.ty - start.y, vx: node.vx, vy: node.vy, canceled: graph.settleTimer === null && graph.settleWorker === null, x: node.x, y: node.y };
          }, start);
          assert.ok(Math.abs(drag.dx - 40) < .01 && Math.abs(drag.dy - 25) < .01, `Real ${input} dragging must move the painted node immediately: ${JSON.stringify({ start, drag })}`);
          assert.equal(drag.vx, 0); assert.equal(drag.vy, 0); assert.equal(drag.canceled, true);
          if (input === 'mouse') await page.mouse.up();
          else await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForTimeout(100);
          const released = await page.evaluate(() => { const node = ((window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas).nodes[0]; return { x: node.x, y: node.y, released: node.fx === null && node.fy === null }; });
          assert.deepEqual(released, { x: drag.x, y: drag.y, released: true }, `${input} release must retain its final position`);
        }
        const panStart = await page.evaluate(() => { const g = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas; const r = g.canvas.getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5, tx: g.tx, ty: g.ty }; });
        await page.mouse.move(panStart.x, panStart.y); await page.mouse.down();
        await page.mouse.move(panStart.x + 12, panStart.y + 13); await page.mouse.up();
        const panEnd = await page.evaluate(() => { const g = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas; return { tx: g.tx, ty: g.ty }; });
        assert.deepEqual(panEnd, { tx: panStart.tx + 12, ty: panStart.ty + 13 }, 'Empty-canvas panning remains available');
        const target = await page.evaluate(() => { const g = (window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas; const n = g.nodes[0], r = g.canvas.getBoundingClientRect(); return { id: n.id, x: r.left + n.x * g.scale + g.tx, y: r.top + n.y * g.scale + g.ty }; });
        await page.mouse.click(target.x, target.y);
        assert.equal(await page.evaluate(() => ((window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas).filter.selectedId), target.id, 'Click selects without moving the node');
        await page.keyboard.press('Escape');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => ((window as unknown as ReviewWindow).__round4Graph as unknown as InspectCanvas).filter.selectedId), target.id, 'Arrow keys still select nodes');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#round4-host canvas').evaluate(el => el === document.activeElement), false);
      } finally { await touch.detach(); }
      passed.push('drag: real mouse and single-touch gestures move nodes, retain release positions and cancel pending settling; pan, click and keyboard remain available (issue 218)');
    }
    if (run('palette')) {
      const cost = await page.evaluate(() => {
        const graph = (window as unknown as ReviewWindow).__round4Graph;
        graph.setFilter({ colorMode: 'tag' });
        const inspect = graph as unknown as InspectCanvas;
        let recolors = 0, lookups = 0;
        const recolor = inspect.recolorNodes.bind(graph);
        inspect.recolorNodes = () => { recolors++; recolor(); };
        const original = CSSStyleDeclaration.prototype.getPropertyValue;
        CSSStyleDeclaration.prototype.getPropertyValue = function(property: string): string { if (property.startsWith('--pm-')) lookups++; return original.call(this, property); };
        const theme = document.documentElement.dataset.theme;
        try {
          inspect.draw(); // warm up tokens used by this view
          lookups = 0;
          for (let i = 0; i < 20; i++) inspect.draw();
          const steady = { recolors, lookups };
          const old = inspect.nodes[0].color;
          document.documentElement.dataset.theme = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark';
          inspect.draw();
          const changed = { recolors, lookups, colorChanged: old !== inspect.nodes[0].color };
          graph.setFilter({ colorMode: 'type' });
          return { steady, changed, filterRecolors: recolors };
        } finally { CSSStyleDeclaration.prototype.getPropertyValue = original; document.documentElement.dataset.theme = theme; }
      });
      assert.deepEqual(cost.steady, { recolors: 0, lookups: 0 }, 'Steady frames must reuse node colors and resolved CSS tokens');
      assert.equal(cost.changed.recolors, 1); assert.equal(cost.changed.colorChanged, true); assert.ok(cost.changed.lookups > 0);
      assert.equal(cost.filterRecolors, 2);
      passed.push(`palette: 20 steady frames, zero recolors/lookups; theme and mode invalidate once (${JSON.stringify(cost)})`);
    }
    await page.evaluate(() => { (window as unknown as ReviewWindow).__round4Graph.destroy(); document.getElementById('round4-host')?.remove(); });
    await page.evaluate(() => {
      const prototype = (window as unknown as ReviewWindow).__round4Canvas.prototype;
      const original = prototype.setData;
      prototype.setData = function(...args: Parameters<GraphCanvas['setData']>): void { original.apply(this, args); (window as unknown as ReviewWindow).__round4Latest = this; };
      (window as unknown as ReviewWindow).__app.showView('graph');
    });
    await page.locator('#graph-canvas-host canvas').waitFor();
    await captureSettledGraph(page, 'graph', capture);
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.openItemDetail('note-1'));
    await page.locator('#item-detail-modal .tab').filter({ hasText: 'Graph' }).click();
    await page.locator('#local-graph-canvas canvas').waitFor();
    await captureSettledGraph(page, 'detail-graph', capture);
    await page.keyboard.press('Escape');
  }
  if (run('opacity')) {
    // Include a nested opaque child: multiplying every fill's alpha separately
    // would leak the parent's black fill through the child's white fill.
    for (const nested of [false, true]) {
      await page.evaluate(nested => {
        const root = document.createElement('div'); root.id = 'round4-opacity'; root.style.cssText = 'position:fixed;inset:0;background:white';
        const group = document.createElement('div'); group.style.cssText = 'opacity:.5;background:black';
        const text = document.createElement('span'); text.id = 'opacity-probe'; text.textContent = 'Faded ink'; text.style.cssText = `color:${nested ? 'black' : 'white'};background:${nested ? 'white' : 'transparent'};font:16px sans-serif`;
        group.append(text); root.append(group); document.body.append(root);
      }, nested);
      const audit = await auditTextContrast(page);
      assert.ok(audit.failures.some(failure => failure.startsWith('opacity-probe:') && failure.includes('3.98:1')), `Opacity groups must report the painted failing ratio: ${JSON.stringify(audit.failures)}`);
      await page.evaluate(() => document.getElementById('round4-opacity')?.remove());
    }
    passed.push('opacity: own and nested opaque backgrounds composite as CSS opacity groups (3.98:1 fails AA)');
  }
  console.log(`Round 4 cases passed: ${passed.join('; ')}`);
  return passed;
}

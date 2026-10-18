/** Behavioral acceptance for the owner correction and fifth review round. */
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { auditTextContrast } from './brand-browser-contrast.ts';
import type { AppBridge } from '../public/src/app.ts';
interface ReviewWindow extends Window { __app: AppBridge }
type CaptureReview = (name: string) => Promise<void>;

/** Exercise full chip labels, titled headers, disabled outlines and observer work in a real browser. */
export async function checkRound5(page: Page, only: string, capture: CaptureReview): Promise<string[]> {
  const passed = new Array<string>();
  const run = (name: string): boolean => ['round5', `round5-${name}`].includes(only);
  if (run('facets')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('graph'));
    await page.locator('.graph-preset-btn').first().waitFor();
    const facets = await page.locator('.graph-preset-btn').evaluateAll(buttons => buttons.map(button => ({
      label: button.querySelector('span')!.textContent!, name: button.getAttribute('aria-label'), tooltip: button.getAttribute('title'),
      clipped: [...button.querySelectorAll<HTMLElement>('span,strong')].some(el => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis'),
    })));
    assert.equal(facets.length, 6);
    for (const facet of facets) {
      assert.equal(facet.clipped, false, `Facet must show complete words: ${facet.label}`);
      assert.ok(facet.name?.startsWith(facet.label)); assert.equal(facet.tooltip, facet.label);
    }
    await page.waitForTimeout(1200);
    await capture('graph');
    passed.push('facets: six full labels with accessible names and tooltips, no clipping');
  }
  if (run('header') || run('disabled')) {
    await page.evaluate(() => (window as unknown as ReviewWindow).__app.openItemDetail('note-1'));
    await page.locator('.item-detail-title').waitFor();
    if (run('header')) {
      const header = page.locator('#item-detail-modal .modal-header');
      await header.getByRole('heading', { name: 'Make the next step clear', exact: true }).waitFor();
      assert.match(await header.locator('.item-detail-id').textContent() || '', /note-1 · Feature · P0/);
      assert.match(await header.locator('.item-detail-id').evaluate(el => getComputedStyle(el).fontFamily), /Martian Mono/);
      await capture('detail-open');
      await page.locator('#item-detail-modal .tab').filter({ hasText: 'Graph' }).click();
      await page.locator('#local-graph-canvas canvas').waitFor();
      await page.locator('#local-graph-canvas').scrollIntoViewIfNeeded();
      assert.equal(await header.getByRole('heading', { name: 'Make the next step clear', exact: true }).isVisible(), true);
      await capture('detail-graph');
      passed.push('header: title heading and mono id/type/priority remain visible on graph tab');
    }
    if (run('disabled')) {
      const button = page.locator('[data-item-action="pause"]');
      assert.equal(await button.getAttribute('aria-disabled'), 'true');
      const css = await button.evaluate(el => { const css = getComputedStyle(el); return { fill: css.backgroundColor, border: css.borderStyle, opacity: css.opacity, color: css.color }; });
      assert.equal(css.fill, 'rgba(0, 0, 0, 0)', 'Disabled controls keep the surrounding sheet with a muted outline');
      assert.equal(css.border, 'solid'); assert.equal(css.opacity, '1');
      await button.focus(); await page.keyboard.press('Enter');
      assert.equal(await button.getAttribute('aria-disabled'), 'true');
      passed.push('disabled: transparent fill, muted outline, full contrast and keyboard action suppression');
    }
    await page.keyboard.press('Escape');
  }
  if (run('health')) {
    for (const [score, token, label] of [[49, '--pm-danger', 'Needs repair'], [50, '--pm-graphite', 'Needs attention'], [79, '--pm-graphite', 'Needs attention'], [80, '--pm-stamp', 'Healthy']] as const) {
      await page.route('**/api/projects/*/pm/health', route => route.fulfill({ json: { health: { score, issues: score < 80 ? [{ message: 'Review the outstanding context and link its evidence.' }] : [] } } }));
      await page.evaluate(() => (window as unknown as ReviewWindow).__app.showView('health'));
      await page.waitForFunction(score => document.querySelector('.health-score-number')?.textContent === String(score), score);
      const number = page.locator('.health-score-number');
      assert.equal(await number.evaluate((el, token) => el.style.color, token), `var(${token})`);
      assert.match(await page.locator('.health-score-label').textContent() || '', new RegExp(label));
      if (score === 50) await capture('health-warning');
      await page.unroute('**/api/projects/*/pm/health');
    }
    passed.push('health: 49/50/79/80 boundaries use danger/graphite/stamp and explicit state labels');
  }
  if (run('contrast')) {
    await page.evaluate(() => {
      const probe = document.createElement('span'); probe.id = 'round5-transparent'; probe.textContent = 'Invisible source';
      probe.style.cssText = 'opacity:0;background:white;color:white;position:fixed;top:0'; document.body.append(probe);
    });
    const audit = await auditTextContrast(page);
    assert.equal(audit.failures.some(failure => failure.startsWith('round5-transparent:')), false, 'Fully transparent source text is not painted');
    await page.evaluate(() => document.getElementById('round5-transparent')?.remove());
    passed.push('contrast: fully transparent animation sources do not create false text pairs');
  }
  if (run('observer')) {
    const observerPage = await page.context().newPage();
    await observerPage.goto(new URL('/terms.html', page.url()).href);
    await observerPage.setContent('<main class="content-area"><button>Fixture action</button></main><div id="gc-tooltip"></div>');
    await observerPage.addScriptTag({ type: 'module', content: `import { initInteractions } from '${new URL('/src/interactions.js', page.url()).href}'; initInteractions(); window.fixtureReady = true;` });
    await observerPage.waitForFunction(() => Boolean((window as unknown as { fixtureReady?: boolean }).fixtureReady));
    const counts = await observerPage.evaluate(async () => {
      const tooltip = document.getElementById('gc-tooltip')!;
      const originalQuery = document.querySelectorAll;
      const originalFrame = window.requestAnimationFrame;
      const callbacks: FrameRequestCallback[] = [];
      let queries = 0;
      document.querySelectorAll = function<E extends Element = Element>(selectors: string): NodeListOf<E> {
        if (selectors === '.modal-backdrop') queries++;
        return originalQuery.call(this, selectors) as NodeListOf<E>;
      };
      window.requestAnimationFrame = callback => { callbacks.push(callback); return 0; };
      const probe = document.createElement('div');
      try {
        tooltip.innerHTML = '<span>Fixture hover</span>';
        await new Promise(resolve => { setTimeout(resolve, 0); });
        tooltip.firstChild!.textContent = 'Fixture hover updated';
        await new Promise(resolve => { setTimeout(resolve, 0); });
        const tooltipQueries = queries, tooltipFrames = callbacks.length;
        document.body.append(probe);
        await new Promise(resolve => { setTimeout(resolve, 0); });
        probe.style.display = 'block';
        await new Promise(resolve => { setTimeout(resolve, 0); });
        const beforeFrame = queries, scheduled = callbacks.length;
        callbacks.splice(0).forEach(callback => callback(performance.now()));
        return { tooltipQueries, tooltipFrames, beforeFrame, scheduled, afterFrame: queries };
      } finally {
        document.querySelectorAll = originalQuery; window.requestAnimationFrame = originalFrame;
        tooltip.remove(); probe.remove();
      }
    });
    assert.deepEqual(counts, { tooltipQueries: 0, tooltipFrames: 0, beforeFrame: 0, scheduled: 1, afterFrame: 1 }, 'Tooltip-only mutations do no enhancement work; relevant batches share one frame');
    await observerPage.close();
    passed.push('observer: tooltip-only child/text changes ignored; two relevant batches enhanced once per frame');
  }
  console.log(`Round 5 cases passed: ${passed.join('; ')}`);
  return passed;
}

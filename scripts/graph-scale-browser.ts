/** Local-only graph measurements and screenshots from production canvas/card modules and a real non-git tracker. */
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, loadavg } from 'node:os';
import path from 'node:path';
import { transform } from 'esbuild';
import { chromium } from 'playwright-core';
import { create, init, listAllComplete } from '@unbrained/pm-cli/sdk';
import { PACKAGE_CATALOG, type PackageCatalogEntry } from '../src/services/package-catalog.ts';
import { graphFixture } from './graph-scale-fixture.ts';
import type { GraphCanvas } from '../public/src/views/graph-canvas.ts';
import type { SettleRequest } from '../public/src/views/graph-physics.ts';

/** Private browser inspection never changes the public graph interface. */
interface GraphWindow extends Window {
  __scaleGraph: GraphCanvas;
  Canvas: typeof GraphCanvas;
  renderCard: (row: unknown) => string;
}
const output = process.env.GRAPH_EVIDENCE;
assert.ok(output, 'Set GRAPH_EVIDENCE to an external evidence directory');
const phase = process.env.GRAPH_PHASE ?? 'after';
assert.ok(['before', 'after'].includes(phase));
const counts = (process.env.GRAPH_COUNTS ?? '500,2000,5000,10000').split(',').map(Number);
assert.ok(counts.every(count => Number.isSafeInteger(count) && count > 0 && count <= 10000));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-graph-browser-'));
const staticRoot = path.join(scratch, 'public');
const workspace = path.join(scratch, 'tracker');
await mkdir(workspace);
const client = { cwd: workspace, pmRoot: path.join(workspace, '.agents/pm'), noExtensions: true };
// Seed and read via the real pinned SDK. No repository, hosted data, or SDK mocks.
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = scratch;
await init('scale', { defaults: true, mergeFence: false, agentGuidance: 'skip' }, client);
for (let i = 0; i < 16; i++) await create({ title: `Graph review task ${i + 1}`, type: 'Task', allowDuplicate: true }, client);
const seeded = await listAllComplete({}, client);
assert.ok(seeded.items.length >= 16);
if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
await cp('public', staticRoot, { recursive: true });
let catalog: readonly PackageCatalogEntry[] = PACKAGE_CATALOG;
if (phase === 'before') {
  for (const name of ['graph-physics', 'graph-canvas']) {
    const source = execFileSync('git', ['show', `${process.env.GRAPH_BASE_REF ?? 'origin/main'}:public/src/views/${name}.ts`], { encoding: 'utf8' });
    const result = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    await writeFile(path.join(staticRoot, `src/views/${name}.js`), result.code);
  }
  const source = execFileSync('git', ['show', `${process.env.GRAPH_BASE_REF ?? 'origin/main'}:src/services/package-catalog.ts`], { encoding: 'utf8' });
  const filename = path.join(scratch, 'catalog-before.mjs');
  await writeFile(filename, (await transform(source, { loader: 'ts', format: 'esm' })).code);
  // Read the historical catalog as JSON through a child; avoid a second SDK loader.
  catalog = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import { PACKAGE_CATALOG } from ${JSON.stringify(filename)};console.log(JSON.stringify(PACKAGE_CATALOG));`], { encoding: 'utf8' })) as PackageCatalogEntry[];
}
const app = express();
app.get('/review', (_req, res) => res.type('html').send(`<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/styles.css"><style>body{margin:0}header{padding:16px 24px}#graph{height:810px;width:1440px}#packages{padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:20px}</style></head><body><header><h1>Project graph</h1><p id="caption">Synthetic tracker · local browser review</p></header><div id="graph"></div><section id="packages"></section><script type="module">import {GraphCanvas} from '/src/views/graph-canvas.js';import {renderPackageCard} from '/src/views/packages.js';window.Canvas=GraphCanvas;window.renderCard=renderPackageCard;</script></body></html>`));
app.use(express.static(staticRoot));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
const results: unknown[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(1_800_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/review`);
  await page.waitForFunction(() => Boolean((window as unknown as GraphWindow).Canvas));
  for (const count of counts) {
    const fixture = graphFixture(count);
    for (const [i, node] of fixture.nodes.entries()) node.label = `${seeded.items[i % seeded.items.length].title} · ${i + 1}`;
    const result = await page.evaluate(async (request: SettleRequest) => {
      const w = window as unknown as GraphWindow;
      w.__scaleGraph?.destroy();
      const host = document.getElementById('graph')!;
      host.replaceChildren();
      const graph = new w.Canvas(host, { onSelectNode() {}, onOpenNode() {}, onContextMenu() {} });
      w.__scaleGraph = graph;
      const inspect = graph as unknown as { nodes: { x: number; y: number }[]; settleWorker: Worker | null; settleTimer: ReturnType<typeof setTimeout> | null; initialFitDone: boolean };
      const frames: number[] = [], inputDelays: number[] = [];
      let previousFrame = performance.now(), nextInput = previousFrame + 50, frame = 0;
      const animate = (now: number): void => { frames.push(now - previousFrame); previousFrame = now; frame = requestAnimationFrame(animate); };
      frame = requestAnimationFrame(animate);
      const input = setInterval(() => { inputDelays.push(Math.max(0, performance.now() - nextInput)); nextInput = performance.now() + 50; }, 50);
      const start = performance.now();
      graph.setData(request.nodes, request.edges.map(edge => ({ from: edge.source.id, to: edge.target.id, type: 'DEPENDS_ON' })));
      const setDataMs = performance.now() - start;
      const before = inspect.nodes.map(node => [node.x, node.y]);
      let staticUntilDone = true;
      await new Promise<void>((resolve, reject) => {
        const poll = (): void => {
          if (inspect.settleWorker || inspect.settleTimer) {
            staticUntilDone &&= inspect.nodes.every((node, i) => node.x === before[i][0] && node.y === before[i][1]);
            if (performance.now() - start > 1_800_000) { reject(new Error('Worker deadline')); return; }
            setTimeout(poll, 25);
          } else resolve();
        };
        poll();
      });
      const settleMs = performance.now() - start;
      clearInterval(input); cancelAnimationFrame(frame);
      const percentile = (values: number[], q: number): number => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0;
      const positions = inspect.nodes.map(node => [node.x, node.y]);
      const radius = Math.sqrt(positions.reduce((sum, [x, y]) => sum + x * x + y * y, 0) / positions.length);
      document.getElementById('caption')!.textContent = `Synthetic tracker · ${request.nodes.length.toLocaleString()} tasks · ${request.edges.length.toLocaleString()} dependencies`;
      return { count: request.nodes.length, edges: request.edges.length, setDataMs, settleMs, frameP95Ms: percentile(frames, .95), frameMaxMs: Math.max(...frames), framesOver16_7: frames.filter(ms => ms > 16.7).length, frames: frames.length, inputP95Ms: percentile(inputDelays, .95), staticUntilDone, finite: positions.every(p => p.every(Number.isFinite)), radius };
    }, fixture);
    assert.equal(result.staticUntilDone, true); assert.equal(result.finite, true);
    results.push(result);
    console.log(JSON.stringify({ phase, ...result }));
    await writeFile(path.join(output, `${phase}-browser.json`), JSON.stringify({ phase, seed: 'sunflower-2.399963', steps: 180, shape: 'chain', seededTrackerItems: seeded.items.length, node: process.version, cpuCount: cpus().length, load: loadavg(), results }, null, 2));
    if (count === 500 || count === 2000) {
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(output, `${phase}-graph-${count}.png`) });
    }
  }
  await page.evaluate((entries: readonly PackageCatalogEntry[]) => {
    const w = window as unknown as GraphWindow;
    w.__scaleGraph.destroy(); document.getElementById('graph')!.remove();
    document.querySelector('h1')!.textContent = 'Packages';
    document.getElementById('caption')!.textContent = 'Synthetic project · public package catalog';
    document.getElementById('packages')!.innerHTML = entries.map(entry => w.renderCard({ ...entry, installed: false, version: null, commands: entry.commands ?? [] })).join('');
  }, catalog);
  // The first cards include the two additions; BEFORE shows the preceding catalog.
  await page.screenshot({ path: path.join(output, `${phase}-packages.png`) });
  assert.deepEqual(errors, []);
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
}

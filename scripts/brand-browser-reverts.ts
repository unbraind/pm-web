/** Rebuild one behavioral revert at a time in an isolated copy of the public sources. */
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseForESLint } from '@babel/eslint-parser';
import { build } from 'esbuild';

const cases = [
  ['active-view', 'app.ts', 'refreshGraphData'],
  ['opener', 'components/modals.ts', 'showModal'],
  ['tags', 'live-copy.ts', 'writeField'],
  ['dedupe', 'views/dedupe.ts', 'renderDedupeAuditView'],
  ['settle', 'views/graph-canvas.ts', 'reheat'],
  ['edge-opacity', 'views/graph-canvas.ts', 'drawEdge'],
  ['tab-hint', 'views/graph-canvas.ts', 'drawHud'],
  ['legend', 'views/graph.ts', 'TYPE_COLORS_MAP'],
  ['dependency-close', 'views/graph.ts', 'showAddDependencyModal', 'showRemoveDependencyModal'],
  ['stale', 'views/items.ts', 'fetchAndRenderItems'],
  ['plan', 'views/plan.ts', 'openPlanDetail'],
];
const root = process.cwd();
const output = process.env.BRAND_REVERT_EVIDENCE;
assert.ok(output, 'Set BRAND_REVERT_EVIDENCE to an external evidence directory');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'pm-web-review-reverts-'));
await symlink(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');

interface SyntaxNode { type: string; range?: [number, number]; id?: { name?: string }; key?: { name?: string }; [key: string]: unknown }

/** Find declarations through the same TypeScript parser as the lint gate. */
function declaration(source: string, name: string): { start: number; end: number; text: string } {
  const parsed = parseForESLint(source, { requireConfigFile: false, babelOptions: { plugins: ['@babel/plugin-syntax-typescript'] }, sourceType: 'module', ecmaVersion: 'latest', range: true });
  let found: SyntaxNode | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as SyntaxNode;
    if (['FunctionDeclaration', 'MethodDefinition', 'VariableDeclarator'].includes(node.type) && (node.id?.name || node.key?.name) === name) found = node;
    Object.values(node).forEach(visit);
  };
  visit(parsed.ast);
  assert.ok(found?.range, `Missing declaration ${name}`);
  return { start: found.range[0], end: found.range[1], text: source.slice(found.range[0], found.range[1]) };
}

/** Digest production sources before and after probes to prove they stayed untouched. */
async function sourceHashes(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all([...new Set(cases.map(entry => entry[1]))].map(async file => [file, createHash('sha256').update(await readFile(path.join(root, 'public/src', file))).digest('hex')])));
}

const before = await sourceHashes();
const results: { name: string; exit: number | null; behavioralFailure: string }[] = [];
if (process.env.BRAND_REVERT_RESUME) {
  const prior = JSON.parse(await readFile(process.env.BRAND_REVERT_RESUME, 'utf8')) as { results: typeof results; before: Record<string, string>; productionUnchanged: boolean };
  assert.equal(prior.productionUnchanged, true);
  assert.deepEqual(prior.before, before, 'Resume receipts must match the current production sources');
  results.push(...prior.results);
}
try {
  for (const [name, file, ...names] of cases) {
    if (results.some(result => result.name === name)) continue;
    const publicRoot = path.join(scratch, 'public');
    await rm(publicRoot, { recursive: true, force: true });
    await cp(path.join(root, 'public'), publicRoot, { recursive: true });
    const sourcePath = path.join(publicRoot, 'src', file);
    let source = await readFile(sourcePath, 'utf8');
    const old = spawnSync('git', ['show', `${process.env.BRAND_REVERT_BASE || '58957d9'}:public/src/${file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    for (const identifier of names) {
      const current = declaration(source, identifier);
      source = source.slice(0, current.start) + declaration(old.stdout, identifier).text + source.slice(current.end);
    }
    await writeFile(sourcePath, source);
    const compiled = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(publicRoot, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
    assert.equal(compiled.status, 0, `${name}: compile failure is not behavioral evidence\n${compiled.stdout}\n${compiled.stderr}`);
    await build({ entryPoints: [path.join(publicRoot, 'src/brand.ts')], outfile: path.join(publicRoot, 'src/brand.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true });
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, ['scripts/brand-browser.ts'], { cwd: root, env: { ...process.env, BRAND_PUBLIC_ROOT: publicRoot, BRAND_QUICK: '1', BRAND_CAPTURE_ONLY: 'none', BRAND_REGRESSION_ONLY: `round3-${name}`, BRAND_SCREENSHOTS: path.join(output, name) }, encoding: 'utf8', timeout: 240000 });
    const log = `${result.stdout || ''}\n${result.stderr || ''}`;
    await writeFile(path.join(output, `${name}.log`), log);
    assert.notEqual(result.status, 0, `${name}: behavioral revert unexpectedly passed`);
    assert.ok(!result.error, `${name}: harness process failure is not behavioral evidence`);
    const behavioralFailure = log.match(/AssertionError[^\n]*|page\.(?:waitForFunction|waitForResponse|evaluate):[^\n]*|locator\.[^\n]*Timeout[^\n]*/)?.[0];
    assert.ok(behavioralFailure, `${name}: missing assertion or UI wait failure\n${log}`);
    results.push({ name, exit: result.status, behavioralFailure });
    console.log(`Behavioral revert failed as required: ${name}: ${behavioralFailure}`);
  }
} finally {
  const after = await sourceHashes();
  await writeFile(path.join(output, 'round3-revert-proofs.json'), JSON.stringify({ base: process.env.BRAND_REVERT_BASE || '58957d9', results, before, after, productionUnchanged: JSON.stringify(before) === JSON.stringify(after) }, null, 2));
  assert.deepEqual(after, before);
  await rm(scratch, { recursive: true, force: true });
}
assert.equal(results.length, 11);

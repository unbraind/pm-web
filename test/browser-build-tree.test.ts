/** Compile real baseline trees and transitive declaration fixtures with the shipped TypeScript compiler. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { archiveBrowserTree, copyBrowserTree } from '../scripts/browser-build-tree.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');
const compiler = path.join(packageRoot, 'node_modules/typescript/bin/tsc');

/** Seed a strict frontend whose external declaration also imports a sibling shared module. */
async function seedBuildTree(root: string): Promise<void> {
  for (const directory of ['public', 'dist', 'shared']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'public/tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, types: [], module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['*.ts'],
  }));
  await writeFile(path.join(root, 'public/view.ts'), "import type { Reply } from '../dist/reply.js';\nexport const reply: Reply = { state: 'selected-ref' };\n");
  await writeFile(path.join(root, 'dist/reply.d.ts'), "import type { State } from '../shared/state.js';\nexport interface Reply { state: State }\n");
  await writeFile(path.join(root, 'shared/state.d.ts'), "export type State = 'selected-ref';\n");
}

/** Run the real compiler and include its diagnostics when a baseline is incomplete. */
function compile(root: string, config = 'tsconfig.json'): void {
  const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'public', config)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `Baseline must compile before browser assertions run:\n${result.stdout}\n${result.stderr}`);
}

test('committed browser baselines compile transitive declarations from the selected ref', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-archive-test-'));
  try {
    const source = path.join(scratch, 'source');
    const destination = path.join(scratch, 'baseline');
    await seedBuildTree(source);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '--quiet'], { cwd: source, env });
    execFileSync('git', ['add', 'public', 'dist', 'shared'], { cwd: source, env });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Seed complete browser inputs'], { cwd: source, env });
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', env }).trim();
    // A newer working tree must never supply declarations for the selected commit.
    await writeFile(path.join(source, 'shared/state.d.ts'), "export type State = 'wrong-working-tree';\n");
    await symlink(path.join(packageRoot, 'node_modules'), path.join(source, 'node_modules'), 'junction');
    await archiveBrowserTree(source, destination, ref);
    compile(destination);
    assert.match(await readFile(path.join(destination, 'shared/state.d.ts'), 'utf8'), /selected-ref/);
    assert.match(await readFile(path.join(destination, 'public/view.js'), 'utf8'), /selected-ref/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('working browser copies compile external imports without a git repository or executable', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-copy-test-'));
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const source = path.join(scratch, 'source');
    const destination = path.join(scratch, 'baseline');
    await seedBuildTree(source);
    await symlink(path.join(packageRoot, 'node_modules'), path.join(source, 'node_modules'), 'junction');
    process.env.PATH = scratch;
    process.env.GIT_CEILING_DIRECTORIES = scratch;
    const client = new PmClient({ cwd: source, pmRoot: path.join(source, '.agents/pm'), author: 'fixture-agent', noExtensions: true });
    await client.init('fixture', { defaults: true, agentGuidance: 'skip' });
    await copyBrowserTree(source, destination);
    compile(destination);
    assert.match(await readFile(path.join(destination, 'shared/state.d.ts'), 'utf8'), /selected-ref/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    await rm(scratch, { recursive: true, force: true });
  }
});

test('committed baseline extraction explains its git prerequisite in a plain directory', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-no-git-test-'));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(scratch);
    await assert.rejects(archiveBrowserTree(scratch, path.join(scratch, 'baseline'), 'HEAD'), /needs a git repository; ordinary tracker and browser runtime operations still work without git/);
  } finally {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    await rm(scratch, { recursive: true, force: true });
  }
});

test('committed browser baselines stream trees larger than 64 MiB and report invalid refs', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-large-archive-test-'));
  try {
    const source = path.join(scratch, 'source');
    const destination = path.join(scratch, 'baseline');
    await mkdir(source);
    const large = await open(path.join(source, 'large-input.txt'), 'w');
    try { await large.truncate(65 * 1024 * 1024); }
    finally { await large.close(); }
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '--quiet'], { cwd: source, env });
    execFileSync('git', ['add', 'large-input.txt'], { cwd: source, env });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Seed large browser input'], { cwd: source, env });
    await symlink(path.join(packageRoot, 'node_modules'), path.join(source, 'node_modules'), 'junction');
    await archiveBrowserTree(source, destination, 'HEAD');
    assert.equal((await stat(path.join(destination, 'large-input.txt'))).size, 65 * 1024 * 1024);
    await assert.rejects(archiveBrowserTree(source, path.join(scratch, 'invalid-ref'), 'refs/heads/missing-fixture'), /git archive failed|tar extraction failed/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('working browser copies reject nested scratch destinations before copying', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-nested-copy-test-'));
  try {
    for (const destination of [scratch, path.join(scratch, 'nested', 'baseline')]) {
      await assert.rejects(copyBrowserTree(scratch, destination), /destination must be outside the source tree/);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('the checked-out feature-containing baseline compiles every browser entrypoint', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'browser-real-baseline-test-'));
  try {
    await archiveBrowserTree(packageRoot, scratch, 'HEAD');
    for (const config of ['tsconfig.json', 'tsconfig.sw.json', 'tsconfig.scripts.json']) compile(scratch, config);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('every isolated browser rebuild stages the complete tree before reverting behavior', async () => {
  for (const file of ['brand-browser-reverts.ts', 'brand-browser-round4-reverts.ts', 'brand-browser-round5-reverts.ts', 'brand-browser-round6-reverts.ts']) {
    const source = await readFile(path.join(packageRoot, 'scripts', file), 'utf8');
    assert.match(source, /await copyBrowserTree\(/, `${file} must retain dependencies outside public/`);
  }
  const inbox = await readFile(path.join(packageRoot, 'scripts/decision-inbox-browser.ts'), 'utf8');
  assert.match(inbox, /await archiveBrowserTree\(/);
});

test('push and pull_request compile the checked-out baseline and run all three browser checks', async () => {
  const workflow = parse(await readFile(path.join(packageRoot, '.github/workflows/ci.yml'), 'utf8')) as {
    on: Record<string, unknown>;
    jobs: { test: { steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] } };
  };
  assert.ok('push' in workflow.on && 'pull_request' in workflow.on);
  const steps = workflow.jobs.test.steps;
  const inbox = steps.find(step => step.run?.includes('node scripts/decision-inbox-browser.ts'));
  assert.ok(inbox);
  assert.equal(inbox.env?.INBOX_BASE_REF, '${{ github.sha }}', 'PR bases must not hide new frontend imports from baseline compilation');
  for (const command of ['node scripts/decision-inbox-browser.ts', 'node scripts/agent-context-browser.ts', 'node --test test/contract-explorer-browser.acceptance.ts']) {
    const step = steps.find(candidate => candidate.run?.includes(command));
    assert.ok(step, `Missing browser check: ${command}`);
    assert.equal(step.if, 'matrix.node-version == 26', 'Browser checks must run for both event types on Node 26');
  }
});

/** Measure a committed public tracker in an immutable non-git copy; never synthesize pending public work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAllComplete } from '@unbrained/pm-cli/sdk';
import { listDecisionInbox } from '../src/services/decision-inbox.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-public-'));
const source = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', source, '.agents/pm'], { maxBuffer: 64 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', root], { input: archive });
const pmRoot = path.join(root, '.agents', 'pm');
const files: string[] = [], directories: string[] = [];

/** Enumerate only the extracted committed tracker and retain deterministic source hashes. */
async function collect(dir: string): Promise<void> {
  directories.push(dir);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(filename); else if (entry.isFile()) files.push(filename);
  }
}

/** Hash the exact extracted source bytes without reporting their potentially identifying contents. */
async function digest(): Promise<string> {
  const hash = createHash('sha256');
  for (const filename of files.sort()) hash.update(path.relative(root, filename)).update(await readFile(filename));
  return hash.digest('hex');
}

try {
  await collect(pmRoot);
  const before = await digest();
  // The SDK may keep disposable derived indexes; committed source files are immutable.
  await mkdir(path.join(pmRoot, 'runtime'), { recursive: true });
  for (const filename of files) await chmod(filename, 0o444);
  for (const dir of directories.reverse()) await chmod(dir, 0o555);
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  const started = performance.now();
  const corpus = await listAllComplete({}, { pmRoot, cwd: root, noExtensions: true });
  const page = await listDecisionInbox(pmRoot, { limit: 20 });
  const elapsedMs = Math.round(performance.now() - started);
  if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved;
  const after = await digest();
  assert.equal(after, before, 'public tracker source bytes must remain identical');
  console.log(JSON.stringify({ repository: 'unbraind/pm-web', source, items: corpus.items.length, plans: corpus.items.filter(item => item.type === 'Plan').length, coreDecisions: corpus.items.filter(item => item.type === 'Decision').length, pendingRequests: page.total, returned: page.requests.length, jsonBytes: Buffer.byteLength(JSON.stringify(page)), elapsedMs, immutableSourceFiles: files.length, sourceSha256: before, sourceUnchanged: before === after, nonGit: true, sourceFilesReadOnly: true }, null, 2));
} finally {
  for (const dir of directories) await chmod(dir, 0o755);
  for (const filename of files) await chmod(filename, 0o644);
  await rm(root, { recursive: true, force: true });
}

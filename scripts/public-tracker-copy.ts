/** Isolate committed public tracker evidence with read-only source bytes and deterministic verification. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Non-git scratch location and immutable public provenance exposed to one read-only probe. */
export interface PublicTrackerCopy {
  cwd: string; pmRoot: string; source: string;
}

/** Extract public main, make its tracker source immutable, and verify exact hashes after a bounded probe. */
export async function withPublicTrackerCopy<T extends object>(probe: (copy: PublicTrackerCopy) => Promise<T>): Promise<T & { source: string; immutableSourceFiles: number; sourceSha256: string; sourceUnchanged: true; nonGit: true; sourceFilesReadOnly: true }> {
  let source: string;
  try { source = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Public tracker validation needs a git repository with origin/main for committed evidence; SDK context reads also work in a plain tracker.'); }
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'public-tracker-copy-'));
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const files: string[] = [], directories: string[] = [];
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  /** Enumerate only extracted committed tracker files, never an external workspace. */
  async function collect(dir: string): Promise<void> {
    directories.push(dir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(filename); else if (entry.isFile()) files.push(filename);
    }
  }
  /** Fingerprint source bytes without disclosing potentially identifying field contents. */
  async function digest(): Promise<string> {
    const hash = createHash('sha256');
    for (const filename of [...files].sort()) hash.update(path.relative(cwd, filename)).update(await readFile(filename));
    return hash.digest('hex');
  }
  try {
    const archive = execFileSync('git', ['archive', source, '.agents/pm'], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', cwd], { input: archive });
    await collect(pmRoot);
    const sourceSha256 = await digest();
    await mkdir(path.join(pmRoot, 'runtime'), { recursive: true });
    for (const filename of files) await chmod(filename, 0o444);
    for (const dir of [...directories].reverse()) await chmod(dir, 0o555);
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(cwd);
    const result = await probe({ cwd, pmRoot, source });
    assert.equal(await digest(), sourceSha256, 'public tracker source bytes must remain identical');
    return { ...result, source, immutableSourceFiles: files.length, sourceSha256, sourceUnchanged: true, nonGit: true, sourceFilesReadOnly: true };
  } finally {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved;
    for (const dir of directories) await chmod(dir, 0o755);
    for (const filename of files) await chmod(filename, 0o644);
    await rm(cwd, { recursive: true, force: true });
  }
}

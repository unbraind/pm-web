/** Stage complete browser build inputs rather than assuming every import lives in public/. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';

/** Preserve the whole selected commit, including transitive declarations outside public/. */
export async function archiveBrowserTree(source: string, destination: string, ref: string): Promise<void> {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: source, stdio: 'pipe' });
  } catch {
    throw new Error('Browser baseline extraction needs a git repository; ordinary tracker and browser runtime operations still work without git.');
  }
  await mkdir(destination, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', ref], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', destination], { input: archive });
  await symlink(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'junction');
}

/** Copy current build inputs and generated assets to an external scratch tree, without repository metadata or installed dependencies. */
export async function copyBrowserTree(source: string, destination: string): Promise<void> {
  const excluded = new Set(['.git', 'node_modules'].map(name => path.join(source, name)));
  await cp(source, destination, { recursive: true, filter: entry => !excluded.has(entry) });
  await symlink(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'junction');
}

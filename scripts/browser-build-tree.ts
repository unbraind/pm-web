/** Stage complete browser build inputs rather than assuming every import lives in public/. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Observe subprocess failures alongside the stream so failed producers cannot look like successful extraction. */
function commandExit(child: ChildProcess, command: string): Promise<void> {
  let diagnostic = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostic += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code}): ${diagnostic.trim()}`));
    });
  });
}

/** Preserve the whole selected commit, including transitive declarations outside public/. */
export async function archiveBrowserTree(source: string, destination: string, ref: string): Promise<void> {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: source, stdio: 'pipe' });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: Buffer };
    if (failure.code !== 'ENOENT' && !failure.stderr?.toString().includes('not a git repository')) throw error;
    throw new Error('Browser baseline extraction needs a git repository; ordinary tracker and browser runtime operations still work without git.', { cause: error });
  }
  await mkdir(destination, { recursive: true });
  const archive = spawn('git', ['archive', '--format=tar', ref], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain trailing archive padding through EOF instead of closing the pipe at the first end marker.
  const extract = spawn('tar', ['-x', '--ignore-zeros', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
  const tasks = [commandExit(archive, 'git archive'), commandExit(extract, 'tar extraction'), pipeline(archive.stdout, extract.stdin)];
  try { await Promise.all(tasks); }
  catch (error) {
    archive.kill(); extract.kill();
    await Promise.allSettled(tasks);
    throw error;
  }
  await symlink(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'junction');
}

/** Copy current build inputs and generated assets to an external scratch tree, without repository metadata or installed dependencies. */
export async function copyBrowserTree(source: string, destination: string): Promise<void> {
  const relative = path.relative(source, destination);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Browser working-copy destination must be outside the source tree; configure an external temporary directory.');
  }
  const excluded = new Set(['.git', 'node_modules'].map(name => path.join(source, name)));
  await cp(source, destination, { recursive: true, filter: entry => !excluded.has(entry) });
  await symlink(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'junction');
}

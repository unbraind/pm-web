/** Copy only public package inputs; exclusions apply inside the repository, never to its ancestors. */
import { cp, copyFile, symlink } from 'node:fs/promises';
import path from 'node:path';

/** Build an isolated source fixture without credentials, tracker state, dependencies or runtime caches. */
export async function copyAdmissionFixture(repo: string, sandbox: string): Promise<void> {
  const filter = (file: string) => !path.relative(repo, file).split(path.sep)
    .some(part => ['node_modules', '.git', '.agents', '.local'].includes(part) || part.startsWith('.env'));
  for (const directory of ['src', 'test', 'public', 'sql']) {
    await cp(path.join(repo, directory), path.join(sandbox, directory), { recursive: true, filter });
  }
  for (const file of ['package.json', 'manifest.json']) await copyFile(path.join(repo, file), path.join(sandbox, file));
  await symlink(path.join(repo, 'node_modules'), path.join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

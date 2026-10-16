/** Copy exact-commit brand assets into an untracked, published static build directory. */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build immutable assets and a revalidated stylesheet entry point from the dev dependency. */
export async function buildBrand(root: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
  const sha = /^github:unbraind\/pm-brand#([a-f0-9]{40})$/.exec(pkg.devDependencies['pm-brand'])?.[1];
  if (!sha || pkg.dependencies['pm-brand']) throw new Error('pm-brand must be an exact Git commit in devDependencies only');
  const source = path.join(root, 'node_modules/pm-brand');
  const output = path.join(root, 'public/brand');
  await stat(path.join(source, 'tokens.css'));
  await rm(output, { recursive: true, force: true });
  const versioned = path.join(output, sha);
  await mkdir(versioned, { recursive: true });
  const present = new Set<string>();
  for (const name of ['tokens.css', 'fonts.css', 'fonts', 'icons', 'logo']) {
    try { await stat(path.join(source, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name !== 'tokens.css') continue; throw error; }
    await cp(path.join(source, name), path.join(versioned, name), { recursive: true });
    present.add(name);
  }
  const imports = ['tokens.css', 'fonts.css'].filter(name => present.has(name)).map(name => `@import url('./${sha}/${name}');`).join('\n');
  await writeFile(path.join(output, 'assets.css'), `${imports}\n`);
  await writeFile(path.join(output, 'assets.json'), JSON.stringify({ commit: sha, assets: [...present] }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildBrand(path.resolve('.'));

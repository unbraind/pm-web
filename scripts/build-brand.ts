/** Copy exact-commit brand assets into an untracked, published static build directory. */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBrandTokens } from './brand-token-data.ts';

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
  for (const name of ['tokens.css', 'fonts.css', 'fonts', 'icons', 'logo', 'LICENSE']) {
    try { await stat(path.join(source, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name !== 'tokens.css') continue; throw error; }
    await cp(path.join(source, name), path.join(versioned, name), { recursive: true });
    present.add(name);
  }
  const imports = ['tokens.css', 'fonts.css'].filter(name => present.has(name)).map(name => `@import url('./${sha}/${name}');`).join('\n');
  await writeFile(path.join(output, 'assets.css'), `${imports}\n`);
  const css = await readFile(path.join(versioned, 'tokens.css'), 'utf8');
  const tokenData = parseBrandTokens(css);
  let tokenSource = 'compiled';
  try {
    await cp(path.join(source, 'dist/tokens.js'), path.join(versioned, 'tokens.js'));
    await cp(path.join(source, 'dist/tokens.d.ts'), path.join(versioned, 'tokens.d.ts'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    tokenSource = 'css-fallback';
    await writeFile(path.join(versioned, 'tokens.js'), `export const tokens = ${JSON.stringify(tokenData)};\n`);
    const names = Object.keys(tokenData.light).map(name => JSON.stringify(name)).join(' | ') || 'never';
    await writeFile(path.join(versioned, 'tokens.d.ts'), `export type TokenName = ${names};\nexport declare const tokens: Record<'light' | 'dark', Record<TokenName, string>>;\n`);
  }
  for (const extension of ['js', 'd.ts']) await writeFile(path.join(output, `tokens.${extension}`), `export * from './${sha}/tokens.js';\n`);
  for (const [name, asset] of Object.entries({ 'mark.svg': 'logo/mark.svg', 'mark-dark.svg': 'logo/mark-dark.svg', 'apple-touch-icon.png': 'icons/apple-touch-icon-180.png', 'favicon.svg': 'icons/favicon.svg' })) {
    try { await cp(path.join(versioned, asset), path.join(output, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const files = (await readdir(versioned, { recursive: true })).map(file => file.replaceAll(path.sep, '/'));
  const urls = files.filter(file => /\.(js|css|woff2|png|svg)$/.test(file)).map(file => `/brand/${sha}/${file}`);
  await writeFile(path.join(output, 'assets.json'), JSON.stringify({ commit: sha, assets: [...present], tokenSource, urls }, null, 2) + '\n');
  const template = path.join(root, 'public/manifest.json');
  try { await stat(template); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const manifest = JSON.parse(await readFile(template, 'utf8')) as Record<string, unknown>;
  manifest.background_color = tokenData.light.paper;
  manifest.theme_color = tokenData.light.stamp;
  const icons = files.filter(file => file.startsWith('icons/') && /\.(png|svg)$/.test(file)).map(file => {
    const size = /(?:^|\D)(192|512)(?:\D|$)/.exec(file)?.[1];
    return { src: `/brand/${sha}/${file}`, sizes: file.endsWith('.svg') ? 'any' : size ? `${size}x${size}` : undefined, type: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png', purpose: file.includes('maskable') ? 'maskable' : 'any' };
  }).filter(icon => icon.sizes);
  if (icons.length) {
    manifest.icons = icons;
    const shortcuts = manifest.shortcuts as { icons?: unknown }[] | undefined;
    shortcuts?.forEach(shortcut => { shortcut.icons = [icons[0]]; });
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildBrand(path.resolve('.'));

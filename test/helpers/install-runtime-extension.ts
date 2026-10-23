import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PmClient } from '@unbrained/pm-cli/sdk';

/** Install a local extension through the real package activation path in a plain tracker. */
export async function installExtension(pmRoot: string, client: PmClient, name: string, entry: string, capabilities: string[]): Promise<void> {
  const installed = path.join(pmRoot, 'extensions', name);
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', entry: './index.js', capabilities }));
  await writeFile(path.join(installed, 'index.js'), `export { default } from ${JSON.stringify(pathToFileURL(path.resolve(entry)).href)};`);
  await client.packageActivate(name, { project: true });
}

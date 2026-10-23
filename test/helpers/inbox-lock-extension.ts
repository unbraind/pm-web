import { open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionApi } from '@unbrained/pm-cli/sdk';

/** Provide a real file lock whose cleanup reports failure after removing its owned file. */
function activate(api: ExtensionApi): void {
  api.registerService('lock_acquire', async context => {
    const payload = context.payload as { id: string; pm_root: string };
    if (!payload.id.startsWith('web-inbox-')) return { handled: false };
    const lockPath = path.join(payload.pm_root, 'locks', `${payload.id}.fault-lock`);
    const handle = await open(lockPath, 'wx');
    return { handled: true, result: async () => {
      await handle.close();
      await rm(lockPath);
      await writeFile(path.join(payload.pm_root, 'release-fault-observed'), 'Owned lock removed; cleanup failed.');
      throw new Error('Synthetic lock provider release failure');
    } };
  });
}

export default { activate };

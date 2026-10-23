import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';

/** Initialize one real SDK tracker shared by explorer, route and browser fixtures. */
export async function createPlainContractTracker(cwd: string): Promise<{ client: PmClient; pmRoot: string }> {
  const pmRoot = path.join(cwd, '.agents', 'pm');
  await mkdir(cwd, { recursive: true });
  const client = new PmClient({ pmRoot, author: 'contract-test', noExtensions: true, cwd });
  await client.init('contract', { defaults: true, agentGuidance: 'skip' });
  return { client, pmRoot };
}

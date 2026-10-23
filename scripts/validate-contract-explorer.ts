/** Measure read-only inspection of a public tracker copy; the caller supplies a plain non-git directory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { directoryContractAdapter, exploreContracts, reviewContract } from '../src/contract-explorer.ts';

/** Hash durable source records without SDK runtime caches or installed package material. */
async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['runtime', 'search', 'locks', 'extensions'].includes(entry.name)) continue;
    hash.update(entry.name); const file = path.join(root, entry.name);
    hash.update(entry.isDirectory() ? await fingerprint(file) : await readFile(file));
  }
  return hash.digest('hex');
}
const cwd = path.resolve(process.argv[2]), pmRoot = path.join(cwd, '.agents', 'pm');
const before = await fingerprint(pmRoot), start = performance.now();
const client = new PmClient({ cwd, pmRoot, noExtensions: true });
const corpus = await client.listAllComplete({ includeBody: false });
const adapter = directoryContractAdapter({ cwd, pmRoot, noExtensions: true });
const first = await exploreContracts(adapter), counts = { available: 0, unsupported: 0, unavailable: 0 };
let pages = 0;
for (let offset: number | null = 0; offset !== null;) {
  const page = await exploreContracts(adapter, { offset }); pages++;
  for (const operation of page.operations) counts[operation.status]++;
  offset = page.nextOffset;
}
const id = corpus.items[0]?.id; assert.ok(id, 'Public copy must contain real source records.');
const preview = await reviewContract(adapter, 'delete', { id }, 'edit');
assert.equal(preview.executed, false); assert.equal(preview.validated, false);
assert.equal(await fingerprint(pmRoot), before);
console.log(JSON.stringify({ sourceItems: corpus.items.length, totalOperations: first.total, pages, pageSize: first.operations.length, firstPageJsonBytes: Buffer.byteLength(JSON.stringify(first)), counts, elapsedMs: Math.round(performance.now() - start), durableHashUnchanged: true, previewExecuted: preview.executed, noGitRequired: true }));

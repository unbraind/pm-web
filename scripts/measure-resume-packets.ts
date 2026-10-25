/** Measure authorized resume reads on an operator-provided public tracker copy without changing native state. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listAllComplete, certifyCompleteListResult, readHistoryEntries, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { buildResumePacket } from '../src/services/resume-packets.ts';
import type { AgentContextPacket } from '../src/agent-context.ts';

/** Fingerprint native inputs while excluding disposable SDK caches; never disclose source text. */
async function nativeHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['runtime', 'search', 'locks', 'extensions', 'transactions', 'checkpoints'].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(await nativeHashes(file))) hashes[`${entry.name}/${name}`] = hash;
    else if (entry.isFile()) hashes[entry.name] = createHash('sha256').update(await readFile(file)).digest('hex');
    else throw new Error('Public validation copy must contain regular files and directories only.');
  }
  return hashes;
}

const pmRoot = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Supply a read-only public tracker copy, outside a Git repository.');
const before = await nativeHashes(pmRoot);
const read = await listAllComplete({ includeBody: true }, { pmRoot, noExtensions: true });
certifyCompleteListResult(read);
const items = read.items.map(item => item.id).sort().slice(0, 20);
const counts = await Promise.all(items.map(async id => (await readHistoryEntries(getHistoryPath(pmRoot, id), id)).length));
const scope: AgentContextPacket = { id: randomUUID(), revision: randomUUID(), publisher: randomUUID(), updatedAt: new Date().toISOString(), agent: 'public-validation', question: 'Which selected public project facts changed since admission?', items, consent: true, viewers: [], receipts: [], gaps: [] };
const binding = { project: randomUUID(), principal: scope.publisher, id: scope.id, revision: scope.revision };
const start = performance.now();
const baseline = await buildResumePacket(pmRoot, binding, {}, async () => scope);
const admittedMs = performance.now() - start;
const resumedAt = performance.now();
const idle = await buildResumePacket(pmRoot, binding, { cursor: baseline.cursor }, async () => scope);
assert.equal(idle.receipt.missed, 0); assert.equal(idle.changes.length, 0); assert.ok(idle.receipt.complete);
assert.equal(baseline.receipt.baselineEvents, counts.reduce((a, b) => a + b, 0));
assert.deepEqual(await nativeHashes(pmRoot), before);
console.log(JSON.stringify({ trackerItems: read.items.length, selectedItems: items.length, selectedHistoryEvents: baseline.receipt.baselineEvents, nativeFilesUnchanged: Object.keys(before).length, admissionBytes: baseline.budget.bytes, idleBytes: idle.budget.bytes, cursorBytes: Buffer.byteLength(idle.cursor), missedEvents: idle.receipt.missed, complete: idle.receipt.complete, admissionMs: Math.round(admittedMs), idleMs: Math.round(performance.now() - resumedAt) }));

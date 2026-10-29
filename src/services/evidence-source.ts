import { constants, type BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EvidenceError, type ReadContext, type SourceSnapshot } from 'pm-evidence';

/** Match pm-evidence's persisted source operand without changing literal filenames. */
export function evidenceSourceKey(value: string): string { return value.replace(/^\.\//, ''); }
/** Apply the same reserved-path policy to linked names and actual descriptor targets. */
export function publicEvidenceSource(source: string): boolean {
  return !evidenceSourceKey(source).split('/').some(part => part.startsWith('.') || ['node_modules', 'auth.json'].includes(part.toLowerCase())) && !/(?:^|\/)(?:credentials|secrets?)(?:[./]|$)/i.test(source);
}
/** Deterministic filesystem boundaries used by adversarial tests; never populated by request data. */
export interface EvidenceReadBarriers {
  afterDiscovery?: () => Promise<void>;
  afterOpen?: () => Promise<void>;
  beforeRead?: () => Promise<void>;
  afterRead?: () => Promise<void>;
}
/** One public-safe refusal covers every pathname and inode alias without reflecting forbidden names. */
function denied(): never { throw new EvidenceError('boundary', 'Source is not allowed', 'Link an approved, single-link regular project source; remove private, external or hardlink aliases.'); }
/** Authorize a canonical object name against the selected project root before any bytes are read. */
function authorizeTarget(root: string, target: string): void {
  const name = relative(root, target);
  if (!name || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`) || !publicEvidenceSource(name)) denied();
}
/** Check the opened descriptor itself, including aliases introduced after pathname validation. */
async function descriptorTarget(handle: FileHandle, root: string): Promise<BigIntStats> {
  let target: string;
  try { target = await realpath(`/proc/self/fd/${handle.fd}`); }
  catch { throw new EvidenceError('unsupported', 'Opened-source verification is unavailable', 'Use Linux with accessible procfs and stable source files.'); }
  authorizeTarget(root, target);
  const opened = await handle.stat({ bigint: true }), located = await stat(target, { bigint: true });
  if (opened.nlink !== 1n) denied();
  if (opened.dev !== located.dev || opened.ino !== located.ino) throw new EvidenceError('race', 'Opened source changed identity', 'Retry after source paths and writers are stable.');
  return opened;
}
/** Require a readable regular file before opening or reading a potentially replaced target. */
function readable(value: BigIntStats, maxBytes: number): void {
  if (!value.isFile() || (value.mode & 0o444n) === 0n) throw new EvidenceError('inaccessible', 'Source is not a readable regular file', 'Restore source permissions or choose an approved regular file.');
  if (value.nlink !== 1n) denied();
  if (value.size > BigInt(maxBytes)) throw new EvidenceError('size', 'Source exceeds its read bound', 'Select a source within the documented inspection size limit.');
}
/** Detect replacement, content changes and alias creation through native filesystem revision coordinates. */
function unchanged(before: BigIntStats, after: BigIntStats): void {
  if ((['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const).some(key => before[key] !== after[key])) throw new EvidenceError('race', 'Source changed during inspection', 'Retry after the source writer and path changes finish.');
}
/** Supply pm-evidence with a bounded immutable snapshot of an authorized opened object, without schema writes. */
export async function readApprovedEvidence(source: string, context: ReadContext, barriers: EvidenceReadBarriers = {}): Promise<SourceSnapshot> {
  if (process.platform !== 'linux') throw new EvidenceError('unsupported', 'Opened-source policy requires Linux procfs', 'Use a backend that can authorize the opened source descriptor before reading.');
  context.signal.throwIfAborted();
  const root = await realpath(context.root), requested = resolve(root, source), canonical = await realpath(requested);
  authorizeTarget(root, canonical);
  const discovered = await stat(canonical, { bigint: true }); readable(discovered, context.maxBytes);
  await barriers.afterDiscovery?.();
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await barriers.afterOpen?.();
    const before = await descriptorTarget(handle, root); readable(before, context.maxBytes); unchanged(discovered, before);
    await barriers.beforeRead?.();
    const bytes = Buffer.alloc(context.maxBytes + 1); let used = 0;
    while (used < bytes.length) {
      context.signal.throwIfAborted();
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > context.maxBytes) throw new EvidenceError('size', 'Source grew beyond its read bound', 'Retry with a stable source within the documented size limit.');
    await barriers.afterRead?.();
    const after = await descriptorTarget(handle, root); unchanged(before, after);
    authorizeTarget(root, await realpath(requested));
    unchanged(after, await stat(requested, { bigint: true }));
    context.signal.throwIfAborted();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
    return { text, revision: createHash('sha256').update(text).digest('hex') };
  } finally { await handle.close(); }
}

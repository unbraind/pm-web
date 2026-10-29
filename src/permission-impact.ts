/** Explicit replacement of one existing grant; none proposes removal of that project scope. */
export interface PermissionProposal { shareId: string; permission: 'edit' | 'view' | 'none' }
/** A single bounded page uses identities only, with no questions, packet contents or audience sizes. */
export interface PermissionImpactInput extends PermissionProposal { offset?: number; limit?: number }
/** One caller-visible resource whose effective access would decrease. */
export interface PermissionLoss { kind: 'packet' | 'decision' | 'operation'; id: string; loss: 'read' | 'respond' | 'execute' }
/** Advisory read-time result; it cannot authorize, cache or apply a subsequent change. */
export interface PermissionImpactPage {
  protocol: 'pm-web-permission-impact/v1'; mode: 'preview'; applied: false;
  proposal: PermissionProposal; total: number; nextOffset: number | null;
  counts: { packets: number; decisions: number; operations: number };
  losses: PermissionLoss[]; unknownCapabilities: 'disabled'; remedy: string;
}
/** Stable refusals carry recovery guidance without disclosing storage or hidden scopes. */
export class PermissionImpactError extends Error {
  readonly code: 'invalid_input' | 'view_only' | 'owner_required' | 'not_found' | 'unavailable';
  readonly status: number;
  readonly remedy: string;
  /** Preserve one public-safe error contract for SDK, CLI and HTTP. */
  constructor(code: PermissionImpactError['code'], remedy: string, status: number) {
    super(code.replaceAll('_', ' ')); this.name = 'PermissionImpactError'; this.code = code; this.remedy = remedy; this.status = status;
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Refuse malformed envelopes before any read, write, token lookup or network request. */
function invalid(): never { throw new PermissionImpactError('invalid_input', 'Supply an existing share UUID, permission edit/view/none, offset 0–1000000 and limit 1–50; use only documented fields.', 400); }
/** Require a plain exact record so prototypes and transport extras cannot select a scope. */
function record(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  const row = raw as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
/** Check every numeric input and output against the same finite integer domain. */
function count(raw: unknown, max = 1000000): number { if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > max) invalid(); return raw; }
/** Canonicalize explicit project, share and authenticated principal bindings before database or network use. */
export function permissionUuid(raw: unknown): string { if (typeof raw !== 'string' || !UUID.test(raw)) invalid(); return raw.toLowerCase(); }
/** One strict schema validates proposal inputs across all transports, with canonical UUIDs. */
export function parsePermissionImpact(raw: unknown): PermissionImpactInput {
  const row = record(raw, ['shareId', 'permission'], ['offset', 'limit']);
  const shareId = permissionUuid(row.shareId);
  if (typeof row.permission !== 'string' || !['edit', 'view', 'none'].includes(row.permission)) invalid();
  const offset = row.offset === undefined ? 0 : count(row.offset), limit = row.limit === undefined ? 20 : count(row.limit, 50);
  if (limit === 0) invalid();
  return { shareId, permission: row.permission as PermissionProposal['permission'], offset, limit };
}
/** Validate produced pages and remote responses without silently accepting nonfinite or sparse data. */
export function parsePermissionImpactPage(raw: unknown): PermissionImpactPage {
  const row = record(raw, ['protocol', 'mode', 'applied', 'proposal', 'total', 'nextOffset', 'counts', 'losses', 'unknownCapabilities', 'remedy']);
  if (row.protocol !== 'pm-web-permission-impact/v1' || row.mode !== 'preview' || row.applied !== false || row.unknownCapabilities !== 'disabled' || typeof row.remedy !== 'string' || row.remedy.length < 1 || row.remedy.length > 500) invalid();
  const proposal = record(row.proposal, ['shareId', 'permission']);
  const parsed = parsePermissionImpact(proposal);
  const counts = record(row.counts, ['packets', 'decisions', 'operations']);
  const packets = count(counts.packets), decisions = count(counts.decisions), operations = count(counts.operations), total = count(row.total);
  if (packets + decisions + operations !== total || (row.nextOffset !== null && (count(row.nextOffset) === 0 || Number(row.nextOffset) >= total))) invalid();
  if (!Array.isArray(row.losses) || row.losses.length > 50 || row.losses.length > total) invalid();
  const losses: PermissionLoss[] = [];
  for (let i = 0; i < row.losses.length; i++) {
    if (!Object.hasOwn(row.losses, i)) invalid();
    const entry = record(row.losses[i], ['kind', 'id', 'loss']);
    if (typeof entry.kind !== 'string' || !['packet', 'decision', 'operation'].includes(entry.kind) || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 160 || typeof entry.loss !== 'string' || !['read', 'respond', 'execute'].includes(entry.loss) || (entry.kind === 'packet' && entry.loss !== 'read') || (entry.kind === 'operation' && entry.loss !== 'execute') || (entry.kind === 'decision' && entry.loss === 'execute')) invalid();
    losses.push(entry as unknown as PermissionLoss);
  }
  if (new Set(losses.map(entry => `${entry.kind}:${entry.id}`)).size !== losses.length) invalid();
  if (losses.filter(entry => entry.kind === 'packet').length > packets || losses.filter(entry => entry.kind === 'decision').length > decisions || losses.filter(entry => entry.kind === 'operation').length > operations) invalid();
  return { protocol: 'pm-web-permission-impact/v1', mode: 'preview', applied: false, proposal: { shareId: parsed.shareId, permission: parsed.permission }, total, nextOffset: row.nextOffset as number | null, counts: { packets, decisions, operations }, losses, unknownCapabilities: 'disabled', remedy: row.remedy };
}

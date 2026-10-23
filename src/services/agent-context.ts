import { randomUUID } from 'node:crypto';
import { pool } from '../db.ts';
import { AgentContextError, type AgentContextInput, type AgentContextPacket } from '../agent-context.ts';

/** Require bounded text and reject blank values before they enter the packet store. */
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
/** Reject ambiguous consent, malformed receipt references and oversized agent envelopes without truncation. */
export function validateAgentContext(input: unknown): AgentContextInput {
  const row = input as AgentContextInput | null;
  const issue = (entry: { reason: string; remedy: string }) => entry && text(entry.reason) && text(entry.remedy);
  const issues = (value: unknown): boolean => Array.isArray(value) && value.length <= 20 && value.every(issue);
  if (!row || row.consent !== true || !text(row.agent, 160) || !text(row.question, 2000) || !Array.isArray(row.viewers) || row.viewers.length > 20 || !row.viewers.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || new Set(row.viewers).size !== row.viewers.length || !issues(row.gaps) || !Array.isArray(row.receipts) || row.receipts.length > 20 || !row.receipts.every(receipt => receipt && ['core-output-session', 'pm-context-pack'].includes(receipt.source) && text(receipt.receiptId, 160) && text(receipt.revision, 160) && text(receipt.servedAt, 40) && Number.isFinite(Date.parse(receipt.servedAt)) && issues(receipt.omission)) || Buffer.byteLength(JSON.stringify(row), 'utf8') > 12288) {
    throw new AgentContextError('invalid_input', 'Supply explicit consent, an agent, question, up to 20 viewer UUIDs, source receipt references with revisions and timestamps, and bounded gaps with remedies; keep the packet below 12 KiB.', 400);
  }
  // Allowlist the stored projection so transport fields cannot overwrite authorization or revision bindings.
  return { agent: row.agent, question: row.question, consent: true, viewers: row.viewers, receipts: row.receipts.map(receipt => ({ source: receipt.source, receiptId: receipt.receiptId, revision: receipt.revision, servedAt: receipt.servedAt, omission: receipt.omission.map(entry => ({ reason: entry.reason, remedy: entry.remedy })) })), gaps: row.gaps.map(entry => ({ reason: entry.reason, remedy: entry.remedy })) };
}

/** Refuse hidden and absent scopes identically, including revoked snapshots. */
export function hiddenContext(): never { throw new AgentContextError('not_found', 'Ask the publisher to consent to this viewer and share the current packet revision; verify project access.', 404); }

/** List authorized metadata only; PostgreSQL applies the audience predicate before projection. */
export async function listAgentContexts(project: string, principal: string, offset = 0): Promise<{ packets: Pick<AgentContextPacket, 'id' | 'revision' | 'agent' | 'updatedAt'>[]; nextOffset: number | null; returned: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentContextError('invalid_input', 'Use the nonnegative nextOffset returned by the authorized list.', 400);
  const rows = await pool.query<{ packet: AgentContextPacket }>('SELECT packet FROM pm_agent_context WHERE project_id=$1 AND (publisher=$2 OR viewers @> ARRAY[$2]::uuid[]) ORDER BY updated_at DESC,id LIMIT 21 OFFSET $3', [project, principal, offset]);
  return { returned: Math.min(20, rows.rows.length), nextOffset: rows.rows.length > 20 ? offset + 20 : null, packets: rows.rows.slice(0, 20).map(({ packet }) => ({ id: packet.id, revision: packet.revision, agent: packet.agent, updatedAt: packet.updatedAt })) };
}

/** Retrieve only a currently consented packet in the authenticated principal's project and audience. */
export async function getAgentContext(project: string, principal: string, id: string, revision: string): Promise<AgentContextPacket> {
  const rows = await pool.query<{ packet: AgentContextPacket }>('SELECT packet FROM pm_agent_context WHERE project_id=$1 AND id=$2 AND (publisher=$3 OR viewers @> ARRAY[$3]::uuid[])', [project, id, principal]);
  const packet = rows.rows[0]?.packet;
  if (!packet) hiddenContext();
  if (packet.revision !== revision) throw new AgentContextError('revision_conflict', 'Refresh authorized packet metadata and inspect its current revision before retrieval.', 409);
  return packet;
}

/** Publish or replace an owned snapshot using one atomic compare-and-swap; revisions bind audience and evidence. */
export async function publishAgentContext(project: string, principal: string, input: unknown, binding?: { id: string; revision: string }): Promise<AgentContextPacket> {
  const data = validateAgentContext(input);
  const packet: AgentContextPacket = { ...data, id: binding?.id ?? randomUUID(), revision: randomUUID(), publisher: principal, updatedAt: new Date().toISOString() };
  if (binding) {
    const result = await pool.query('UPDATE pm_agent_context SET viewers=$1,packet=$2,updated_at=NOW() WHERE project_id=$3 AND id=$4 AND publisher=$5 AND revision=$6 RETURNING id', [data.viewers, packet, project, binding.id, principal, binding.revision]);
    if (!result.rowCount) throw new AgentContextError('revision_conflict', 'Refresh an owned packet and submit against its current revision.', 409);
  } else {
    await pool.query('INSERT INTO pm_agent_context(id,project_id,publisher,viewers,packet) VALUES($1,$2,$3,$4,$5)', [packet.id, project, principal, data.viewers, packet]);
  }
  return packet;
}

/** Delete an owned snapshot with revision fencing; removed audiences cannot retrieve or discover it again. */
export async function revokeAgentContext(project: string, principal: string, id: string, revision: string): Promise<{ revoked: true }> {
  const result = await pool.query('DELETE FROM pm_agent_context WHERE project_id=$1 AND id=$2 AND publisher=$3 AND revision=$4 RETURNING id', [project, id, principal, revision]);
  if (!result.rowCount) throw new AgentContextError('revision_conflict', 'Refresh an owned packet and revoke its current revision.', 409);
  return { revoked: true };
}

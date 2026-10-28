import path from 'node:path';
import { pool } from '../db.ts';
import { directoryContractAdapter, exploreContracts } from '../contract-explorer.ts';
import { PermissionImpactError, permissionUuid, parsePermissionImpact, parsePermissionImpactPage, type PermissionImpactPage, type PermissionLoss } from '../permission-impact.ts';
import { readProjectAccess, readProjectAccesses } from './project-access.ts';
import { getProjectDir } from './pm-runner.ts';
import { listDecisionInbox } from './decision-inbox.ts';
import { contextAudience } from './agent-context.ts';

/** Evaluate a grant replacement in a read-only SQL snapshot using live authorization's exact resolver. */
export async function previewPermissionImpact(project: string, principal: string, raw: unknown): Promise<PermissionImpactPage> {
  const input = parsePermissionImpact(raw);
  project = permissionUuid(project); principal = permissionUuid(principal);
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const access = await readProjectAccess(db, principal, project);
    if (!access) throw new PermissionImpactError('not_found', 'Select a project shared with your account.', 404);
    if (access.permission !== 'edit') throw new PermissionImpactError('view_only', 'Ask the project owner to preview the proposed share change.', 403);
    if (access.ownerUserId !== principal) throw new PermissionImpactError('owner_required', 'Only the project owner can inspect consequences of a share change.', 403);
    const share = await db.query<{ shared_with_user_id: string | null; shared_with_group_id: string | null }>('SELECT shared_with_user_id,shared_with_group_id FROM pm_project_shares WHERE project_id=$1 AND id=$2', [project, input.shareId]);
    if (!share.rowCount) throw new PermissionImpactError('not_found', 'Refresh project shares and select an existing share in this project.', 404);
    const target = share.rows[0];
    const members = target.shared_with_user_id ? [target.shared_with_user_id] : (await db.query<{ user_id: string }>('SELECT user_id FROM pm_group_members WHERE group_id=$1 ORDER BY user_id LIMIT 10001', [target.shared_with_group_id])).rows.map(row => row.user_id);
    if (members.length > 10000) throw new PermissionImpactError('unavailable', 'This group exceeds the preview limit of 10000 members; review a narrower grant.', 503);
    const beforeAccess = await readProjectAccesses(db, members, project), afterAccess = await readProjectAccesses(db, members, project, input);
    const lostRead: string[] = []; let lostWrite = false;
    for (const member of members) {
      const before = beforeAccess.get(member), after = afterAccess.get(member);
      if (before && !after) lostRead.push(member);
      if (before?.permission === 'edit' && after?.permission !== 'edit') lostWrite = true;
    }
    const losses: PermissionLoss[] = [];
    if (lostRead.length) {
      const packets = await db.query<{ id: string }>(`SELECT id FROM pm_agent_context WHERE project_id=$1
        AND ${contextAudience('$2')} AND ${contextAudience('$3')} ORDER BY id LIMIT 1000001`, [project, [principal], lostRead]);
      for (const packet of packets.rows) losses.push({ kind: 'packet', id: packet.id, loss: 'read' });
    }
    const cwd = getProjectDir(access.ownerUserId, access.slug), pmRoot = path.join(cwd, '.agents', 'pm');
    if (lostRead.length || lostWrite) {
      let offset: number | null = 0;
      do {
        const page = await listDecisionInbox(pmRoot, { offset, limit: 50 });
        losses.push(...page.requests.map(row => ({ kind: 'decision' as const, id: row.id, loss: lostRead.length ? 'read' as const : 'respond' as const })));
        offset = page.nextOffset;
      } while (offset !== null && losses.length <= 1000000);
      const directory = directoryContractAdapter({ cwd, pmRoot, noExtensions: true });
      const snapshot = await directory.describe({ availabilityOnly: true });
      const adapter = { kind: directory.kind, describe: async () => snapshot };
      offset = 0;
      do {
        const page = await exploreContracts(adapter, { offset, limit: 50 });
        for (const operation of page.operations) {
          // Extension declarations do not prove an authorization contract. Keep unknown capabilities disabled.
          if (operation.provider === 'core' && operation.status === 'available' && (lostRead.length || (lostWrite && operation.mutation))) losses.push({ kind: 'operation', id: operation.action, loss: 'execute' });
        }
        offset = page.nextOffset;
      } while (offset !== null && losses.length <= 1000000);
    }
    if (losses.length > 1000000) throw new PermissionImpactError('unavailable', 'This scope exceeds the preview resource limit; review a narrower project scope.', 503);
    losses.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const counts = { packets: 0, decisions: 0, operations: 0 };
    for (const row of losses) counts[row.kind === 'packet' ? 'packets' : row.kind === 'decision' ? 'decisions' : 'operations']++;
    const start = input.offset!, end = start + input.limit!;
    const result = parsePermissionImpactPage({ protocol: 'pm-web-permission-impact/v1', mode: 'preview', applied: false,
      proposal: { shareId: input.shareId, permission: input.permission }, total: losses.length,
      nextOffset: end < losses.length ? end : null, counts, losses: losses.slice(start, end), unknownCapabilities: 'disabled',
      remedy: 'Read-time advisory only. Refresh before a separately authorized share change; overlapping grants and packet consent still apply. Hidden resources are excluded, not counted.' });
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof PermissionImpactError) throw error;
    throw new PermissionImpactError('unavailable', 'Check tracker, decision inbox and backend capabilities, then refresh the preview.', 503);
  } finally { db.release(); }
}

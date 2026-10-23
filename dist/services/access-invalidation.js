import { pool } from '../db.js';
import { broadcastProjectEvent } from './sse.js';
/** Broadcast only a content-free access signal; the existing fanout rechecks each viewer before delivery. */
export function invalidateProjectAccess(projectId) { broadcastProjectEvent(projectId, { type: 'project-access-changed', data: {} }); }
/** Capture group-dependent project identities before membership or cascade deletion changes them. */
export async function groupAccessProjects(groupId) {
    return (await pool.query('SELECT DISTINCT project_id FROM pm_project_shares WHERE shared_with_group_id=$1', [groupId])).rows.map(row => row.project_id);
}
/** Capture all project grants a removed account can affect, without reading project content. */
export async function userAccessProjects(userId) {
    return (await pool.query(`SELECT id AS project_id FROM pm_projects WHERE user_id=$1
    UNION SELECT project_id FROM pm_project_shares WHERE shared_with_user_id=$1
    UNION SELECT ps.project_id FROM pm_project_shares ps JOIN pm_group_members gm ON gm.group_id=ps.shared_with_group_id WHERE gm.user_id=$1`, [userId])).rows.map(row => row.project_id);
}
//# sourceMappingURL=access-invalidation.js.map
import { pool } from "../db.js";
/** Read fresh owner, direct-share and group-share decisions only for this slice when principals are supplied. */
export async function projectEventViewers(projectId, userIds) {
    if (userIds?.length === 0)
        return new Set();
    const result = await pool.query(`SELECT user_id FROM pm_projects WHERE id = $1 AND ($2::uuid[] IS NULL OR user_id = ANY($2::uuid[]))
     UNION SELECT shared_with_user_id FROM pm_project_shares WHERE project_id = $1 AND shared_with_user_id IS NOT NULL
       AND ($2::uuid[] IS NULL OR shared_with_user_id = ANY($2::uuid[]))
     UNION SELECT gm.user_id FROM pm_group_members gm
       JOIN pm_project_shares ps ON ps.shared_with_group_id = gm.group_id WHERE ps.project_id = $1
       AND ($2::uuid[] IS NULL OR gm.user_id = ANY($2::uuid[]))`, [projectId, userIds ?? null]);
    return new Set(result.rows.map((row) => row.user_id));
}
/** Authorize this subscriber and read its display name in one fresh SQL snapshot, without caching grants. */
export async function projectPresenceMember(projectId, userId) {
    const result = await pool.query(`SELECT u.display_name FROM pm_users u WHERE u.id = $2 AND (
       EXISTS (SELECT 1 FROM pm_projects p WHERE p.id = $1 AND p.user_id = u.id)
       OR EXISTS (SELECT 1 FROM pm_project_shares ps WHERE ps.project_id = $1 AND ps.shared_with_user_id = u.id)
       OR EXISTS (
         SELECT 1 FROM pm_group_members gm JOIN pm_project_shares ps ON ps.shared_with_group_id = gm.group_id
         WHERE ps.project_id = $1 AND gm.user_id = u.id
       )
     )`, [projectId, userId]);
    const member = result.rows[0];
    return member ? { displayName: member.display_name?.trim() || "Project member" } : null;
}
//# sourceMappingURL=sse-access.js.map
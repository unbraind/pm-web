import { pool } from "../db.ts";

/** Read fresh owner, direct-share and group-share viewers once for a project burst. */
export async function projectEventViewers(projectId: string): Promise<ReadonlySet<string>> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM pm_projects WHERE id = $1
     UNION SELECT shared_with_user_id FROM pm_project_shares WHERE project_id = $1 AND shared_with_user_id IS NOT NULL
     UNION SELECT gm.user_id FROM pm_group_members gm
       JOIN pm_project_shares ps ON ps.shared_with_group_id = gm.group_id WHERE ps.project_id = $1`, [projectId]);
  return new Set(result.rows.map((row) => row.user_id));
}

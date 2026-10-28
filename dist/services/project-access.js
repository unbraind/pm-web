/** Resolve a bounded principal set in one query; live requests and group previews use identical grant semantics. */
export async function readProjectAccesses(db, users, projectId, proposal) {
    const result = await db.query(`WITH principals AS (SELECT unnest($2::uuid[]) AS principal), grants AS (
    SELECT u.principal,CASE WHEN ps.id=$3 THEN $4 ELSE ps.permission END AS permission
    FROM principals u JOIN pm_project_shares ps ON ps.project_id=$1 AND (
      ps.shared_with_user_id=u.principal OR ps.shared_with_group_id IN (
        SELECT group_id FROM pm_group_members WHERE user_id=u.principal))
  ) SELECT p.id,p.name,p.slug,p.description,p.prefix,p.user_id AS "ownerUserId",
    CASE WHEN p.user_id=u.principal OR EXISTS(SELECT 1 FROM grants WHERE principal=u.principal AND permission='edit') THEN 'edit' ELSE 'view' END AS permission,u.principal
    FROM pm_projects p CROSS JOIN principals u WHERE p.id=$1 AND (p.user_id=u.principal OR EXISTS(SELECT 1 FROM grants WHERE principal=u.principal AND permission IN ('edit','view')))`, [projectId, users, proposal?.shareId ?? null, proposal?.permission ?? null]);
    return new Map(result.rows.map(({ principal, ...access }) => [principal, access]));
}
/** Resolve one live request through the same authoritative effective-grant query as previews. */
export async function readProjectAccess(db, userId, projectId, proposal) {
    const principal = userId.toLowerCase();
    return (await readProjectAccesses(db, [principal], projectId, proposal)).get(principal) ?? null;
}
//# sourceMappingURL=project-access.js.map
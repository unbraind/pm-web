/** Adapt existing SQL-only route fixtures to the authoritative batched grant query. */
export function projectAccessRows(sql: string, params: unknown[] | undefined, project: { id: string; owner_user_id: string; [key: string]: unknown }, viewer?: { id: string; permission: string }): Record<string, unknown>[] | undefined {
  if (!sql.startsWith('WITH principals AS') || params?.[0] !== project.id || !Array.isArray(params[1])) return undefined;
  return params[1].flatMap((principal: unknown) => {
    const permission = principal === project.owner_user_id ? 'edit' : viewer && principal === viewer.id ? viewer.permission : undefined;
    return permission === undefined ? [] : [{ ...project, principal, ownerUserId: project.owner_user_id, permission }];
  });
}

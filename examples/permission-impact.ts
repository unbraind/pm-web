import { PermissionImpactClient, PermissionImpactError } from '@unbrained/pm-web';

/** Inspect an explicit owned scope proposal without mutating any role or context packet. */
export async function previewShare(origin: string, token: string, project: string, shareId: string): Promise<void> {
  try {
    const result = await new PermissionImpactClient(origin, token).preview(project, { shareId, permission: 'view', limit: 20 });
    console.log(JSON.stringify({ counts: result.counts, losses: result.losses, nextOffset: result.nextOffset, applied: result.applied }));
  } catch (error) {
    if (!(error instanceof PermissionImpactError)) throw error;
    console.error(`${error.code}: ${error.remedy}`);
  }
}

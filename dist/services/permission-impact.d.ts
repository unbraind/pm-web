import { type PermissionImpactPage } from '../permission-impact.ts';
/** Evaluate a grant replacement in a read-only SQL snapshot using live authorization's exact resolver. */
export declare function previewPermissionImpact(project: string, principal: string, raw: unknown): Promise<PermissionImpactPage>;

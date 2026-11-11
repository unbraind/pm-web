import type { Pool, PoolClient } from 'pg';
import type { PermissionProposal } from '../permission-impact.ts';
/** The same effective grant projection serves live requests and hypothetical share replacements. */
export interface ProjectAccess {
    id: string;
    name: string;
    slug: string;
    description: string;
    prefix: string;
    ownerUserId: string;
    permission: 'edit' | 'view';
}
/** Resolve a bounded principal set in one query; live requests and group previews use identical grant semantics. */
export declare function readProjectAccesses(db: Pool | PoolClient, users: string[], projectId: string, proposal?: PermissionProposal): Promise<Map<string, ProjectAccess>>;
/** Resolve one live request through the same authoritative effective-grant query as previews. */
export declare function readProjectAccess(db: Pool | PoolClient, userId: string, projectId: string, proposal?: PermissionProposal): Promise<ProjectAccess | null>;

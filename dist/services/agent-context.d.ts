import { type AgentContextInput, type AgentContextPacket } from '../agent-context.ts';
/** Reject ambiguous consent, malformed receipt references and oversized agent envelopes without truncation. */
export declare function validateAgentContext(input: unknown): AgentContextInput;
/** Refuse hidden and absent scopes identically, including revoked snapshots. */
export declare function hiddenContext(): never;
/** List authorized metadata only; PostgreSQL applies the audience predicate before projection. */
export declare function listAgentContexts(project: string, principal: string, offset?: number): Promise<{
    packets: Pick<AgentContextPacket, 'id' | 'revision' | 'agent' | 'updatedAt'>[];
    nextOffset: number | null;
    returned: number;
}>;
/** Retrieve only a currently consented packet in the authenticated principal's project and audience. */
export declare function getAgentContext(project: string, principal: string, id: string, revision: string): Promise<AgentContextPacket>;
/** Publish or replace an owned snapshot using one atomic compare-and-swap; revisions bind audience and evidence. */
export declare function publishAgentContext(project: string, principal: string, input: unknown, binding?: {
    id: string;
    revision: string;
}): Promise<AgentContextPacket>;
/** Delete an owned snapshot with revision fencing; removed audiences cannot retrieve or discover it again. */
export declare function revokeAgentContext(project: string, principal: string, id: string, revision: string): Promise<{
    revoked: true;
}>;

import { type AgentContextPacket, type ResumePacket } from '../agent-context.ts';
/** Identity verified by the route, including the exact consented question revision. */
export interface ResumeBinding {
    project: string;
    principal: string;
    id: string;
    revision: string;
}
/** No mutable checkpoint exists on the server; independent readers never claim or delete peer state. */
export interface ResumeOptions {
    cursor?: string;
    budget?: number;
}
/**
 * Admit or resume an authorized question. Callers recheck live authorization at both boundaries.
 * The optional observer is a deterministic scheduling seam; it never replaces SDK storage or authorization.
 * Only returned rows advance the encrypted frontier. Replaying an old cursor returns stable event keys,
 * while advancing the accepted cursor delivers each immutable event once, including backdated appends.
 */
export declare function buildResumePacket(pmRoot: string, binding: ResumeBinding, options: ResumeOptions, authorize: () => Promise<AgentContextPacket>, step?: (name: string) => Promise<void>): Promise<ResumePacket>;

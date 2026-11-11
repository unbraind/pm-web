/** Explicit replacement of one existing grant; none proposes removal of that project scope. */
export interface PermissionProposal {
    shareId: string;
    permission: 'edit' | 'view' | 'none';
}
/** A single bounded page uses identities only, with no questions, packet contents or audience sizes. */
export interface PermissionImpactInput extends PermissionProposal {
    offset?: number;
    limit?: number;
}
/** One caller-visible resource whose effective access would decrease. */
export interface PermissionLoss {
    kind: 'packet' | 'decision' | 'operation';
    id: string;
    loss: 'read' | 'respond' | 'execute';
}
/** Advisory read-time result; it cannot authorize, cache or apply a subsequent change. */
export interface PermissionImpactPage {
    protocol: 'pm-web-permission-impact/v1';
    mode: 'preview';
    applied: false;
    proposal: PermissionProposal;
    total: number;
    nextOffset: number | null;
    counts: {
        packets: number;
        decisions: number;
        operations: number;
    };
    losses: PermissionLoss[];
    unknownCapabilities: 'disabled';
    remedy: string;
}
/** Stable refusals carry recovery guidance without disclosing storage or hidden scopes. */
export declare class PermissionImpactError extends Error {
    readonly code: 'invalid_input' | 'view_only' | 'owner_required' | 'not_found' | 'unavailable';
    readonly status: number;
    readonly remedy: string;
    /** Preserve one public-safe error contract for SDK, CLI and HTTP. */
    constructor(code: PermissionImpactError['code'], remedy: string, status: number);
}
/** Canonicalize explicit project, share and authenticated principal bindings before database or network use. */
export declare function permissionUuid(raw: unknown): string;
/** One strict schema validates proposal inputs across all transports, with canonical UUIDs. */
export declare function parsePermissionImpact(raw: unknown): PermissionImpactInput;
/** Validate produced pages and remote responses without silently accepting nonfinite or sparse data. */
export declare function parsePermissionImpactPage(raw: unknown): PermissionImpactPage;

import type { PmReadOutputReceipt, PmReadOutputSessionReceipt } from '@unbrained/pm-cli/sdk';
/** Evidence supplied by the serving agent; receipt metadata is not independent proof of inference or usage. */
export interface AgentContextEvidence {
    source: 'core-output-session' | 'pm-context-pack';
    receiptId: string;
    revision: string;
    servedAt: string;
    omission: {
        reason: string;
        remedy: string;
    }[];
}
/** A consented snapshot contains receipt metadata only, never raw context or a model conversation. */
export interface AgentContextInput {
    agent: string;
    /** Publisher-selected item streams relevant to this question; omission disables resume. */
    items?: string[];
    question: string;
    consent: true;
    viewers: string[];
    receipts: AgentContextEvidence[];
    gaps: {
        reason: string;
        remedy: string;
    }[];
}
/** Immutable revision binding for one explicitly authorized audience and evidence snapshot. */
export interface AgentContextPacket extends AgentContextInput {
    id: string;
    revision: string;
    publisher: string;
    updatedAt: string;
}
/** Stable transport-neutral refusal with an actionable recovery instruction. */
export declare class AgentContextError extends Error {
    readonly code: 'invalid_input' | 'view_only' | 'not_found' | 'revision_conflict' | 'unavailable' | 'reorientation_required' | 'budget_too_small';
    readonly remedy: string;
    readonly status: number;
    /** Build a public-safe refusal; storage and credential details never enter the response. */
    constructor(code: AgentContextError['code'], remedy: string, status: number);
}
/** Adapt actual core serving receipts without reproducing its session accounting or budget policy. */
export declare function coreContextEvidence(receipt: PmReadOutputSessionReceipt, output: PmReadOutputReceipt, revision: string, servedAt: string): AgentContextEvidence;
/** Map pm-context's public usage receipt into an explicit source reference; no runtime store is read. */
export declare function packContextEvidence(receipt: {
    protocol: 'pm-context-usage/v1';
    receipt_id: string;
    served_at: string;
}, revision: string, omission: AgentContextEvidence['omission']): AgentContextEvidence;
/** Authenticated HTTP SDK; identity is verified by the server, never selected by an actor flag. */
export declare class AgentContextClient {
    private base;
    private token;
    /** Configure an operator-selected endpoint and session token; no hosted defaults or credential persistence. */
    constructor(baseUrl: string, token: string);
    /** Retrieve one exact snapshot after current scope and consent checks. */
    get(project: string, id: string, revision: string): Promise<AgentContextPacket>;
    /** Admit a baseline or resume from the last accepted cursor; no response contents are cached. */
    resume(project: string, id: string, revision: string, cursor?: string, budget?: number): Promise<ResumePacket>;
    /** Discover only packets whose explicit audience includes the authenticated principal. */
    list(project: string, offset?: number): Promise<{
        packets: Pick<AgentContextPacket, 'id' | 'revision' | 'agent' | 'updatedAt'>[];
        nextOffset: number | null;
        returned: number;
    }>;
    /** Publish a new snapshot, or replace an owned snapshot against its exact revision. */
    publish(project: string, input: AgentContextInput, binding?: {
        id: string;
        revision: string;
    }): Promise<AgentContextPacket>;
    /** Revoke future retrieval atomically against the revision reviewed by the publisher. */
    revoke(project: string, id: string, revision: string): Promise<{
        revoked: true;
    }>;
    /** Send a bounded authenticated request; redirects cannot forward a credential to a second endpoint. */
    private request;
}
/** A bounded change reference; retrieve native state through the authorized project SDK when needed. */
export interface ResumeChange {
    key: string;
    item: string;
    version: number;
    operation: string;
    fields: string[];
    omittedFields: number;
}
/** Explicit admission, missed-event and completeness receipts; cursor metadata contains no item content. */
export interface ResumePacket {
    protocol: 'pm-web-resume/v1';
    phase: 'admitted' | 'delta';
    revision: string;
    cursor: string;
    changes: ResumeChange[];
    receipt: {
        complete: boolean;
        missed: number;
        returned: number;
        deferred: number;
        baselineEvents: number;
        source: 'sdk-history';
        remedy: string;
    };
    budget: {
        bytes: number;
        ceiling: number;
    };
}

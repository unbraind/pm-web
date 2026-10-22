/** Explicit alternatives and evidence attached to a core Plan decision log entry. */
export interface DecisionRequestInput {
    planId: string;
    question: string;
    alternatives: string[];
    evidence: string;
}
/** Authenticated capability supplied by the embedding application; local CLI users own their tracker. */
export interface DecisionActor {
    author: string;
    permission: 'edit' | 'view';
}
/** Compact request projection; acknowledgments leave status pending. */
export interface DecisionRequest extends DecisionRequestInput {
    id: string;
    author: string;
    createdAt: string;
    revision: string;
    status: 'pending' | 'answered';
    acknowledgments: number;
}
/** Revision-bound response; approval records a choice and never executes code or closes work. */
export interface DecisionResponseInput {
    planId: string;
    requestId: string;
    revision: string;
    action: 'approve' | 'acknowledge';
    alternative?: number;
    reason: string;
}
/** Bounded agent result with explicit continuation and separate completion semantics. */
export interface DecisionInboxPage {
    requests: DecisionRequest[];
    total: number;
    nextOffset: number | null;
    codeReview: false;
    taskCompletion: false;
}
/** Stable refusals with a concrete next action for human and agent clients. */
export declare class DecisionInboxError extends Error {
    /** Build a transport-neutral refusal without exposing storage details. */
    readonly code: 'invalid_input' | 'invalid_record' | 'view_only' | 'not_found' | 'revision_conflict' | 'already_answered' | 'unavailable';
    readonly remedy: string;
    readonly status: number;
    constructor(code: DecisionInboxError['code'], remedy: string, status: number);
}
/** Preserve absent pagination defaults while refusing blank or structured transport values. */
export declare function decisionInboxNumber(raw: unknown, fallback: number): number;
/** List pending requests using a certified complete source read and bounded output pagination. */
export declare function listDecisionInbox(pmRoot: string, options?: {
    limit?: number;
    offset?: number;
}): Promise<DecisionInboxPage>;
/** Append a request through the audited core plan decision mutation; no schema or lifecycle change. */
export declare function requestDecision(pmRoot: string, actor: DecisionActor, input: DecisionRequestInput): Promise<DecisionRequest>;
/** Serialize cross-process responses with a public SDK lock and check revisions inside it before audited append. */
export declare function respondToDecision(pmRoot: string, actor: DecisionActor, input: DecisionResponseInput): Promise<{
    request: DecisionRequest;
    codeReview: false;
    taskCompletion: false;
}>;

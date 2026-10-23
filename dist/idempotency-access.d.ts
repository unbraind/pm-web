import type { Request } from 'express';
/** A refusal never includes the cached body or private storage diagnostics. */
export declare class ReplayAccessError extends Error {
    /** Public HTTP refusal status. */
    readonly status: number;
    /** Stable agent-readable replay refusal category. */
    readonly code: string;
    /** Recovery guidance that never suggests silently repeating a committed mutation. */
    readonly remedy: string;
    /** Preserve a stable reason and remedy across every replay transport. */
    constructor(status?: number, code?: string, remedy?: string);
}
/** The middleware supplies verified identity and the immutable recorded response, never caller-selected identity. */
export interface ReplayAccessInput {
    request: Request;
    principal: string;
    status: number;
    body: string | null;
}
/** Content-free settlement receipt for the same account and exact original request. */
export interface IdempotencySuccessReceipt {
    readonly status: number;
    readonly ids: readonly string[];
}
/** Return a receipt for settlement only, or authorize the original body with a current read check. */
export type ReplayAuthorization = (input: ReplayAccessInput) => Promise<void | IdempotencySuccessReceipt>;
/** Successful mutations may settle without content; only replaying content requires current read authorization. */
export declare function authorizeStoredReplay(input: ReplayAccessInput): Promise<void | IdempotencySuccessReceipt>;

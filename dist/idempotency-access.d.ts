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
/** Embedders must provide a current authorization policy before any body can be replayed. */
export type ReplayAuthorization = (input: ReplayAccessInput) => Promise<void>;
/** Reauthorize every production replay family; unknown routes and unreadable resources fail closed without executing handlers. */
export declare function authorizeStoredReplay(input: ReplayAccessInput): Promise<void>;

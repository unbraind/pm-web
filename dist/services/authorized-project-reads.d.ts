import { type ContractsResult, type GetItemAtResult, type GetResult, type PmCompleteListResult } from '@unbrained/pm-cli/sdk';
import { type ProjectAccess } from './project-access.ts';
/** Narrow SDK read capabilities; neither arbitrary dispatch nor caller-supplied roots cross this boundary. */
export interface ProjectItemReader {
    get(id: string): Promise<GetResult>;
    complete(includeBody?: boolean): Promise<PmCompleteListResult>;
    at(id: string, ref: string): Promise<GetItemAtResult>;
    contracts(): Promise<ContractsResult>;
}
/** Safe access refusals contain no backend address or principal identity. */
export declare class ProjectReadError extends Error {
    readonly status: 404 | 409;
    /** Bind the transport status to a fixed public message. */
    constructor(status: 404 | 409);
}
/** Only fixed SDK preflight categories survive the private provider error boundary. */
export declare class ProjectReadUnavailableError extends Error {
    readonly reason: string;
    /** Retain an allowlisted category without retaining provider messages, paths or recovery arguments. */
    constructor(error: unknown);
}
/**
 * Bind a live authorized project to observational SDK capabilities, then reauthorize before releasing data.
 * The workspace queue is the physical tracker captured with the binding. Recheck after waiting so a revoked,
 * rebound, or retargeted request never starts a storage read. The reader uses that same pin, so a symlink
 * change cannot move it onto the new target while it holds the old queue. The final grant and storage
 * comparison is the read's authorization linearization point; callers must send the result without further
 * asynchronous work. This is not a cross-store snapshot. The optional observer acknowledges initial
 * authorization for deterministic scheduling; it replaces no SDK or grant operation.
 */
export declare function readAuthorizedProject<T>(principal: string, projectId: string, read: (reader: ProjectItemReader, access: ProjectAccess) => Promise<T>, onAuthorized?: () => void): Promise<T>;

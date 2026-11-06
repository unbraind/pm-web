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
/**
 * Bind a live authorized project to observational SDK capabilities, then reauthorize before releasing data.
 * The workspace queue is shared with existing mutations. Recheck after waiting so a revoked or rebound
 * request never starts a storage read. The final grant lookup is the read's authorization linearization
 * point; callers must send the result without further asynchronous work. This is not a cross-store snapshot.
 */
export declare function readAuthorizedProject<T>(principal: string, projectId: string, read: (reader: ProjectItemReader, access: ProjectAccess) => Promise<T>): Promise<T>;

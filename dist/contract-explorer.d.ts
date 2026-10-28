import { type ContractsResult, type GetContractsOptions } from '@unbrained/pm-cli/sdk';
/** Backend identities describe storage, independently of HTTP transport. */
export type ContractBackendKind = 'directory' | 'postgres' | 'remote';
/** A read-only provider boundary: implementations expose SDK contracts, never operation dispatch. */
export interface ContractAdapter {
    kind: ContractBackendKind;
    describe(options: {
        action?: string;
        availabilityOnly?: boolean;
        schemaOnly?: boolean;
    }): Promise<ContractsResult>;
}
/** Public-safe failures shared by SDK, HTTP and CLI. */
export declare class ContractExplorerError extends Error {
    readonly code: 'invalid_input' | 'unsupported' | 'unavailable' | 'view_only' | 'not_found';
    readonly remedy: string;
    readonly status: number;
    /** Construct a stable refusal without including provider exception text. */
    constructor(code: ContractExplorerError['code'], remedy: string, status: number);
}
/** One capability; advertised support never constitutes permission to execute it. */
export interface ContractCapability {
    action: string;
    command: string | null;
    provider: 'core' | 'extension';
    status: 'available' | 'unsupported' | 'unavailable';
    mutation: boolean;
    remedy: string;
}
/** Bounded agent projection; total and nextOffset disclose omitted operations. */
export interface ContractExplorerPage {
    version: 1;
    backend: ContractBackendKind;
    mode: 'review_only';
    total: number;
    nextOffset: number | null;
    operations: ContractCapability[];
    schema?: Record<string, unknown>;
}
/** A review envelope is never a runtime dry-run or a validated execution plan. */
export interface ContractReview {
    mode: 'review_only';
    executed: false;
    validated: false;
    operation: ContractCapability;
    input: Record<string, unknown>;
    remedy: string;
}
/** Bind the existing SDK resolver to a directory tracker without invoking Git or any reviewed action. */
export declare function directoryContractAdapter(options: Pick<GetContractsOptions, 'pmRoot' | 'cwd' | 'noExtensions'>): ContractAdapter;
/** Own one provider availability read for internal aggregates; schema inspection still requires a live adapter. */
export declare function captureContractAvailability(adapter: ContractAdapter): Promise<ContractAdapter>;
/** Parse transport pagination strictly so blank, structured and boolean values cannot silently select a page. */
export declare function contractPageNumber(value: unknown): number | undefined;
/** Inspect fresh provider declarations and project only public operation metadata. */
export declare function exploreContracts(adapter: ContractAdapter, options?: {
    offset?: number;
    limit?: number;
    action?: string;
}): Promise<ContractExplorerPage>;
/** Produce a bounded review envelope after a fresh availability read, without dispatching or validating the operation. */
export declare function reviewContract(adapter: ContractAdapter, action: string, input: unknown, permission: 'view' | 'edit'): Promise<ContractReview>;

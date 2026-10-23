import { type ContractExplorerPage, type ContractReview } from './contract-explorer.ts';
/** Authenticated remote explorer SDK; tokens remain in memory and redirects never receive them. */
export declare class ContractExplorerClient {
    private readonly origin;
    private readonly token;
    /** Configure an explicit HTTPS endpoint (HTTP is accepted only on loopback for development). */
    constructor(baseUrl: string, token: string);
    /** Read a bounded page or one action schema in the authenticated project scope. */
    list(project: string, options?: {
        offset?: number;
        limit?: number;
        action?: string;
    }): Promise<ContractExplorerPage>;
    /** Request an unexecuted review envelope; the server refreshes availability and edit authorization. */
    review(project: string, action: string, input: Record<string, unknown>): Promise<ContractReview>;
    /** Transmit bounded requests and preserve only typed, public-safe server refusals. */
    private request;
}

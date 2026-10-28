import { type PmRunResult } from './pm-runner.ts';
/** One patch-free activity row; index is the stable physical stream position. */
export interface ItemHistoryRow {
    index: number;
    timestamp: string;
    action: string;
    author: string;
    message?: string;
}
/** Latest or older page, always chronological within the page. */
export interface ItemHistoryPage {
    history: ItemHistoryRow[];
    order: 'oldest_first';
    has_more: boolean;
    next_cursor: string | null;
}
/** Expected read refusals carry safe messages and a concrete recovery action. */
export declare class ItemHistoryError extends Error {
    /** HTTP refusal status. */
    readonly status: number;
    /** Machine-readable refusal reason. */
    readonly code: string;
    /** Concrete recovery advice safe for the browser. */
    readonly remedy: string;
    /** Keep tracker internals out of HTTP error messages. */
    constructor(status: number, code: string, message: string, remedy: string);
}
/** Normalize both real compact and full output; legacy output without order is chronological. */
export declare function normalizeItemHistory(value: unknown): ItemHistoryRow[];
/** Require the documented page size before any host read. */
export declare function itemHistoryLimit(value: unknown): number;
/**
 * Read latest entries with a limit and page backwards by physical stream index.
 * Supported hosts have no backwards history cursor: older pages re-read only
 * the required latest suffix. The HTTP response always has at most limit rows
 * with bounded strings and no patches. A head probe only sizes the suffix:
 * the suffix itself must prove complete coverage of the requested interval.
 */
export declare function readItemHistoryPage(run: (args: string[]) => Promise<PmRunResult>, itemId: string, projectId: string, query: {
    limit?: unknown;
    cursor?: unknown;
}): Promise<ItemHistoryPage>;

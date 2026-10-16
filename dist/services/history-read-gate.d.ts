import { listMutationEvents, type SubscribeMutationEventsOptions } from "@unbrained/pm-cli/sdk";
/** Full checks bound metadata-collision detection without a lock on every 250 ms poll. */
export declare const HISTORY_READ_SAFETY_MS = 5000;
/**
 * Inspect authoritative streams as well as the optional SQLite index and WAL.
 * Directory metadata alone misses appends to existing streams; index metadata
 * alone misses authoritative fallback writes. This never opens the SDK index.
 */
export declare function historyFingerprint(pmRoot: string): Promise<string>;
/** Read admission state survives follower restarts; failed or interrupted scans never certify a fingerprint. */
export declare class HistoryReadGate {
    /** Start of the last fully consumed replay scan, used to retain late facts across skipped polls. */
    completedScanAt: number | undefined;
    private fingerprint;
    private checkedAt;
    private generation;
    private checkedGeneration;
    /** Mark an HTTP or NOTIFY signal, including signals arriving during an in-flight scan. */
    invalidate(): void;
    /** Admit changed, signaled or safety-due reads; capture metadata before querying to avoid hiding a racing write. */
    begin(fingerprint: string, now?: number): {
        complete: (scanAt: number) => void;
    } | null;
}
/**
 * Share identical concurrent pages per tracker and query, retaining independent
 * replay receipts and authorization for each consumer. No settled page is cached.
 */
export declare function singleFlightMutationPage(options: SubscribeMutationEventsOptions & {
    pmRoot: string;
}): ReturnType<typeof listMutationEvents>;

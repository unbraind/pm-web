/** Process-local aggregate snapshot; contains no user or project identifiers. */
export interface RealtimeCounters {
    sse_clients: number;
    sse_connections_total: number;
    sse_disconnections_total: number;
    broadcasts_total: number;
    watcher_last_sweep_at: string | null;
    watcher_last_sweep_ms: number | null;
    watcher_changes_total: number;
    watcher_errors_total: number;
}
/** Three missed sweep intervals allow ordinary scheduling jitter but bound silent stalls. */
export declare const WATCHER_STALE_INTERVALS = 3;
/** Initialize watchdog timing at watcher startup, including the no-first-sweep grace. */
export declare function configureWatcherHealth(intervalMs: number, enabled: boolean): void;
/** Record a local connection; invoked only after insertion in the SSE registry. */
export declare function recordConnection(projectId: string, userId: string): void;
/** Count each registry removal once, including cleanup and server shutdown. */
export declare function recordDisconnection(projectId: string, durationMs: number, reason: string): void;
/** Record one local broadcast attempt, including attempts with no local recipients. */
export declare function recordBroadcast(projectId: string, eventType: string, recipients: number): void;
/** Record completion of a bounded watcher tick, even with no active projects.
 * Multi-tick project scans report the files inspected in this tick; a stalled
 * tick never advances the timestamp and therefore trips the freshness check.
 */
export declare function recordSweep(durationMs: number, filesScanned: number, changes: number, errors: number): void;
/** Read a fresh copy so health callers cannot mutate internal counters. */
export declare function realtimeHealth(now?: number): {
    ok: boolean;
    counters: RealtimeCounters;
};

import { logEvent, opaqueHash } from "../observability.js";
const counters = {
    sse_clients: 0, sse_connections_total: 0, sse_disconnections_total: 0, broadcasts_total: 0,
    watcher_last_sweep_at: null, watcher_last_sweep_ms: null, watcher_changes_total: 0, watcher_errors_total: 0,
};
let watcherStartedAt = Date.now();
let watcherIntervalMs = 15_000;
let lastSweepErrors = 0;
let watcherEnabled = false;
/** Three missed sweep intervals allow ordinary scheduling jitter but bound silent stalls. */
export const WATCHER_STALE_INTERVALS = 3;
/** Initialize watchdog timing at watcher startup, including the no-first-sweep grace. */
export function configureWatcherHealth(intervalMs, enabled) {
    watcherIntervalMs = intervalMs;
    watcherEnabled = enabled;
    watcherStartedAt = Date.now();
    counters.watcher_last_sweep_at = null;
    counters.watcher_last_sweep_ms = null;
    lastSweepErrors = 0;
}
/** Record a local connection; invoked only after insertion in the SSE registry. */
export function recordConnection(projectId, userId) {
    counters.sse_clients += 1;
    counters.sse_connections_total += 1;
    logEvent("sse_connect", { project_hash: opaqueHash("project", projectId), user_hash: opaqueHash("user", userId) });
}
/** Count each registry removal once, including cleanup and server shutdown. */
export function recordDisconnection(projectId, durationMs, reason) {
    counters.sse_clients -= 1;
    counters.sse_disconnections_total += 1;
    logEvent("sse_disconnect", { project_hash: opaqueHash("project", projectId), duration_ms: durationMs, reason });
}
/** Record one local broadcast attempt, including attempts with no local recipients. */
export function recordBroadcast(projectId, eventType, recipients) {
    counters.broadcasts_total += 1;
    const type = ["connected", "presence", "workspace-changed", "extensions-changed", "item-created", "item-updated", "item-deleted", "item-closed", "items-imported", "items-bulk-updated", "graph-synced", "graph-sync-failed", "graph_sync_failed", "dependency-added", "dependency-removed", "comment-added", "claim-updated", "dependency-changed"].includes(eventType) ? eventType : "other";
    logEvent("sse_broadcast", { project_hash: opaqueHash("project", projectId), event_type: type, recipient_count: recipients });
}
/** Record completion of a bounded watcher tick, even with no active projects.
 * Multi-tick project scans report the files inspected in this tick; a stalled
 * tick never advances the timestamp and therefore trips the freshness check.
 */
export function recordSweep(durationMs, filesScanned, changes, errors) {
    counters.watcher_last_sweep_at = new Date().toISOString();
    counters.watcher_last_sweep_ms = durationMs;
    counters.watcher_changes_total += changes;
    counters.watcher_errors_total += errors;
    lastSweepErrors = errors;
    logEvent("watcher_sweep", { completed: true, duration_ms: durationMs, files_scanned: filesScanned, changes_detected: changes, errors }, errors > 0 ? "warn" : "info");
}
/** Read a fresh copy so health callers cannot mutate internal counters. */
export function realtimeHealth(now = Date.now()) {
    const last = counters.watcher_last_sweep_at === null ? watcherStartedAt : Date.parse(counters.watcher_last_sweep_at);
    return { ok: watcherEnabled && lastSweepErrors === 0 && now - last <= WATCHER_STALE_INTERVALS * watcherIntervalMs, counters: { ...counters } };
}
//# sourceMappingURL=realtime-observability.js.map
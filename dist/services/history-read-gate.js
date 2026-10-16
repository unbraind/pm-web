/** Cheap metadata checks ahead of the SDK's exclusive history-index reader lock. */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
/** Full checks bound metadata-collision detection without a lock on every 250 ms poll. */
export const HISTORY_READ_SAFETY_MS = 5_000;
/** Preserve exact metadata, including nanoseconds and replacement identity, without rounding or hashing. */
async function fileStamp(file) {
    try {
        const value = await stat(file, { bigint: true });
        return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "missing";
        throw error;
    }
}
/**
 * Inspect authoritative streams as well as the optional SQLite index and WAL.
 * Directory metadata alone misses appends to existing streams; index metadata
 * alone misses authoritative fallback writes. This never opens the SDK index.
 */
export async function historyFingerprint(pmRoot) {
    const history = path.join(pmRoot, "history");
    let names;
    try {
        names = (await readdir(history)).filter((name) => name.endsWith(".jsonl")).sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        names = [];
    }
    const stamps = [];
    for (const name of names)
        stamps.push(`${name}:${await fileStamp(path.join(history, name))}`);
    for (const suffix of ["", "-wal"])
        stamps.push(`index${suffix}:${await fileStamp(path.join(pmRoot, "runtime", "history-event-index.sqlite" + suffix))}`);
    return JSON.stringify(stamps);
}
/** Read admission state survives follower restarts; failed or interrupted scans never certify a fingerprint. */
export class HistoryReadGate {
    /** Start of the last fully consumed replay scan, used to retain late facts across skipped polls. */
    completedScanAt;
    fingerprint;
    checkedAt = -Infinity;
    generation = 0;
    checkedGeneration = -1;
    /** Mark an HTTP or NOTIFY signal, including signals arriving during an in-flight scan. */
    invalidate() { this.generation += 1; }
    /** Admit changed, signaled or safety-due reads; capture metadata before querying to avoid hiding a racing write. */
    begin(fingerprint, now = performance.now()) {
        if (fingerprint === this.fingerprint && this.generation === this.checkedGeneration && now - this.checkedAt < HISTORY_READ_SAFETY_MS)
            return null;
        const generation = this.generation;
        return { complete: (scanAt) => {
                this.fingerprint = fingerprint;
                this.checkedAt = now;
                this.checkedGeneration = generation;
                this.completedScanAt = scanAt;
            } };
    }
}
const reads = new Map();
/**
 * Share identical concurrent pages per tracker and query, retaining independent
 * replay receipts and authorization for each consumer. No settled page is cached.
 */
export async function singleFlightMutationPage(options) {
    const { signal: _signal, intervalMs: _interval, ...query } = options;
    const key = JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
    const existing = reads.get(key);
    if (existing)
        return existing;
    const pending = listMutationEvents(query);
    reads.set(key, pending);
    try {
        return await pending;
    }
    finally {
        reads.delete(key);
    }
}
//# sourceMappingURL=history-read-gate.js.map
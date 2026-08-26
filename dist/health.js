import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
/** Maximum time a single probe may run before it is considered failed. */
const PROBE_TIMEOUT_MS = 2000;
/** How long a computed health result is reused before re-probing. */
const CACHE_TTL_MS = 5000;
/**
 * How long to skip the PostgreSQL probe after one times out.
 *
 * A timed-out query keeps a pool client until the server answers. Re-probing
 * every cache expiry during a stall would drain the pool; this bounds it.
 */
const POOL_COOLDOWN_MS = 30_000;
/** How old a stray `.healthz-*.tmp` file must be before a sweep removes it. */
const STRAY_PROBE_MAX_AGE_MS = 60_000;
/** Extract a string message from an unknown rejection value. */
function errorMessage(error) {
    // `/healthz` is unauthenticated, so the response must never carry a raw
    // message: a pg failure names the host, port, database and user, and a
    // filesystem failure names the projects-root path. Both are reconnaissance
    // for an anonymous caller. Map to a stable category and keep the detail in
    // the server log, where an operator can still read it.
    const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    console.error("[healthz] probe failed", { code, message });
    if (message === "probe timed out")
        return "timed out";
    if (code === "ENOENT")
        return "not found";
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
        return "permission denied";
    if (code === "ENOSPC")
        return "no space left on device";
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
        return "unreachable";
    }
    return "unavailable";
}
/**
 * Race a promise against a timeout, rejecting with `"probe timed out"` if the
 * timeout fires first.
 *
 * The timer is cleared in both branches so a resolved/rejected probe does not
 * leak a dangling timer, and a timed-out probe does not keep the event loop
 * alive for the remaining lifetime of the underlying promise.
 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("probe timed out")), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
/**
 * Probe PostgreSQL by running `SELECT 1` through the provided queryable.
 *
 * Uses the service's real pool (not a fresh connection) so pool exhaustion is
 * itself a failure mode the probe catches. The probe is bounded by
 * {@link PROBE_TIMEOUT_MS}.
 */
async function probePostgres(pool) {
    const start = Date.now();
    try {
        await withTimeout(pool.query("SELECT 1"), PROBE_TIMEOUT_MS);
        return { ok: true, latency_ms: Date.now() - start };
    }
    catch (error) {
        return { ok: false, latency_ms: Date.now() - start, error: errorMessage(error) };
    }
}
/**
 * Probe the projects root by writing and immediately removing a temp file
 * inside it.
 *
 * A missing directory, a read-only host mount, or a full disk all surface as
 * a write or unlink failure. The temp file is cleaned up in every path: on
 * success it is unlinked by the probe itself, and on failure a best-effort
 * cleanup removes it if the write succeeded but the unlink (or timeout) did
 * not.
 */
async function probeProjectsRoot(root) {
    const start = Date.now();
    // A pid-and-millisecond name collides when two uncached probes start in the
    // same millisecond: whichever unlinks first makes the other report ENOENT and
    // return a spurious 503 for a perfectly healthy volume.
    const probeFile = path.join(root, `.healthz-${randomUUID()}.tmp`);
    // Held so cleanup can be attached to the attempt's own settlement rather than
    // racing it. A timeout does not cancel the underlying write: unlinking
    // immediately can therefore run BEFORE a slow write lands, leaving the file
    // behind permanently - the opposite of what the cleanup is for.
    const attempt = (async () => {
        await writeFile(probeFile, "");
        await unlink(probeFile);
    })();
    try {
        await withTimeout(attempt, PROBE_TIMEOUT_MS);
        return { ok: true, latency_ms: Date.now() - start };
    }
    catch (error) {
        // NOT awaited, and bounded. A stalled mount is the exact condition that
        // reaches this path, and an unbounded `await unlink` here would never
        // settle: probeProjectsRoot would never resolve, the Promise.all in
        // compute() would never resolve, `inFlight` would never clear, and every
        // subsequent /healthz request would await the same pending promise forever
        // - serving nothing at all instead of 503.
        void attempt.catch(() => undefined).finally(() => {
            void withTimeout(unlink(probeFile), PROBE_TIMEOUT_MS).catch(() => undefined);
        });
        return { ok: false, latency_ms: Date.now() - start, error: errorMessage(error) };
    }
}
/**
 * Remove `.healthz-*.tmp` files older than {@link STRAY_PROBE_MAX_AGE_MS}.
 *
 * A probe whose write lands after its own cleanup has already run leaves a
 * stray file that nothing else will remove. Sweeping on each healthy probe
 * bounds how long such a file can persist, without ever failing the probe:
 * a sweep error is not a health signal and is deliberately swallowed.
 *
 * @param root - The projects root to sweep.
 */
async function sweepStrayProbeFiles(root) {
    try {
        const now = Date.now();
        for (const name of await readdir(root)) {
            if (!name.startsWith(".healthz-") || !name.endsWith(".tmp"))
                continue;
            const full = path.join(root, name);
            const info = await stat(full);
            if (now - info.mtimeMs > STRAY_PROBE_MAX_AGE_MS)
                await unlink(full);
        }
    }
    catch {
        // Sweeping is housekeeping, not a dependency check.
    }
}
/**
 * Run a soft-dependency probe, catching any synchronous throw, rejection, or
 * timeout so a broken soft probe can never throw into the health handler.
 */
async function runSoftProbe(probe) {
    try {
        const status = await withTimeout(probe.probe(), PROBE_TIMEOUT_MS);
        return [probe.name, status];
    }
    catch (error) {
        return [probe.name, { ok: false, latency_ms: 0, error: errorMessage(error) }];
    }
}
/**
 * Build the Express `/healthz` request handler.
 *
 * The handler probes every hard dependency in parallel, adds soft-dependency
 * results, caches the outcome for {@link CACHE_TTL_MS} milliseconds, and
 * responds with HTTP 200 (`ok: true`) or 503 (`ok: false`). It never throws:
 * each probe catches its own errors, and the outer `try`/`catch` is a
 * defensive last resort.
 */
export function createHealthHandler(deps) {
    let cached = null;
    // Concurrent cache misses must share ONE computation. `withTimeout` rejects
    // its wrapper but cannot cancel the underlying `pool.query`, so without this
    // every request during a hung database starts another query that keeps
    // running after the endpoint has already answered 503 - consuming pool
    // capacity and starving the ordinary API. Single-flight bounds the damage to
    // one in-flight probe no matter how often the endpoint is polled.
    let inFlight = null;
    // Epoch ms of the last PostgreSQL probe timeout, or 0 if none has timed out.
    let lastPostgresTimeoutAt = 0;
    /**
     * Probe every dependency once and cache the outcome.
     *
     * Separated from the handler so concurrent cache misses can await a single
     * shared promise rather than each starting their own probe round.
     *
     * @returns The freshly computed health result, already written to the cache.
     */
    async function compute() {
        let result;
        try {
            // `withTimeout` rejects its wrapper but cannot cancel `pool.query`, so a
            // timed-out probe leaves a client checked out until PostgreSQL answers.
            // Without a cooldown, every cache expiry starts another one and a stalled
            // database drains the shared pool out from under the ordinary API. After
            // a timeout the probe is not retried for POOL_COOLDOWN_MS; the endpoint
            // keeps answering 503 from the reported status in the meantime.
            const cooling = Date.now() - lastPostgresTimeoutAt < POOL_COOLDOWN_MS;
            const postgresProbe = cooling
                ? Promise.resolve({
                    ok: false,
                    latency_ms: 0,
                    error: "probe cooling down after timeout",
                })
                : probePostgres(deps.pool).then((status) => {
                    // "timed out" is errorMessage()'s stable category, not the raw
                    // message: /healthz is unauthenticated, so the raw text is
                    // deliberately never surfaced. Matching the category is what makes
                    // this survive a change to the underlying error string.
                    if (!status.ok && status.error === "timed out") {
                        lastPostgresTimeoutAt = Date.now();
                    }
                    return status;
                });
            const [postgres, projectsRootStatus, ...softResults] = await Promise.all([
                postgresProbe,
                probeProjectsRoot(deps.projectsRoot),
                ...(deps.softProbes?.map(runSoftProbe) ?? []),
            ]);
            const dependencies = {
                postgres,
                projects_root: projectsRootStatus,
            };
            for (const [name, status] of softResults) {
                dependencies[name] = status;
            }
            if (projectsRootStatus.ok)
                void sweepStrayProbeFiles(deps.projectsRoot);
            result = {
                ok: postgres.ok && projectsRootStatus.ok,
                version: deps.version,
                dependencies,
            };
        }
        catch {
            // Every probe catches its own errors; this is a defensive last resort
            // so the handler can never throw an unhandled error into Express.
            result = {
                ok: false,
                version: deps.version,
                dependencies: {
                    postgres: { ok: false, latency_ms: 0, error: "unexpected handler error" },
                    projects_root: { ok: false, latency_ms: 0, error: "unexpected handler error" },
                },
            };
        }
        cached = { result, at: Date.now() };
        return result;
    }
    const handler = async (_req, res) => {
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            res.status(cached.result.ok ? 200 : 503).json(cached.result);
            return;
        }
        inFlight ??= compute().finally(() => { inFlight = null; });
        const result = await inFlight;
        res.status(result.ok ? 200 : 503).json(result);
    };
    return handler;
}
//# sourceMappingURL=health.js.map
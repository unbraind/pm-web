import type { RequestHandler } from "express";
/**
 * Minimum structural type a PostgreSQL pool must satisfy for the health probe.
 *
 * The real `pg.Pool` satisfies this, and tests can substitute any object whose
 * `query` accepts a SQL string and returns a promise — so the probe runs
 * through the same pool the service uses in production without forcing tests
 * to construct a real database connection.
 */
export interface Queryable {
    /** Execute a SQL string and return rows. */
    query(text: string): Promise<{
        rows: unknown[];
    }>;
}
/** Status reported for one dependency in the health response. */
export interface DependencyStatus {
    /** Whether the dependency responded successfully. */
    readonly ok: boolean;
    /** Round-trip latency in milliseconds. */
    readonly latency_ms: number;
    /** Human-readable failure reason; omitted on success. */
    readonly error?: string;
    /**
     * Whether the dependency was configured (env var present). Only meaningful
     * for soft dependencies that may legitimately be absent; hard dependencies
     * are always treated as configured.
     */
    readonly configured?: boolean;
}
/** A named soft-dependency probe whose result does not affect the status code. */
export interface SoftProbe {
    /** Key under `dependencies` in the response. */
    readonly name: string;
    /** Async function returning the dependency status. */
    readonly probe: () => Promise<DependencyStatus>;
}
/** Dependencies the health handler needs to probe. */
export interface HealthProbeDeps {
    /** PostgreSQL pool — probed with `SELECT 1` (hard dependency). */
    readonly pool: Queryable;
    /** Host-mounted projects root — probed for writability (hard dependency). */
    readonly projectsRoot: string;
    /** Package version, resolved once at boot from `package.json`. */
    readonly version: string;
    /** Soft-dependency probes; their results are reported but never cause 503. */
    readonly softProbes?: ReadonlyArray<SoftProbe>;
    /**
     * Timing overrides, in milliseconds.
     *
     * Production never sets these. They exist because the behaviour that matters
     * here -- what happens on the second cooldown expiry of a stall that has not
     * ended -- is otherwise only reachable by a test that waits over half a
     * minute, and a guard nothing executes is how a pool-drain protection stops
     * working without anyone noticing.
     */
    readonly timing?: {
        /** Overrides {@link PROBE_TIMEOUT_MS}. */
        readonly probeTimeoutMs?: number;
        /** Overrides {@link CACHE_TTL_MS}. */
        readonly cacheTtlMs?: number;
        /** Overrides {@link POOL_COOLDOWN_MS}. */
        readonly poolCooldownMs?: number;
    };
}
/** Shape of the `/healthz` response body (backward compatible: `ok`, `version`). */
export interface HealthResult {
    /** `true` only when every hard dependency is reachable. */
    readonly ok: boolean;
    /** Package version from `package.json`. */
    readonly version: string;
    /** Per-dependency breakdown. */
    readonly dependencies: Readonly<Record<string, DependencyStatus>>;
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
export declare function createHealthHandler(deps: HealthProbeDeps): RequestHandler;

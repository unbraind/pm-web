/**
 * Throw a clear, actionable error when no database is configured.
 *
 * pm-web requires a PostgreSQL database. Without this guard, an unset
 * DATABASE_URL produced a cryptic `getaddrinfo` DNS error several seconds
 * after start (or a silent hang). Call this before using the pool so the
 * server fails fast with guidance instead.
 */
export declare function assertDbConfigured(): void;
export declare const pool: import("pg").Pool;
export declare function initSchema(): Promise<void>;
//# sourceMappingURL=db.d.ts.map
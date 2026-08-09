/**
 * Throw a clear, actionable error when no database is configured.
 *
 * pm-web requires a PostgreSQL database. Without this guard, an unset
 * DATABASE_URL produced a cryptic `getaddrinfo` DNS error several seconds
 * after start (or a silent hang). Call this before using the pool so the
 * server fails fast with guidance instead.
 */
export declare function assertDbConfigured(): void;
/**
 * Shared PostgreSQL connection pool for all pm-web queries.
 *
 * Configured from {@link resolvePoolConfig} (DATABASE_URL or POSTGRES_* vars)
 * with a generous default `max`; one client is permanently reserved for the
 * LISTEN/NOTIFY channel, and `PM_WEB_DB_POOL_MAX` tunes capacity for larger
 * multi-user deployments. Query code borrows from this pool rather than
 * opening its own connections.
 */
export declare const pool: import("pg").Pool;
/**
 * Create the pm-web database schema, idempotently.
 *
 * Issues `CREATE TABLE IF NOT EXISTS` for users, projects, groups, group
 * members, project shares, external (OIDC) identities, the admin audit log,
 * and GitHub item links, plus their indexes; runs idempotent `ADD COLUMN IF
 * NOT EXISTS` migrations for later-added columns; and, when
 * `PM_WEB_BOOTSTRAP_ADMIN_EMAIL` is set, promotes that (lower-cased) user to
 * admin. Safe to call on every boot.
 */
export declare function initSchema(): Promise<void>;

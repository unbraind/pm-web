#!/usr/bin/env node
/**
 * Fails the run when the PostgreSQL database required by the route-coverage
 * suite is not reachable, instead of letting the suite quietly skip its
 * real-database tests.
 *
 * This exists to keep the coverage gate honest. The route tests are what lift
 * `src/routes/*` off the floor, and they need a real server: they assert SQL
 * semantics such as ownership predicates and share JOINs that a stubbed
 * `pool.query` cannot reproduce. If a missing database merely skipped them, the
 * ratchet in `package.json` → `coverageGate.thresholds` could be satisfied by
 * omission and a genuine regression would look identical to an unconfigured
 * machine. Refusing to start makes that impossible.
 *
 * A clear failure also matters because `src/db.ts` builds the `pg.Pool` at
 * module load time: without this preflight, an unset `DATABASE_URL` surfaces as
 * a cryptic connection error from deep inside an unrelated test rather than as
 * an actionable message.
 *
 * Invoked by `scripts/with-test-db.ts` before it spawns the test runner. A
 * contributor can also run it directly (`npm run db:check`) to verify
 * connectivity.
 */
import pg from "pg";

/** Default throwaway database, as started by `npm run db:up`. */
const DEFAULT_DATABASE_URL = "postgres://postgres:test@127.0.0.1:55433/pmwebtest";
/** How long to wait before declaring the database unreachable. */
const CONNECT_TIMEOUT_MS = 10_000;

const url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
/** The URL with any password removed, safe to print in logs and CI output. */
const redacted = url.replace(/:[^:@/]+@/, ":***@");

const client = new pg.Client({ connectionString: url });
const timer = setTimeout(() => {
  console.error(
    `ensure-test-db: timed out after ${CONNECT_TIMEOUT_MS / 1_000}s connecting to ${redacted}.\n` +
      "  Is the database running? Start a throwaway one with `npm run db:up`.",
  );
  process.exit(1);
}, CONNECT_TIMEOUT_MS);

try {
  await client.connect();
  await client.query("SELECT 1");
  process.stderr.write(`ensure-test-db: database reachable at ${redacted}\n`);
} catch (error) {
  console.error(
    `ensure-test-db: could not connect to the database: ${error instanceof Error ? error.message : String(error)}\n` +
      "  The route-coverage suite requires a reachable PostgreSQL database and never skips.\n" +
      "  Start a throwaway database with `npm run db:up`, or set DATABASE_URL to an existing one.",
  );
  process.exit(1);
} finally {
  clearTimeout(timer);
  await client.end().catch(() => undefined);
}

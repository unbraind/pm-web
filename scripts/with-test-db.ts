#!/usr/bin/env node
/**
 * Runs a test command with the database environment the suite needs, refusing to
 * start when no database is reachable.
 *
 * Two module-load-time reads make this wrapper necessary rather than optional:
 * `src/db.ts` constructs the `pg.Pool` from `DATABASE_URL` when it is imported,
 * and `src/auth.ts` reads `JWT_SECRET` the same way. Both therefore have to be
 * present in the environment *before* the test process starts — assigning them
 * inside a test body is too late, because `import` is hoisted above it.
 *
 * Supplying them here rather than inline in `package.json` also keeps the npm
 * scripts cross-platform: `VAR=value cmd` is POSIX shell syntax that cmd.exe
 * does not understand, and this fleet has already shipped Windows-broken npm
 * scripts that way once.
 *
 * The connectivity preflight runs first so a missing database fails loudly
 * instead of letting the real-Postgres tests skip — see `ensure-test-db.ts` for
 * why a skip would make the coverage gate cheatable.
 *
 * Usage (Node expands the `--test` glob itself, so no shell is involved):
 *
 *   node scripts/with-test-db.ts node --test test/*.test.ts
 *   node scripts/with-test-db.ts node scripts/coverage-gate.ts
 */
import { spawnSync } from "node:child_process";

/** Default throwaway database started by `npm run db:up`, matched by CI's service container. */
const DEFAULT_DATABASE_URL = "postgres://postgres:test@127.0.0.1:55433/pmwebtest";
/** A stable secret long enough for JWT signing, so tests need no key setup. */
const DEFAULT_JWT_SECRET = "pm-web-test-jwt-secret-at-least-32-bytes";

// Defaults only: an operator or CI can point the suite at another database by
// exporting either variable beforehand.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DEFAULT_DATABASE_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = DEFAULT_JWT_SECRET;

const preflight = spawnSync(process.execPath, ["scripts/ensure-test-db.ts"], {
  stdio: "inherit",
  env: process.env,
});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error(
    "with-test-db: no command supplied. Pass the runner after the wrapper, e.g.\n" +
      "  node scripts/with-test-db.ts node --test test/*.test.ts",
  );
  process.exit(1);
}

const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);

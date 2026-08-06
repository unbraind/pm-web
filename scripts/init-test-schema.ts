#!/usr/bin/env node
/**
 * Initializes the real PostgreSQL test schema before parallel test workers run.
 *
 * Route tests execute in separate Node worker processes. Letting each worker
 * run the idempotent production DDL is unsafe: a late worker can request an
 * access-exclusive lock for `ALTER TABLE ... IF NOT EXISTS` while an earlier
 * worker is already exercising routes, creating a DDL/DML deadlock. The test
 * wrapper runs this process once, waits for it to exit, and only then hands an
 * explicit ready marker to the workers.
 */
import { initSchema, pool } from "../src/db.ts";

try {
  await initSchema();
  process.stderr.write("init-test-schema: schema ready before parallel workers\n");
} catch (error) {
  console.error(
    `init-test-schema: schema initialization failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

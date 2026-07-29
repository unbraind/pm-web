#!/usr/bin/env node
/**
 * Stops and removes the throwaway PostgreSQL container started by `db-up.ts`.
 *
 * Separate from `db-up.ts` so a contributor can tear the database down without
 * remembering the container name or the `docker rm -f` incantation. Uses only
 * the Docker CLI, so it behaves the same on every platform. Removing a container
 * that does not exist is reported by Docker as a non-zero exit, which is
 * surfaced rather than swallowed so a typo in the container name is visible.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("docker", ["rm", "-f", "pmweb-test-pg"], { stdio: "inherit" });
process.exit(result.status ?? 1);

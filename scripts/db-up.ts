#!/usr/bin/env node
/**
 * Starts a throwaway PostgreSQL 17 container for the test suite and prints the
 * `DATABASE_URL` to use.
 *
 * pm-web requires PostgreSQL by design, and the route-coverage suite talks to a
 * real database instead of stubbing `pool.query`, so a contributor needs one
 * command to get a usable server. The container is named `pmweb-test-pg`, maps
 * host port 55433, and uses the well-known `postgres`/`test` credentials with
 * the `pmwebtest` database — the same values `scripts/with-test-db.ts` defaults
 * to and that CI's service container publishes, so local and CI runs agree.
 *
 * It is deliberately not auto-removed, so a contributor can inspect the data
 * after a failing run; `npm run db:down` stops and removes it. Idempotent: an
 * already-running container just prints the URL, and a stopped one is restarted.
 *
 * Cross-platform by construction: it shells out only to the Docker CLI and
 * sleeps via `Atomics.wait` rather than a `sleep` binary (which does not exist
 * on Windows), so the same script works on every platform CI and contributors
 * use.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/** Name of the throwaway container, shared with `db-down.ts`. */
const CONTAINER = "pmweb-test-pg";
/** Host port. Deliberately not 5432, so it cannot collide with a real local server. */
const PORT = "55433";
/** Database name created by the image's initdb bootstrap. */
const DB = "pmwebtest";
/** The connection string echoed on success, for use as `DATABASE_URL`. */
const URL = `postgres://postgres:test@127.0.0.1:${PORT}/${DB}`;

/**
 * Run a `docker` subcommand and capture its output.
 *
 * @param args Arguments passed to the Docker CLI.
 * @param inherit Stream child output to this process instead of capturing it.
 * @returns The completed spawn result, including `status` and captured streams.
 */
function docker(args: readonly string[], inherit = false): SpawnSyncReturns<string> {
  const result = spawnSync("docker", [...args], {
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
  // When the Docker CLI is missing entirely, spawnSync reports `error` and
  // leaves the captured streams null. Callers read `.stdout.trim()`, so without
  // this the script would die with an opaque "cannot read properties of null"
  // instead of saying what is actually wrong.
  if (result.error) {
    console.error(
      `db-up: could not run the Docker CLI: ${result.error.message}\n` +
        "  Is Docker installed and running? A reachable PostgreSQL is required;\n" +
        "  alternatively point DATABASE_URL at an existing database and skip db:up.",
    );
    process.exit(1);
  }
  return result;
}

/**
 * Poll the container's health status until it reports healthy.
 *
 * Both the create and the restart path need this: `docker run` and `docker
 * start` return as soon as the container is *running*, which is before initdb
 * or crash recovery has finished. Printing the URL at that point invites the
 * caller's very next command to fail with "the database system is starting up".
 *
 * @param reason Word describing what happened, used in the failure message.
 */
function waitUntilHealthy(reason: string): never {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (docker(["inspect", "--format", "{{.State.Health.Status}}", CONTAINER]).stdout.trim() === "healthy") {
      process.stdout.write(`${URL}\n`);
      process.exit(0);
    }
    sleepSeconds(1);
  }
  console.error(
    `db-up: the container ${reason} but never reported healthy.\n` +
      `  Inspect it with: docker logs ${CONTAINER}`,
  );
  process.exit(1);
}

/**
 * Block the current thread for a whole number of seconds.
 *
 * Used while polling the container's health status. `Atomics.wait` is the only
 * synchronous sleep available in Node without spawning a process, and unlike a
 * `sleep` child it exists on Windows too.
 *
 * @param seconds How long to block.
 */
function sleepSeconds(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1_000);
}

// Already running? Nothing to do.
if (docker(["ps", "-q", "-f", `name=^${CONTAINER}$`]).stdout.trim()) {
  process.stdout.write(`${URL}\n`);
  process.exit(0);
}

// Exists but stopped? Restart it, keeping the existing volume, and wait for the
// health check exactly as the create path does — `docker start` returns while
// Postgres is still coming up, so printing the URL here would hand back an
// address that is not yet accepting connections.
if (docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]).status === 0) {
  docker(["start", CONTAINER], true);
  waitUntilHealthy("restarted");
}

const created = docker([
  "run", "-d", "--name", CONTAINER,
  "-e", "POSTGRES_PASSWORD=test",
  "-e", `POSTGRES_DB=${DB}`,
  "-p", `${PORT}:5432`,
  "--health-cmd", `pg_isready -U postgres -d ${DB}`,
  "--health-interval", "1s",
  "--health-timeout", "3s",
  "--health-retries", "30",
  "postgres:17-alpine",
]);
if (created.status !== 0) {
  console.error(`db-up: failed to start the container:\n${created.stderr || ""}`);
  process.exit(1);
}

// initdb takes a second or two; connecting before it finishes yields a confusing
// "the database system is starting up" error, so wait for the health check.
waitUntilHealthy("started");

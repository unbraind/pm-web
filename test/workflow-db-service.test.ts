import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Package root (test/ is compiled to dist-test/, so go up one level from there).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = path.join(packageRoot, ".github", "workflows");

/**
 * Guards the invariant that broke the 2026-07-30 daily release: the coverage
 * gate runs a route suite against a real PostgreSQL database and deliberately
 * refuses to skip when none is reachable, so *every* workflow job that invokes
 * that gate has to supply the database. `ci.yml` did; `release.yml` did not, and
 * nothing failed until the scheduled release tried to run the gate at 06:11 UTC
 * and died before reaching a single real check.
 *
 * The naive guard — "release.yml mentions postgres" — would be worthless: it
 * passes the moment anyone writes the word, and it says nothing about the two
 * workflows agreeing. So this suite instead derives the requirement from the
 * sources of truth and re-checks it against every workflow:
 *
 *  1. which npm scripts need a database is read out of `package.json`, by
 *     transitively following `npm run` edges from any script that wraps itself
 *     in `scripts/with-test-db.ts` — so a newly added wrapper script is covered
 *     automatically rather than needing this list to be maintained by hand;
 *  2. the connection details are read out of `scripts/with-test-db.ts` itself,
 *     so moving the port or database name fails here instead of at 06:11 UTC;
 *  3. every job in every workflow whose steps invoke one of those scripts must
 *     declare a matching service container, matching job env, and a health
 *     check, and all such jobs must agree with each other.
 */

/** Indentation width of a YAML line, or `null` for blank/comment-only lines. */
function indentOf(line: string): number | null {
  if (line.trim() === "" || line.trim().startsWith("#")) return null;
  return line.length - line.trimStart().length;
}

/**
 * Raw lines of the nested block introduced by `<key>:` at `indent`.
 *
 * Returns `undefined` when the key is absent, which is what lets a caller
 * distinguish "job declares no services at all" from "declares the wrong ones".
 */
function blockAt(lines: string[], indent: number, key: string): string[] | undefined {
  const header = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line === header || line.startsWith(`${header} `));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const depth = indentOf(line);
    if (depth !== null && depth <= indent) break;
    body.push(line);
  }
  return body;
}

/** Value of the `<key>: <value>` pair at `indent`, unquoted, or `undefined`. */
function scalarAt(lines: string[], indent: number, key: string): string | undefined {
  const prefix = `${" ".repeat(indent)}${key}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return undefined;
  const value = line.slice(prefix.length).trim();
  return value.replace(/^["']|["']$/g, "");
}

/** Scalar sequence entries (`- item`) at `indent`, unquoted. */
function sequenceAt(lines: string[], indent: number, key: string): string[] {
  const body = blockAt(lines, indent, key) ?? [];
  const entryPrefix = `${" ".repeat(indent + 2)}- `;
  return body
    .filter((line) => line.startsWith(entryPrefix))
    .map((line) => line.slice(entryPrefix.length).trim().replace(/^["']|["']$/g, ""));
}

/** Job name to the job's raw lines, for every job in one workflow file. */
function jobBlocks(text: string): Map<string, string[]> {
  const lines = text.split(/\r?\n/);
  const jobs = blockAt(lines, 0, "jobs") ?? [];
  const blocks = new Map<string, string[]>();
  for (const [index, line] of jobs.entries()) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (!match) continue;
    const body: string[] = [];
    for (const candidate of jobs.slice(index + 1)) {
      const depth = indentOf(candidate);
      if (depth !== null && depth <= 2) break;
      body.push(candidate);
    }
    blocks.set(match[1], body);
  }
  return blocks;
}

/**
 * The npm scripts that cannot run without a database.
 *
 * Seeded with every script that invokes the `with-test-db.ts` wrapper (the one
 * place that refuses to start without a reachable database), then closed over
 * `npm run` references so composite gates like `release:check`, which reach the
 * database only through `coverage`, are included too.
 */
function databaseBackedScripts(): Set<string> {
  const manifest: unknown = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.ok(
    typeof manifest === "object" && manifest !== null && "scripts" in manifest,
    "package.json should declare scripts",
  );
  const scripts = (manifest as { scripts: Record<string, string> }).scripts;
  const required = new Set<string>();
  for (const [name, command] of Object.entries(scripts)) {
    if (command.includes("with-test-db")) required.add(name);
  }
  assert.ok(required.size > 0, "at least one npm script should wrap scripts/with-test-db.ts");
  // Fixpoint over `npm run <name>` edges: repeat until a pass adds nothing, so
  // arbitrarily deep script chains are followed rather than just direct callers.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      if (required.has(name)) continue;
      for (const dependency of command.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        if (!required.has(dependency[1])) continue;
        required.add(name);
        changed = true;
        break;
      }
    }
  }
  return required;
}

/** Connection details the suite defaults to, read from the wrapper script. */
function expectedConnection(): {
  url: string;
  port: string;
  database: string;
  password: string;
  user: string;
} {
  const source = readFileSync(path.join(packageRoot, "scripts", "with-test-db.ts"), "utf8");
  const match = /const DEFAULT_DATABASE_URL = "([^"]+)"/.exec(source);
  assert.ok(match, "scripts/with-test-db.ts should declare DEFAULT_DATABASE_URL");
  const url = new URL(match[1]);
  return {
    url: match[1],
    port: url.port,
    database: url.pathname.replace(/^\//, ""),
    password: decodeURIComponent(url.password),
    user: decodeURIComponent(url.username),
  };
}

/**
 * Script names npm (and bun) accept without an explicit `run`.
 *
 * `npm test` is exactly `npm run test`, and this package's `test` script is
 * database-backed, so a job written that way needs the service just as much as
 * one written `npm run test`. Matching only the explicit form would leave that
 * job silently outside the guard.
 */
const RUNNER_SHORTHAND_SCRIPTS = new Set(["test", "start", "stop", "restart"]);

/**
 * Builds a pattern matching the ways a workflow step can invoke one npm script.
 *
 * Covers the runners this fleet uses (`npm`, `bun`, and the `pnpm`/`yarn` forms
 * for completeness), the `run` and `run-script` spellings, flags between the
 * subcommand and the script name (`npm run --silent coverage`), and npm's
 * built-in shorthands. The trailing lookahead stops `coverage` from matching
 * `coverage:report`, which is a different script.
 *
 * @param script - Script name from package.json.
 * @returns A pattern that matches any accepted invocation of that script.
 */
function invocationPattern(script: string): RegExp {
  const name = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = "(?:-{1,2}[A-Za-z0-9][\\w-]*(?:=\\S+)?\\s+)*";
  const runner = "(?:npm|pnpm|yarn|bun)";
  const forms = [`${runner}\\s+run(?:-script)?\\s+${flags}${name}`];
  if (RUNNER_SHORTHAND_SCRIPTS.has(script)) forms.push(`${runner}\\s+${flags}${name}`);
  return new RegExp(`(?:${forms.join("|")})(?![\\w:.-])`);
}

/** Every `<workflow file, job name, job lines>` triple across the workflows. */
function allJobs(): { file: string; name: string; lines: string[] }[] {
  const files = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, ".github/workflows should contain workflow files");
  return files.flatMap((file) => {
    const text = readFileSync(path.join(workflowDir, file), "utf8");
    return [...jobBlocks(text)].map(([name, lines]) => ({ file, name, lines }));
  });
}

test("the parser used by this guard reads a job's nested structure", () => {
  // Proves the assertions below are reading real structure rather than silently
  // returning `undefined` for everything (which would make them vacuous).
  const jobs = jobBlocks(
    ["jobs:", "  build:", "    runs-on: ubuntu-latest", "    env:", "      A: one", ""].join("\n"),
  );
  const build = jobs.get("build");
  assert.ok(build, "the sample workflow should expose a build job");
  assert.equal(scalarAt(build, 4, "runs-on"), "ubuntu-latest");
  assert.equal(scalarAt(blockAt(build, 4, "env") ?? [], 6, "A"), "one");
  assert.equal(blockAt(build, 4, "services"), undefined);
});

test("the invocation scanner recognises every way a step can run a script", () => {
  // Each of these would run the database-backed `coverage` script, so each has
  // to be seen by the scanner. `npm run coverage` alone was the original gap.
  for (const step of [
    "run: npm run coverage",
    "run: npm run-script coverage",
    "run: npm run --silent coverage",
    "run: bun run coverage",
    "run: |\n  npm ci\n  npm run coverage",
  ]) {
    assert.ok(invocationPattern("coverage").test(step), `should match: ${step}`);
  }

  // `npm test` is npm's shorthand for `npm run test`, and this package's `test`
  // script is database-backed, so the shorthand must be recognised too.
  assert.ok(invocationPattern("test").test("run: npm test"), "should match the npm test shorthand");
  assert.ok(invocationPattern("test").test("run: bun test"), "should match the bun test shorthand");

  // A script with no shorthand must not match a bare mention of its name, or
  // every prose reference in a step would read as an invocation.
  assert.ok(!invocationPattern("coverage").test("run: echo coverage"), "bare name is not a run");
  // A longer script name that merely starts with this one is a different script.
  assert.ok(
    !invocationPattern("coverage").test("run: npm run coverage:report"),
    "coverage:report is a different script",
  );
  assert.ok(
    !invocationPattern("check").test("run: npm run changelog:check"),
    "changelog:check is a different script",
  );
});

test("every workflow job that runs a database-backed script provides the database", () => {
  const required = databaseBackedScripts();
  const connection = expectedConnection();
  const covered: string[] = [];

  for (const job of allJobs()) {
    const steps = (blockAt(job.lines, 4, "steps") ?? []).join("\n");
    const invoked = [...required].filter((script) => invocationPattern(script).test(steps));
    if (invoked.length === 0) continue;
    const where = `${job.file}:${job.name} (runs ${invoked.join(", ")})`;
    covered.push(where);

    const services = blockAt(job.lines, 4, "services");
    assert.ok(services, `${where} must declare a services block for its database`);
    const postgres = blockAt(services, 6, "postgres");
    assert.ok(postgres, `${where} must declare a postgres service`);

    const image = scalarAt(postgres, 8, "image") ?? "";
    assert.match(image, /^postgres:/, `${where} postgres service should use a postgres image`);

    const ports = sequenceAt(postgres, 8, "ports");
    assert.ok(
      ports.some((mapping) => mapping.startsWith(`${connection.port}:`)),
      `${where} must publish host port ${connection.port} to match DEFAULT_DATABASE_URL, got ${JSON.stringify(ports)}`,
    );

    const serviceEnv = blockAt(postgres, 8, "env") ?? [];
    assert.equal(
      scalarAt(serviceEnv, 10, "POSTGRES_DB"),
      connection.database,
      `${where} postgres service must create the ${connection.database} database`,
    );
    assert.equal(
      scalarAt(serviceEnv, 10, "POSTGRES_PASSWORD"),
      connection.password,
      `${where} postgres service password must match DEFAULT_DATABASE_URL`,
    );

    // Without a health check the first step can connect before initdb has
    // finished, which fails intermittently rather than reproducibly.
    assert.ok(
      scalarAt(postgres, 8, "options")?.length,
      `${where} postgres service must declare health-check options`,
    );

    const jobEnv = blockAt(job.lines, 4, "env") ?? [];
    assert.equal(
      scalarAt(jobEnv, 6, "DATABASE_URL"),
      connection.url,
      `${where} must export DATABASE_URL matching DEFAULT_DATABASE_URL`,
    );
    // src/auth.ts reads JWT_SECRET at module load, so it must be present before
    // the test process starts, and long enough to sign with.
    const secret = scalarAt(jobEnv, 6, "JWT_SECRET") ?? "";
    assert.ok(
      secret.length >= 32,
      `${where} must export a JWT_SECRET of at least 32 bytes, got ${secret.length}`,
    );
  }

  // A guard that silently matched nothing would pass forever. Both the CI check
  // and the daily release run the gate, so fewer than two jobs means either a
  // workflow stopped gating or the step-scanning regex above went stale.
  assert.ok(
    covered.length >= 2,
    `expected the CI and release workflows to run a database-backed gate, found ${JSON.stringify(covered)}`,
  );
});

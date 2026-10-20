/** Real built-process regressions for actionable configuration and detached readiness. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { databaseConfigIssues, integerSetting, postgresPort, redactStartupLog, startupConfigIssues } from "../src/startup-config.ts";

/** Capture a subprocess through actual close, rejecting hangs and external signals. */
async function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Unexpected ${signal}: ${output}`));
      else resolve({ code, output });
    });
  });
}

/** Preserve PostgreSQL settings while selecting its supported query-parameter host form. */
function queryHostDatabaseUrl(raw: string): string {
  const source = new URL(raw);
  const uri = new URL(`${source.protocol}///`);
  uri.pathname = source.pathname;
  uri.search = source.search;
  uri.searchParams.set("host", (source.searchParams.get("host") || source.hostname).replace(/^\[|\]$/g, ""));
  uri.searchParams.set("port", source.searchParams.get("port") || source.port || "5432");
  if (source.username) uri.searchParams.set("user", decodeURIComponent(source.username));
  if (source.password) uri.searchParams.set("password", decodeURIComponent(source.password));
  return uri.href;
}

/** Allocate isolated state and a free TCP port, with cleanup of any real detached PID. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-startup-readiness-"));
  const holder = createServer();
  await new Promise<void>((resolve) => { holder.listen(0, "127.0.0.1", resolve); });
  const address = holder.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => { holder.close(() => resolve()); });
  const port = address.port;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", PORT: String(port), PROJECTS_ROOT: root,
    PM_WEB_STATE_DIR: root, JWT_SECRET: "synthetic-private-jwt-signing-secret", PM_WEB_STARTUP_TIMEOUT_MS: "30000",
    PM_REALTIME_ENABLED: "true", PM_WATCH_PROJECTS: "true", PM_REALTIME_MUTATION_EVENTS: "true", LOG_LEVEL: "info" };
  for (const key of Object.keys(env)) if (key.startsWith("OIDC_") || key.startsWith("POSTGRES_")) delete env[key];
  const pidfile = path.join(root, `pm-web-${port}.pid`);
  t.after(async () => {
    if (existsSync(pidfile)) {
      const pid = Number(await readFile(pidfile, "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch { /* The failure path may already have reaped it. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  /** Execute a registered command in a fresh process using the built extension. */
  const command = (name: string, options: Record<string, unknown> = {}, changes: NodeJS.ProcessEnv = {}) =>
    run(["test/helpers/startup-command.ts", name, JSON.stringify({ port, ...options })], { ...env, ...changes });
  /** Require a built detached child to report started and serve healthy JSON. */
  const startHealthy = async (changes: NodeJS.ProcessEnv = {}) => {
    const result = await command("web", { detach: true }, changes);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /"status":"started"/);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
  };
  /** Occupy the chosen port with a separate healthy listener until cleanup. */
  const occupyPort = async () => {
    const listener = createServer((socket) => { socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"ok":true}'); });
    await new Promise<void>((resolve) => { listener.listen(port, resolve); });
    t.after(() => new Promise<void>((resolve) => { listener.close(() => resolve()); }));
  };
  return { root, env, port, pidfile, command, startHealthy, occupyPort };
}

for (const detach of [false, true]) {
  test(`${detach ? "detached" : "foreground"} built startup names missing database settings, refuses success and leaks no secrets`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const result = await f.command("web", { detach }, { DATABASE_URL: undefined });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /DATABASE_URL is not set/);
    assert.match(result.output, /POSTGRES_HOST is missing/);
    assert.match(result.output, /POSTGRES_DB is missing/);
    assert.match(result.output, /export DATABASE_URL/);
    assert.doesNotMatch(result.output, /"status":"started"|pm-web started|synthetic-private/);
    if (detach) {
      assert.match(result.output, /Last child log lines \(redacted\)/);
      assert.match(result.output, /pidfile: absent/);
    } else {
      assert.doesNotMatch(result.output, /Starting pm-web|Press Ctrl\+C/);
    }
    assert.equal(existsSync(f.pidfile), false);
    await assert.rejects(fetch(`http://127.0.0.1:${f.port}/healthz`));
  });
}

test("built server reports every invalid database/port setting before binding without reflecting credentials", async (t) => {
  const f = await fixture(t);
  const result = await run(["dist/server.js"], { ...f.env, DATABASE_URL: "postgres://private-user:private-password@[/secret", PORT: "private-port", PM_WEB_DB_POOL_MAX: "bad-pool" });
  assert.equal(result.code, 1);
  for (const name of ["DATABASE_URL", "PORT", "PM_WEB_DB_POOL_MAX"]) assert.match(result.output, new RegExp(name));
  assert.doesNotMatch(result.output, /private-user|private-password|private-port|bad-pool|postgres:\/\//);
});

test("database preflight accepts empty URL fallback and pg database defaults in built startup and doctor", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const url = new URL(f.env.DATABASE_URL!);
  const database = decodeURIComponent(url.pathname.slice(1));
  const discrete = { DATABASE_URL: "", POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port || "5432",
    POSTGRES_DB: database, POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password) };
  assert.deepEqual(databaseConfigIssues(discrete), []);
  url.pathname = "";
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: url.href }), []);
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: "postgres://fixture@db.example" }), []);
  assert.ok(databaseConfigIssues({ DATABASE_URL: " ", POSTGRES_HOST: "db.example", POSTGRES_DB: "fixture" }).length);
  for (const changes of [discrete, { DATABASE_URL: url.href, PGDATABASE: database }]) {
    await f.startHealthy(changes);
    const doctor = await f.command("web doctor", {}, changes);
    assert.match(doctor.output, /"name":\s*"database",\s*"ok":\s*true/);
    assert.equal((await f.command("web stop")).code, 0);
  }
});

test("credentialed empty-host URLs reach the real database through built startup and both doctors", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const original = new URL(f.env.DATABASE_URL!);
  const url = new URL(queryHostDatabaseUrl(original.href));
  url.searchParams.delete("user");
  url.searchParams.delete("password");
  const connectionString = `${url.protocol}//${original.username}:${original.password}@${url.pathname}${url.search}`;
  const changes = { DATABASE_URL: connectionString };
  assert.deepEqual(databaseConfigIssues(changes), []);
  await f.startHealthy(changes);
  const doctor = await f.command("web doctor", {}, changes);
  assert.match(doctor.output, /"name":\s*"database",\s*"ok":\s*true/);
  const source = await run(["test/helpers/source-doctor-command.ts"], { ...f.env, ...changes });
  assert.equal(source.code, 0, source.output);
  assert.equal((JSON.parse(source.output) as { ok: boolean }).ok, true);
  assert.equal((await f.command("web stop")).code, 0);
});

test("empty optional numeric settings preserve runtime defaults and reject explicit invalid values", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const empty = { PORT: "", PM_WEB_DB_POOL_MAX: "", PM_WEB_STARTUP_TIMEOUT_MS: "" };
  assert.deepEqual(startupConfigIssues({ ...f.env, ...empty }), []);
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: "", POSTGRES_HOST: "db.example", POSTGRES_DB: "fixture", POSTGRES_PORT: "" }), []);
  assert.equal(postgresPort({ POSTGRES_PORT: "" }), 5432);
  assert.equal(postgresPort({}), 5432);
  for (const value of [" ", "bad", "0", "65536"]) assert.throws(() => postgresPort({ POSTGRES_PORT: value }), /POSTGRES_PORT must be/);
  for (const name of Object.keys(empty)) {
    assert.match(startupConfigIssues({ ...f.env, [name]: "bad" }).join(), new RegExp(name));
  }
  await f.startHealthy(empty);
  assert.equal((await f.command("web stop")).code, 0);
  const invalidFlag = await f.command("web", { detach: true, startupTimeout: "" });
  assert.equal(invalidFlag.code, 1, invalidFlag.output);
  assert.match(invalidFlag.output, /must be an integer/);
});

test("OIDC preflight preserves non-production soft disable and production refusal", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const incomplete = { OIDC_CLIENT_SECRET: "synthetic-client-secret" };
  const invalid = { ...incomplete, OIDC_ISSUER: "https://issuer.example", OIDC_CLIENT_ID: "fixture",
    OIDC_REDIRECT_URI: "https://app.example/callback", OIDC_COOKIE_SECRET: "short-private-cookie" };
  for (const configuration of [incomplete, invalid]) {
    for (const mode of [undefined, "development", "test"]) {
      assert.deepEqual(startupConfigIssues({ ...f.env, ...configuration, NODE_ENV: mode }), []);
    }
    assert.match(startupConfigIssues({ ...f.env, ...configuration }).join(), /OIDC_/);
    const refused = await run(["dist/server.js"], { ...f.env, ...configuration });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /startup preflight failed/);
    assert.doesNotMatch(refused.output, /synthetic-client-secret|short-private-cookie|server_started/);
    for (const mode of ["development", "test"]) {
      await f.startHealthy({ ...configuration, NODE_ENV: mode });
      assert.equal((await f.command("web stop")).code, 0);
    }
  }
});

test("foreground banner appears after valid preflight even when a later bind fails", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  await f.occupyPort();
  const result = await f.command("web");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, new RegExp(`Starting pm-web on port ${f.port}`));
  assert.match(result.output, /Press Ctrl\+C/);
  assert.match(result.output, /bind_error/);
  assert.doesNotMatch(result.output, /startup preflight failed/);
});

test("detached startup waits for real health, survives parent exit, and rejects a live pidfile", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.pidfile, "invalid-stale-pid");
  await f.startHealthy();
  const pid = Number(await readFile(f.pidfile, "utf8"));
  assert.ok(pid > 0);
  await delay(100);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/healthz`)).status, 200);
  const duplicate = await f.command("web", { detach: true });
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.output, /live PID/);
  assert.equal(Number(await readFile(f.pidfile, "utf8")), pid);
  assert.equal((await f.command("web stop")).code, 0);
});

test("detached unhealthy child times out, reports redacted logs, and removes stale pidfiles", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const invalidRoot = path.join(f.root, "file-instead-of-directory");
  await writeFile(invalidRoot, "synthetic");
  await writeFile(f.pidfile, "invalid-stale-pid");
  const result = await f.command("web", { detach: true, startupTimeout: "3500" }, { PROJECTS_ROOT: invalidRoot, PM_WEB_STARTUP_TIMEOUT_MS: "invalid-overridden-setting" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /health timeout after 3500ms/);
  assert.match(result.output, /Last child log lines \(redacted\)/);
  assert.match(result.output, /pidfile: absent/);
  assert.doesNotMatch(result.output, /synthetic-private|"status":"started"/);
  assert.equal(existsSync(f.pidfile), false);
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/healthz`));
});

test("an unrelated healthy listener cannot satisfy detached startup", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  await f.occupyPort();
  const result = await f.command("web", { detach: true });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /child exited before becoming healthy/);
  assert.match(result.output, /bind_error/);
  assert.equal(existsSync(f.pidfile), false);
});

test("doctor process checks database configuration, reachability and schema version read-only", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const missing = await f.command("web doctor", {}, { DATABASE_URL: undefined });
  assert.match(missing.output, /"name":\s*"database",\s*"ok":\s*false/);
  assert.match(missing.output, /configured: no; reachable: unchecked; schema version: unchecked/);
  const unreachable = await f.command("web doctor", {}, { DATABASE_URL: `postgres://private-user:private-password@127.0.0.1:${f.port}/absent` });
  assert.match(unreachable.output, /configured: yes; reachable: no/);
  assert.doesNotMatch(unreachable.output, /private-user|private-password|postgres:\/\//);
  const invalidCertificate = new URL(process.env.DATABASE_URL!);
  invalidCertificate.searchParams.set("sslcert", "missing-synthetic-private-certificate.pem");
  const invalidClient = await f.command("web doctor", {}, { DATABASE_URL: invalidCertificate.href });
  assert.equal(invalidClient.code, 0, invalidClient.output);
  assert.match(invalidClient.output, /configured: yes; reachable: no/);
  assert.doesNotMatch(invalidClient.output, /missing-synthetic-private-certificate|postgres:\/\//);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const schema = `doctor_${f.port}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const blank = await f.command("web doctor", {}, { DATABASE_URL: url.href });
  assert.match(blank.output, /schema version: missing/);
  const unchanged = await client.query("SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = $1", [schema]);
  assert.equal(unchanged.rows[0].count, "0", "doctor must never migrate an empty database");
  await client.query(`SET search_path TO ${schema}`);
  await client.query(await readFile("sql/schema.sql", "utf8"));
  await client.query("RESET search_path");
  const packagedSchema = await f.command("web doctor", {}, { DATABASE_URL: url.href });
  assert.match(packagedSchema.output, /"name":\s*"database",\s*"ok":\s*true/);
  await client.query(`UPDATE ${schema}.pm_web_schema_version SET version = 2`);
  const mismatch = await f.command("web doctor", {}, { DATABASE_URL: url.href });
  assert.match(mismatch.output, /schema version: 2 \(expected 1\)/);
  assert.match(mismatch.output, /"name":\s*"database",\s*"ok":\s*false/);
  const healthy = await f.command("web doctor");
  assert.match(healthy.output, /"name":\s*"database",\s*"ok":\s*true/);
  assert.match(healthy.output, /schema version: 1 \(expected 1\)/);
  const discrete = await f.command("web doctor", {}, {
    DATABASE_URL: undefined, POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port,
    POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)), POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password),
  });
  assert.match(discrete.output, /"name":\s*"database",\s*"ok":\s*true/);
  const human = await run(["test/helpers/startup-doctor-human.ts"], f.env);
  assert.match(human.output, /\[ok\] database: configured: yes; reachable: yes; schema version: 1/);
});

test("configuration validation and log redaction never echo supplied values", () => {
  assert.equal(integerSetting("0", "PORT", 0, 65535), 0);
  for (const value of ["-1", "2.5", "65536", "1junk"]) assert.throws(() => integerSetting(value, "PORT", 0, 65535), /PORT must be/);
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: "postgresql://user:secret@db.example/test" }), []);
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: "postgres:///test?host=db.example" }), []);
  assert.match(databaseConfigIssues({ POSTGRES_HOST: "db.example", POSTGRES_DB: "test", POSTGRES_PORT: "bad" }).join(), /POSTGRES_PORT/);
  assert.match(startupConfigIssues({ NODE_ENV: "production", OIDC_CLIENT_SECRET: "secret-value" }).join(), /OIDC_ISSUER/);
  assert.equal(redactStartupLog("postgres://user:secret@db.example/test secret-value", { JWT_SECRET: "secret-value" }), "[redacted PostgreSQL URL] [redacted]");
  assert.equal(redactStartupLog("private-provider-key", { OLLAMA_API_KEY: "private-provider-key" }), "[redacted]");
});

test("SDK-dispatched reads and writes work in a plain-directory tracker with no git executable", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const emptyPath = path.join(f.root, "no-executables");
  await mkdir(emptyPath);
  const result = await run(["test/helpers/startup-no-git.ts"], { ...f.env, PATH: emptyPath, GIT_CEILING_DIRECTORIES: path.dirname(f.root) });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /SDK create\/get\/update\/list passed without git/);
});


test("real CLI honors the parsed startup-timeout flag in a plain-directory tracker", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const cli = path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const pmRoot = path.join(f.root, ".agents", "pm");
  const env = { ...f.env, DATABASE_URL: undefined, PM_GLOBAL_PATH: path.join(f.root, "global"), GIT_CEILING_DIRECTORIES: path.dirname(f.root) };
  const initialized = await run([cli, "--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], env, f.root);
  assert.equal(initialized.code, 0, initialized.output);
  const extensionRoot = path.join(pmRoot, "extensions", "pm-web");
  await mkdir(extensionRoot, { recursive: true });
  await cp("dist", path.join(extensionRoot, "dist"), { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(file, path.join(extensionRoot, file));
  await symlink(path.resolve("node_modules"), path.join(extensionRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const result = await run([cli, "--pm-path", pmRoot, "web", "--detach", "--port", String(f.port), "--startup-timeout", "1", "--json"], env, f.root);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /health timeout after 1ms/);
  assert.match(result.output, /pidfile: absent/);
  assert.doesNotMatch(result.output, /pm-web started|synthetic-private-jwt/);
  assert.equal(existsSync(f.pidfile), false);
  const foreground = await run([cli, "--pm-path", pmRoot, "web", "--port", String(f.port), "--json"], env, f.root);
  assert.equal(foreground.code, 1, foreground.output);
  assert.match(foreground.output, /startup preflight failed|DATABASE_URL is not set/);
  assert.doesNotMatch(foreground.output, /Starting pm-web|Press Ctrl\+C/);
});

test("source helper preserves built-server readiness, failure cleanup and live pidfile ownership", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const helper = ["test/helpers/source-detached-command.ts"];
  const missing = await run(helper, { ...f.env, DATABASE_URL: undefined });
  assert.equal(missing.code, 1, missing.output);
  assert.match(missing.output, /DATABASE_URL is not set/);
  assert.match(missing.output, /pidfile: absent/);
  assert.equal(existsSync(f.pidfile), false);
  const invalidRoot = path.join(f.root, "unavailable-volume");
  await writeFile(invalidRoot, "synthetic");
  const unhealthy = await run(helper, { ...f.env, PROJECTS_ROOT: invalidRoot, PM_WEB_STARTUP_TIMEOUT_MS: "8000" });
  assert.equal(unhealthy.code, 1, unhealthy.output);
  assert.match(unhealthy.output, /health timeout after 8000ms/);
  assert.equal(existsSync(f.pidfile), false);
  await writeFile(f.pidfile, "stale-invalid-pid");
  const healthy = await run(helper, { ...f.env, DATABASE_URL: queryHostDatabaseUrl(f.env.DATABASE_URL!) });
  assert.equal(healthy.code, 0, healthy.output);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/healthz`)).status, 200);
  const pid = await readFile(f.pidfile, "utf8");
  const live = await run(helper, f.env);
  assert.equal(live.code, 1, live.output);
  assert.match(live.output, /live PID/);
  assert.equal(await readFile(f.pidfile, "utf8"), pid);
  assert.equal((await f.command("web stop")).code, 0);
});

test("source database diagnostic checks real discrete credentials and redacts configuration failures", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  /** Keep the source and packaged diagnostic contracts observable over process boundaries. */
  const probe = async (changes: NodeJS.ProcessEnv = {}) => {
    const result = await run(["test/helpers/source-doctor-command.ts"], { ...f.env, ...changes });
    assert.equal(result.code, 0, result.output);
    return { result: JSON.parse(result.output) as { ok: boolean; detail: string }, output: result.output };
  };
  const healthy = await probe();
  assert.equal(healthy.result.ok, true);
  assert.match(healthy.result.detail, /schema version: 1/);
  const parameterized = await probe({ DATABASE_URL: queryHostDatabaseUrl(f.env.DATABASE_URL!) });
  assert.equal(parameterized.result.ok, true);
  const url = new URL(f.env.DATABASE_URL!);
  const discrete = await probe({ DATABASE_URL: undefined, POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port,
    POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)), POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password) });
  assert.equal(discrete.result.ok, true);
  const missing = await probe({ DATABASE_URL: undefined });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.detail, /configured: no/);
  const unreachable = await probe({ DATABASE_URL: `postgres://private-user:private-password@127.0.0.1:${f.port}/absent` });
  assert.equal(unreachable.result.ok, false);
  assert.match(unreachable.result.detail, /reachable: no/);
  assert.doesNotMatch(unreachable.output, /private-user|private-password|postgres:\/\//);
  url.searchParams.set("sslcert", "missing-synthetic-private-certificate.pem");
  const certificate = await probe({ DATABASE_URL: url.href });
  assert.equal(certificate.result.ok, false);
  assert.doesNotMatch(certificate.output, /missing-synthetic-private-certificate|postgres:\/\//);
});

test("redacted log tails omit incomplete oversized credential lines", { timeout: 60_000 }, async (t) => {
  for (const newline of [false, true]) {
    const f = await fixture(t);
    const preload = path.join(f.root, "bootstrap-log.cjs");
    await writeFile(preload, 'const uri = "postgres://fixture:" + "padding".repeat(5000) + "log-tail-private-credential@db.example/fixture"; require("node:fs").writeSync(1, uri + (process.env.TEST_LOG_NEWLINE === "true" ? String.fromCharCode(10) : "")); process.exit(1);\n');
    const result = await run(["test/helpers/source-detached-command.ts"], { ...f.env,
      TEST_CHILD_NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_LOG_NEWLINE: String(newline) });
    const rawLog = await readFile(`${f.pidfile}.log`, "utf8");
    assert.ok(rawLog.length > 16384, "the real child must exceed the retained log window");
    assert.ok(rawLog.includes("log-tail-private-credential"), "the private log must contain the synthetic marker");
    assert.equal(rawLog.endsWith("\n"), newline);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /pidfile: absent/);
    assert.doesNotMatch(result.output, /log-tail-private-credential|postgres:\/\//);
    assert.equal(existsSync(f.pidfile), false);
  }
});

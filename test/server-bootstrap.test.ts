/** Production bootstrap refusal, dependency health and lifecycle over real HTTP/PostgreSQL. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { pool } from "../src/db.ts";
import sourceExtension from "../src/index.ts";
import { withExtensionBootstrap } from "./helpers/extension-bootstrap.ts";
import { withEmptySigningSecret } from "./helpers/empty-signing-secret.ts";
import { authHeaders, ensureSchema, seedProject, seedUser } from "./helpers/pg-harness.ts";

/** Poll observable state under a deadline that includes loaded-host process startup. */
async function eventually(predicate: () => boolean | Promise<boolean>, detail: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(detail());
}

/** Keep bootstrap tests independent of ambient optional services and configuration. */
function bootstrapEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", PORT: "0", PROJECTS_ROOT: root,
    PM_REALTIME_ENABLED: "true", PM_WATCH_PROJECTS: "true", PM_REALTIME_MUTATION_EVENTS: "true", LOG_LEVEL: "info" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OIDC_") || key.startsWith("NEO4J_") || key === "PM_WEB_BOOTSTRAP_ADMIN_EMAIL") delete env[key];
  }
  return env;
}

/** Seed durable ownership evidence for lifecycle tests, then cascade-clean it. */
async function bootstrapProject(t: test.TestContext) {
  await ensureSchema();
  const owner = await seedUser();
  const project = await seedProject(owner.id);
  t.after(() => pool.query("DELETE FROM pm_users WHERE id = $1", [owner.id]));
  return { owner, project };
}

/** Spawn the actual entrypoint, retaining exit status, diagnostics and a scoped cleanup. */
async function bootstrap(t: test.TestContext, changes: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-bootstrap-"));
  const applicationName = `bootstrap-${randomUUID()}`;
  assert.ok(process.env.DATABASE_URL, "run through with-test-db");
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set("application_name", applicationName);
  const env: NodeJS.ProcessEnv = { ...bootstrapEnv(root), DATABASE_URL: databaseUrl.href, ...changes };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, ["src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  for (const channel of ["stdout", "stderr"] as const) {
    child[channel].setEncoding("utf8").on("data", (chunk: string) => { output[channel] += chunk; });
  }
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("close", (code, signal) => { result = { code, signal }; });
  t.after(async () => {
    if (!result) {
      child.kill("SIGKILL");
      await eventually(() => result !== undefined, () => "bootstrap child did not exit during cleanup");
    }
    await rm(root, { recursive: true, force: true });
  });
  /** Parse only complete structured records emitted by the production logger. */
  const logs = () => output.stdout.split("\n").slice(0, -1).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
  /** Require an actual numeric exit; a timeout or external signal cannot satisfy a refusal. */
  const exited = async () => {
    await eventually(() => result !== undefined, () => `bootstrap did not exit: ${output.stdout} ${output.stderr}`);
    assert.ok(result);
    return result;
  };
  /** Discover the actual ephemeral listening port from the server's structured event. */
  const listening = async () => {
    await eventually(() => result !== undefined || logs().some((log) => log.event === "server_started"), () => `bootstrap did not listen: ${output.stdout} ${output.stderr}`);
    assert.equal(result, undefined, `unexpected bootstrap exit: ${output.stdout} ${output.stderr}`);
    const port = logs().find((log) => log.event === "server_started")?.port;
    assert.equal(typeof port, "number");
    return `http://127.0.0.1:${Number(port)}`;
  };
  return { child, root, applicationName, logs, exited, listening, stderr: () => output.stderr };
}

test("production startup refuses absent JWT secrets and incomplete OIDC before listening", { timeout: 90_000 }, async (t) => {
  const missingJwt = await bootstrap(t, { JWT_SECRET: undefined });
  assert.deepEqual(await missingJwt.exited(), { code: 1, signal: null });
  assert.match(missingJwt.stderr(), /JWT_SECRET is required/);
  assert.ok(!missingJwt.logs().some((log) => log.event === "server_started"));
  const missingCookieSecret = await bootstrap(t, {
    OIDC_ISSUER: "https://issuer.example", OIDC_CLIENT_ID: "synthetic-client",
    OIDC_CLIENT_SECRET: "synthetic-client-secret", OIDC_REDIRECT_URI: "https://app.example/api/oidc/callback",
  });
  assert.deepEqual(await missingCookieSecret.exited(), { code: 1, signal: null });
  assert.ok(missingCookieSecret.logs().some((log) => log.event === "configuration_error"));
  assert.ok(!missingCookieSecret.logs().some((log) => log.event === "server_started"));
  assert.ok(!JSON.stringify(missingCookieSecret.logs()).includes("synthetic-client-secret"));
});

test("a real database connection failure refuses startup instead of reporting a listener", { timeout: 45_000 }, async (t) => {
  const reserver = createServer();
  await new Promise<void>((resolve) => { reserver.listen(0, "127.0.0.1", resolve); });
  const address = reserver.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => { reserver.close(() => resolve()); });
  const f = await bootstrap(t, { DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:${address.port}/absent?connect_timeout=2` });
  assert.deepEqual(await f.exited(), { code: 1, signal: null });
  assert.ok(f.logs().some((log) => log.event === "initialization_error"));
  assert.ok(!f.logs().some((log) => log.event === "server_started"));
});

test("an occupied HTTP port fails startup without a false running event", { timeout: 45_000 }, async (t) => {
  const occupied = createServer();
  await new Promise<void>((resolve) => { occupied.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve) => { occupied.close(() => resolve()); }));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const f = await bootstrap(t, { PORT: String(address.port) });
  assert.deepEqual(await f.exited(), { code: 1, signal: null });
  assert.ok(f.logs().some((log) => log.event === "bind_error"));
  assert.ok(!f.logs().some((log) => log.event === "server_started"));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} closes an active HTTP event stream, PostgreSQL listener and server`, { timeout: 60_000 }, async (t) => {
    const { owner, project } = await bootstrapProject(t);
    const f = await bootstrap(t);
    const url = await f.listening();
    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
    const body = await health.json() as { ok: boolean; dependencies: Record<string, { ok: boolean }> };
    assert.equal(body.ok, true);
    for (const name of ["postgres", "projects_root", "project_watcher"]) assert.equal(body.dependencies[name].ok, true, name);
    const connected = await pool.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1", [f.applicationName]);
    assert.ok(Number(connected.rows[0].count) >= 1, "the running server must own a real PostgreSQL connection");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const stream = await fetch(`${url}/api/projects/${project.id}/pm/events`, { headers: authHeaders(owner), signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false, "receive the live connection frame before shutdown");
    f.child.kill(signal);
    assert.deepEqual(await f.exited(), { code: 0, signal: null });
    let ended = false;
    await eventually(async () => { ended = (await reader.read()).done === true; return ended; }, () => "SSE response must end during graceful shutdown");
    assert.equal(ended, true);
    const released = await pool.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1", [f.applicationName]);
    assert.equal(Number(released.rows[0].count), 0);
    await assert.rejects(fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1_000) }));
  });
}

test("the production health endpoint reports a failed projects volume alongside healthy PostgreSQL", { timeout: 45_000 }, async (t) => {
  const f = await bootstrap(t);
  const url = await f.listening();
  await rm(f.root, { recursive: true, force: true });
  await writeFile(f.root, "synthetic unavailable projects volume");
  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 503);
  const body = await response.json() as { ok: boolean; dependencies: Record<string, { ok: boolean; error?: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.dependencies.postgres.ok, true);
  assert.equal(body.dependencies.projects_root.ok, false);
  assert.ok(body.dependencies.projects_root.error);
  assert.ok(!JSON.stringify(body).includes(f.root), "unauthenticated diagnostics must not expose storage paths");
  f.child.kill("SIGTERM");
  assert.deepEqual(await f.exited(), { code: 0, signal: null });
});

test("the extension starts, probes and stops PostgreSQL servers and propagates child startup failures", { timeout: 60_000 }, async (t) => {
  const { owner, project } = await bootstrapProject(t);
  await withExtensionBootstrap(t, bootstrapEnv, async ({ host, root, detached }) => {
    const portHolder = createServer();
    await new Promise<void>((resolve) => { portHolder.listen(0, "127.0.0.1", resolve); });
    const address = portHolder.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve) => { portHolder.close(() => resolve()); });
    const port = address.port;
    const started = await host.runCommand({ command: "web", options: { port, detach: true } });
    assert.equal(started.handled, true);
    const result = started.result as { pid: number; status: string };
    assert.equal(result.status, "started");
    const pid = result.pid;
    detached.pid = pid;
    assert.ok(pid > 0);
    assert.equal(await readFile(path.join(root, `pm-web-${port}.pid`), "utf8"), String(pid));
    await eventually(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).status === 200; }
      catch { return false; }
    }, () => "detached server must become healthy");
    const duplicate = await host.runCommand({ command: "web", options: { port, detach: true } });
    assert.deepEqual(duplicate.result, { status: "already_running", pid });
    const status = await host.runCommand({ command: "web status", options: { port }, global: { json: true } });
    assert.ok(isHostOutputSuppressed(status.result));
    assert.equal((status.result.result as { status: string }).status, "up");
    const stopped = await host.runCommand({ command: "web stop", options: { port }, global: { json: true } });
    assert.ok(isHostOutputSuppressed(stopped.result));
    assert.equal((stopped.result.result as { status: string }).status, "stopped");
    await eventually(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return true; }
    }, () => "stopped detached server must exit");
    delete detached.pid;
    await assert.rejects(readFile(path.join(root, `pm-web-${port}.pid`)), { code: "ENOENT" });
    await withEmptySigningSecret(async () => {
      await assert.rejects(host.runCommand({ command: "web", options: { port } }), {
        name: "CommandError", message: /startup preflight failed:[\s\S]*JWT_SECRET is required/, exitCode: 1,
      });
    });
    // The source wrapper has no emitted server sibling. Exercise its real child
    // failure through the shipped host, including the numeric command error.
    const sourceHost = await createExtensionTestHarness(sourceExtension, { name: "pm-web", capabilities: ["commands", "schema"] });
    t.after(() => sourceHost.deactivate());
    await assert.rejects(readFile(new URL("../src/server.js", import.meta.url)), { code: "ENOENT" });
    await assert.rejects(sourceHost.runCommand({ command: "web", options: { port } }), {
      name: "CommandError", message: "pm-web exited with code 1", exitCode: 1,
    });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) }));
    const unchanged = await pool.query<{ user_id: string }>("SELECT user_id FROM pm_projects WHERE id = $1", [project.id]);
    assert.equal(unchanged.rows[0].user_id, owner.id, "failed launch must not alter existing project ownership");
  });
});

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { emitOwnedOutput } from "../src/index.ts";

/**
 * Activate pm-web through pm's real host engine with the manifest's declared
 * capabilities.
 *
 * This deliberately replaces the hand-rolled `api` double these tests used to
 * build. A double accepts every registration unconditionally, so it cannot
 * observe host-side rejection — which is how `--json` flags that shadow a
 * host-owned global stayed green in CI while the affected commands failed to
 * register against a real pm host. The harness runs the same validation the
 * CLI runs, so an invalid registration fails the suite here.
 */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-web",
    capabilities: ["commands", "schema"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

/** Reserve and release an ephemeral loopback port for a child server test. */
async function ephemeralPort(): Promise<number> {
  const reserver = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reserver.once("error", reject);
    reserver.listen(0, "127.0.0.1", resolve);
  });
  const address = reserver.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reserver.close((err) => err ? reject(err) : resolve());
  });
  return port;
}

/** Extract the extension value retained by the real host command runner. */
function commandResult(value: { handled: boolean; result: unknown }): unknown {
  assert.equal(value.handled, true);
  return isHostOutputSuppressed(value.result) ? value.result.result : value.result;
}

test("pm-web extension activates cleanly against the real pm host", async () => {
  const ext = await harness();
  assert.strictEqual(ext.name, "pm-web");
  await ext.deactivate();
});

test("pm-web registers web, status, stop and doctor commands", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "web", flags: ["--port", "--detach"] });
  ext.assertCommandContract({ name: "web status", flags: ["--port"] });
  ext.assertCommandContract({ name: "web stop", flags: ["--port"] });
  ext.assertCommandContract({ name: "web doctor", flags: ["--port"] });

  await ext.deactivate();
});

test("command-owned output is single-write JSON or human text with a retained result", (context) => {
  const writes: string[] = [];
  context.mock.method(console, "log", (value: unknown) => writes.push(String(value)));

  const result = { status: "down", port: 61115 };
  const json = emitOwnedOutput(true, result, ["human fallback"]);
  assert.equal(isHostOutputSuppressed(json), true);
  assert.deepEqual(json.result, result);
  assert.deepEqual(writes, [JSON.stringify(result, null, 2)]);

  writes.length = 0;
  const human = emitOwnedOutput(false, result, ["first", "second"]);
  assert.equal(isHostOutputSuppressed(human), true);
  assert.deepEqual(human.result, result);
  assert.deepEqual(writes, ["first", "second"]);
});

test("server entrypoint exits non-zero without DATABASE_URL", () => {
  // Spawns src/server.ts directly so the entrypoint contributes coverage.
  // Without a database the server must fail fast rather than hang.
  // The outcome is captured rather than asserted inside the try: an
  // `assert.fail()` there would be caught by this handler and then satisfy a
  // loose `status !== 0` check, so a server that started cleanly — or a run
  // that timed out, where `status` is undefined — would read as the expected
  // failure and the test could never fail.
  let status: number | undefined;
  let startedCleanly = false;
  try {
    execFileSync(process.execPath, ["src/server.ts"], {
      cwd: process.cwd(),
      // src/db.ts accepts POSTGRES_HOST + POSTGRES_DB as an alternative to
      // DATABASE_URL, so clearing only the latter would leave the server
      // configured on any machine that sets the discrete vars — the test would
      // then fail for an environmental reason rather than assert anything.
      env: { ...process.env, DATABASE_URL: "", POSTGRES_HOST: "", POSTGRES_DB: "" },
      encoding: "utf-8",
      timeout: 10000,
    });
    startedCleanly = true;
  } catch (err) {
    status = (err as { status?: number }).status;
  }

  assert.equal(startedCleanly, false, "server started without DATABASE_URL; it must fail fast instead");
  assert.equal(
    typeof status,
    "number",
    `expected the child to report an exit code; got ${status} (a killed or timed-out child reports none)`,
  );
  assert.notEqual(status, 0, "expected a non-zero exit code");
});

test("production server bootstrap listens on an ephemeral port and answers HTTP", { timeout: 30_000 }, async () => {
  const port = await ephemeralPort();
  const root = mkdtempSync(join(tmpdir(), "pm-web-"));
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PROJECTS_ROOT: root,
      PM_REALTIME_MUTATION_EVENTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start; stdout=${stdout} stderr=${stderr}`)), 20_000);
      const inspect = () => {
        if (stdout.includes(`pm-web running on :${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", inspect);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited before listening: code=${code} signal=${signal}; stderr=${stderr}`));
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.json() as { ok: boolean; version: string };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.version, /^2026\./);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered status, doctor, and stop commands use real environment state", { timeout: 30_000 }, async () => {
  const port = await ephemeralPort();
  const root = mkdtempSync(join(tmpdir(), "pm-web-"));
  const pmRoot = join(root, ".agents", "pm");
  const stateDir = join(root, "state");
  mkdirSync(pmRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(pmRoot, "settings.json"), "{}\n", "utf8");
  const previousProjectsRoot = process.env.PROJECTS_ROOT;
  const previousStateDir = process.env.PM_WEB_STATE_DIR;
  process.env.PROJECTS_ROOT = root;
  process.env.PM_WEB_STATE_DIR = stateDir;
  let ext: Awaited<ReturnType<typeof harness>> | undefined;
  let target: ReturnType<typeof spawn> | null = null;

  try {
    ext = await harness();
    const down = commandResult(await ext.runCommand({ command: "web status", options: { port }, pmRoot })) as { status?: string; port?: number };
    assert.equal(down.status, "down");
    assert.equal(down.port, port);

    const doctor = commandResult(await ext.runCommand({ command: "web doctor", options: { port }, pmRoot })) as { version?: string; port?: number };
    assert.match(doctor.version ?? "", /^2026\./);
    assert.equal(doctor.port, port);

    let healthStatus = 200;
    let healthBody = JSON.stringify({ ok: true, version: "test-version" });
    const healthServer = createHttpServer((_request, response) => {
      response.writeHead(healthStatus, { "content-type": "application/json" });
      response.end(healthBody);
    });
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(port, "127.0.0.1", resolve);
    });
    try {
      const up = commandResult(await ext.runCommand({ command: "web status", options: { port }, global: { json: false }, pmRoot })) as { status?: string; version?: string };
      assert.equal(up.status, "up");
      assert.equal(up.version, "test-version");

      healthStatus = 503;
      healthBody = "not-json";
      const degraded = commandResult(await ext.runCommand({ command: "web status", options: { port }, global: { json: false }, pmRoot })) as { status?: string; version?: string | null };
      assert.equal(degraded.status, "degraded");
      assert.equal(degraded.version, null);

      const occupiedDoctor = commandResult(await ext.runCommand({ command: "web doctor", options: { port }, pmRoot })) as { checks?: Array<{ name: string; ok: boolean }> };
      assert.equal(occupiedDoctor.checks?.find((check) => check.name === "port_available")?.ok, false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        healthServer.close((err) => err ? reject(err) : resolve());
      });
    }

    const stopped = commandResult(await ext.runCommand({ command: "web stop", options: { port }, pmRoot })) as { status?: string; port?: number };
    assert.equal(stopped.status, "not_running");
    assert.equal(stopped.port, port);

    writeFileSync(join(stateDir, `pm-web-${port}.pid`), "2147483647\n", "utf8");
    const stale = commandResult(await ext.runCommand({ command: "web stop", options: { port }, pmRoot })) as { status?: string; pid?: number };
    assert.equal(stale.status, "not_running");
    assert.equal(stale.pid, 2147483647);

    const startedTarget = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    target = startedTarget;
    assert.equal(typeof startedTarget.pid, "number");
    writeFileSync(join(stateDir, `pm-web-${port}.pid`), `${startedTarget.pid}\n`, "utf8");
    const terminated = commandResult(await ext.runCommand({ command: "web stop", options: { port }, pmRoot })) as { status?: string; pid?: number };
    assert.equal(terminated.status, "stopped");
    assert.equal(terminated.pid, startedTarget.pid);
    await new Promise<void>((resolve) => {
      if (startedTarget.exitCode !== null || startedTarget.signalCode !== null) resolve();
      else startedTarget.once("exit", () => resolve());
    });
  } finally {
    if (target && target.exitCode === null && target.signalCode === null) {
      target.kill("SIGTERM");
      await new Promise<void>((resolve) => { target?.once("exit", () => { resolve(); }); });
    }
    await ext?.deactivate();
    if (previousProjectsRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousProjectsRoot;
    if (previousStateDir === undefined) delete process.env.PM_WEB_STATE_DIR;
    else process.env.PM_WEB_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the commands that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});

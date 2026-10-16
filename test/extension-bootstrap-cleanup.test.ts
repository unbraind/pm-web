/** Failure-path proofs for the real extension fixture's environment and process ownership. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withExtensionBootstrap } from "./helpers/extension-bootstrap.ts";

/** Restore ambient state and reap children even when testing a reverted cleanup. */
function failureSafetyNet(t: test.TestContext, saved: NodeJS.ProcessEnv) {
  const resources: { root?: string; child?: ChildProcess; closed?: Promise<void> } = {};
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    if (resources.child && resources.child.exitCode === null && resources.child.signalCode === null) resources.child.kill("SIGKILL");
    await resources.closed;
    if (resources.root) await rm(resources.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return resources;
}

/** Compare environment values without printing potentially sensitive contents on failure. */
function assertEnvironmentRestored(saved: NodeJS.ProcessEnv): void {
  const keys = Object.keys(process.env).sort();
  assert.ok(JSON.stringify(keys) === JSON.stringify(Object.keys(saved).sort()), "environment keys must be restored");
  for (const key of keys) assert.ok(process.env[key] === saved[key], `environment value must be restored: ${key}`);
}

test("extension fixture restores environment and removes workspace when host creation rejects", async (t) => {
  const saved = { ...process.env };
  const resources = failureSafetyNet(t, saved);
  const failure = new Error("injected harness creation failure");
  await assert.rejects(withExtensionBootstrap(t, (root) => {
    resources.root = root;
    return { PROJECTS_ROOT: root, PM_BOOTSTRAP_SYNTHETIC: "changed" };
  }, async () => { assert.fail("a rejected host must not run the test body"); }, async () => {
    assert.equal(process.env.PM_BOOTSTRAP_SYNTHETIC, "changed");
    throw failure;
  }), failure);
  assertEnvironmentRestored(saved);
  assert.ok(resources.root);
  await assert.rejects(access(resources.root), { code: "ENOENT" });
});

for (const ignoreTerm of [false, true]) {
  test(`extension fixture joins ${ignoreTerm ? "SIGKILL fallback" : "delayed SIGTERM shutdown"} before removal after an assertion failure`, { timeout: 20_000 }, async (t) => {
    const saved = { ...process.env };
    const resources = failureSafetyNet(t, saved);
    const failure = new assert.AssertionError({ message: "injected assertion after spawn" });
    let stdout = "";
    await assert.rejects(withExtensionBootstrap(t, (root) => ({ ...process.env, PROJECTS_ROOT: root }), async ({ root, detached }) => {
      resources.root = root;
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { existsSync } from "node:fs";
        process.on("SIGTERM", () => {
          if (${ignoreTerm}) { process.stdout.write("term-ignored\\n"); return; }
          setTimeout(() => {
            process.stdout.write(existsSync(process.argv[1]) ? "workspace-present\\n" : "workspace-missing\\n");
            process.exit(0);
          }, 150);
        });
        setInterval(() => {}, 1000);
        process.stdout.write("ready\\n");
      `, root], { stdio: ["ignore", "pipe", "pipe"] });
      resources.child = child;
      resources.closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
      assert.ok(child.pid);
      detached.pid = child.pid;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      const deadline = Date.now() + 10_000;
      while (!stdout.includes("ready\n") && Date.now() < deadline) await delay(25);
      assert.ok(stdout.includes("ready\n"), "install signal handler before injecting failure");
      throw failure;
    }), failure);
    assertEnvironmentRestored(saved);
    assert.ok(resources.child?.pid);
    assert.ok(resources.child.exitCode !== null || resources.child.signalCode !== null, "process must exit before fixture cleanup returns");
    assert.throws(() => process.kill(resources.child!.pid!, 0), { code: "ESRCH" });
    await resources.closed;
    if (ignoreTerm) {
      assert.match(stdout, /term-ignored/);
      assert.equal(resources.child.signalCode, "SIGKILL");
    } else {
      assert.match(stdout, /workspace-present/);
      assert.doesNotMatch(stdout, /workspace-missing/);
      assert.equal(resources.child.exitCode, 0);
    }
    assert.ok(resources.root);
    await assert.rejects(access(resources.root), { code: "ENOENT" });
  });
}

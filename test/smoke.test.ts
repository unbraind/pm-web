import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

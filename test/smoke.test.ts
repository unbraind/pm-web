import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../src/index.ts";

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

test("server entrypoint exits non-zero without DATABASE_URL", () => {
  // Spawns src/server.ts directly so the entrypoint contributes coverage.
  // Without a database the server must fail fast rather than hang.
  try {
    execFileSync(process.execPath, ["src/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "" },
      encoding: "utf-8",
      timeout: 10000,
    });
    assert.fail("expected server to exit non-zero without DATABASE_URL");
  } catch (err) {
    const e = err as { status?: number };
    assert.ok(e.status !== 0, `expected non-zero exit, got ${e.status}`);
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
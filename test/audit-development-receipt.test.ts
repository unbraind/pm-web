/** Verify the recorded advisory command includes development dependencies under production defaults. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseItemDocument } from "@unbrained/pm-cli/sdk";

test("advisory audit receipt includes dev dependencies despite production defaults", async () => {
  const item = parseItemDocument(readFileSync(new URL("../.agents/pm/issues/pm-web-c8-glob-advisory.toon", import.meta.url), "utf8"), { format: "toon" });
  const command = item.metadata.tests?.find(entry => entry.command?.includes("npm audit"))?.command;
  assert.ok(command);
  const scratch = await mkdtemp(path.join(tmpdir(), "pm-web-audit-command-"));
  try {
    const npm = path.join(scratch, "npm");
    await writeFile(npm, "#!/bin/sh\nprintf '%s\\n' \"$@\" \"$NPM_CONFIG_USERCONFIG\" \"$npm_config_userconfig\"\n");
    await chmod(npm, 0o755);
    const result = spawnSync("bash", ["-eu", "-c", command], {
      env: { ...process.env, PATH: `${scratch}${path.delimiter}${process.env.PATH}`, NODE_ENV: "production", npm_config_omit: "dev" },
      encoding: "utf8", timeout: 60000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["audit", "--json", "--ignore-scripts", "--include=dev", "/dev/null", "/dev/null"]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

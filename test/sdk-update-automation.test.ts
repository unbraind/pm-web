import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Packaging inputs changed independently by dependency automation. */
interface PackagingInputs {
  dependencies: Record<string, string>;
}

test("dependency-only SDK updates preserve a tested host floor without generated manifest edits", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-web-sdk-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  const packageBytes = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const extensionBytes = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  writeFileSync(join(root, "manifest.json"), extensionBytes);
  writeFileSync(join(root, "test/packaging.test.ts"), readFileSync(new URL("./packaging.test.ts", import.meta.url)));
  const inputs = JSON.parse(packageBytes) as PackagingInputs;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  // Dependabot edits package.json and the lockfile, not extension metadata.
  // A year rollover is intentional: calendar-major updates use the same group.
  for (const runtime of [inputs.dependencies["@unbrained/pm-cli"], "2027.1.1"]) {
    inputs.dependencies["@unbrained/pm-cli"] = runtime;
    writeFileSync(join(root, "package.json"), `${JSON.stringify(inputs, null, 2)}\n`);
    const result = spawnSync(process.execPath, ["--test", "test/packaging.test.ts"], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, "manifest.json"), "utf8"), extensionBytes);
  }

  // Keep useful safety assertions: a runtime below the host floor, ranges,
  // and malformed compatibility metadata must still be refused.
  for (const runtime of ["2020.1.1", "^2027.1.1"]) {
    inputs.dependencies["@unbrained/pm-cli"] = runtime;
    writeFileSync(join(root, "package.json"), JSON.stringify(inputs));
    const result = spawnSync(process.execPath, ["--test", "test/packaging.test.ts"], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  inputs.dependencies["@unbrained/pm-cli"] = "2027.1.1";
  writeFileSync(join(root, "package.json"), JSON.stringify(inputs));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ pm_min_version: "unverified" }));
  const malformed = spawnSync(process.execPath, ["--test", "test/packaging.test.ts"], { cwd: root, encoding: "utf8", env });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
});

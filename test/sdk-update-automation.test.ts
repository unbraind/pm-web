import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

/** Packaging inputs changed independently by dependency automation. */
interface PackagingInputs {
  dependencies: Record<string, string>;
}

/** Copy the actual packaging gate into a standalone temporary consumer. */
function packagingFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pm-web-packaging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  const packageBytes = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const extensionBytes = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  writeFileSync(join(root, "manifest.json"), extensionBytes);
  writeFileSync(join(root, "test/packaging.test.ts"), readFileSync(new URL("./packaging.test.ts", import.meta.url)));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { root, packageBytes, extensionBytes, env };
}

/** Execute the copied gate and require its expected exit status. */
function runPackaging(root: string, env: NodeJS.ProcessEnv, status: number) {
  const result = spawnSync(process.execPath, ["--test", "test/packaging.test.ts"], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result;
}

test("packaging rejects collisions between every pair of dependency sections", (t) => {
  const { root, packageBytes: original, env } = packagingFixture(t);
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const [index, first] of sections.entries()) {
    for (const second of sections.slice(index + 1)) {
      const inputs = JSON.parse(original) as Record<string, Record<string, string>>;
      for (const section of [first, second]) {
        inputs[section] ??= {};
        inputs[section]["synthetic-collision"] = "1.0.0";
      }
      writeFileSync(join(root, "package.json"), JSON.stringify(inputs, null, 2));
      const result = runPackaging(root, env, 1);
      assert.match(result.stdout, /synthetic-collision is declared in both/);
    }
  }
});

test("dependency-only SDK updates preserve a tested host floor without generated manifest edits", (t) => {
  const { root, packageBytes, extensionBytes, env } = packagingFixture(t);
  const inputs = JSON.parse(packageBytes) as PackagingInputs;

  // Dependabot edits package.json and the lockfile, not extension metadata.
  // A year rollover is intentional: calendar-major updates use the same group.
  for (const runtime of [inputs.dependencies["@unbrained/pm-cli"], "2027.1.1"]) {
    inputs.dependencies["@unbrained/pm-cli"] = runtime;
    writeFileSync(join(root, "package.json"), `${JSON.stringify(inputs, null, 2)}\n`);
    runPackaging(root, env, 0);
    assert.equal(readFileSync(join(root, "manifest.json"), "utf8"), extensionBytes);
  }

  // Keep useful safety assertions: a runtime below the host floor, ranges,
  // and malformed compatibility metadata must still be refused.
  for (const runtime of ["2020.1.1", "^2027.1.1"]) {
    inputs.dependencies["@unbrained/pm-cli"] = runtime;
    writeFileSync(join(root, "package.json"), JSON.stringify(inputs));
    runPackaging(root, env, 1);
  }
  // Even matching old pins must not lower the separately justified API minimum.
  inputs.dependencies["@unbrained/pm-cli"] = "2020.1.1";
  writeFileSync(join(root, "package.json"), JSON.stringify(inputs));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ pm_min_version: "2020.1.1" }));
  const oldApi = runPackaging(root, env, 1);
  assert.match(oldApi.stdout, /certified SDK API minimum/);

  inputs.dependencies["@unbrained/pm-cli"] = "2027.1.1";
  writeFileSync(join(root, "package.json"), JSON.stringify(inputs));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ pm_min_version: "unverified" }));
  runPackaging(root, env, 1);
});

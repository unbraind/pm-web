import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/** Run the actual coverage gate against a disposable package with genuine c8 counters. */
async function gateFixture(t: test.TestContext): Promise<{
  root: string;
  configure: (thresholds?: Record<string, number>, sources?: string[]) => Promise<void>;
  run: () => { status: number | null; output: string };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["src", "scripts", "test", "coverage"]) await mkdir(path.join(root, dir));
  await copyFile(new URL("../scripts/coverage-gate.ts", import.meta.url), path.join(root, "scripts", "coverage-gate.ts"));
  await symlink(path.resolve(import.meta.dirname, "..", "node_modules"), path.join(root, "node_modules"), "junction");
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 42;\n");
  await writeFile(path.join(root, "test", "value.test.ts"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\ntest("value", () => assert.equal(value, 42));\n');
  return {
    root,
    /** Write the fixture's public coverage configuration. */
    configure: async (thresholds = { statements: 100, lines: 100, functions: 100, branches: 100 }, sources = ["src"]) => {
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        type: "module", coverageGate: { sources, tests: ["test/*.test.ts"], thresholds, ignore: [] },
      }));
    },
    /** Execute the shipped script without inherited coverage counters. */
    run: () => {
      const env = { ...process.env };
      delete env.NODE_V8_COVERAGE;
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["scripts/coverage-gate.ts"], { cwd: root, encoding: "utf8", env });
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}

test("coverage gate publishes fresh reports, counts unloaded sources, and invalidates failed runs", async (t) => {
  const fixture = await gateFixture(t);
  await fixture.configure();
  const passing = fixture.run();
  assert.equal(passing.status, 0, passing.output);
  const summary = JSON.parse(await readFile(path.join(fixture.root, "coverage", "coverage-summary.json"), "utf8")) as {
    total: { statements: { pct: number } };
  };
  assert.equal(summary.total.statements.pct, 100);
  assert.match(await readFile(path.join(fixture.root, "coverage", "lcov.info"), "utf8"), /SF:src\/value.ts/);
  // A new module cannot disappear from the denominator just because no test imports it.
  await writeFile(path.join(fixture.root, "src", "unloaded.ts"), "export const unloaded = 17;\n");
  const failed = fixture.run();
  assert.notEqual(failed.status, 0, failed.output);
  assert.match(failed.output, /unloaded.ts/);
  assert.deepEqual(await readdir(path.join(fixture.root, "coverage")), []);
  // At zero thresholds the same untouched module is reported explicitly at zero.
  await fixture.configure({ statements: 0, lines: 0, functions: 0, branches: 0 });
  const zero = fixture.run();
  assert.equal(zero.status, 0, zero.output);
  const counters = JSON.parse(await readFile(path.join(fixture.root, "coverage", "coverage-final.json"), "utf8")) as Record<string, {
    s: Record<string, number>;
  }>;
  const untouched = Object.entries(counters).find(([file]) => file.endsWith("unloaded.ts"));
  assert.ok(untouched);
  assert.ok(Object.values(untouched[1].s).every((count) => count === 0));
});

test("statements are enforced independently and malformed configuration clears accepted evidence", async (t) => {
  const fixture = await gateFixture(t);
  await writeFile(path.join(fixture.root, "src", "unused.ts"), "export const unused = 1;\n");
  await fixture.configure({ statements: 100, lines: 0, branches: 0, functions: 0 });
  const statements = fixture.run();
  assert.notEqual(statements.status, 0);
  assert.match(statements.output, /statements/);
  await fixture.configure({ statements: 0, lines: 0, branches: 0, functions: 0 });
  assert.equal(fixture.run().status, 0);
  await fixture.configure({ statements: 0, lines: 0, branches: 0, functions: 0 }, ["absent-source"]);
  const absent = fixture.run();
  assert.notEqual(absent.status, 0);
  assert.match(absent.output, /absent-source/);
  assert.deepEqual(await readdir(path.join(fixture.root, "coverage")), []);
  await fixture.configure({ lines: 0, branches: 0, functions: 0 });
  const missingMetric = fixture.run();
  assert.notEqual(missingMetric.status, 0);
  assert.match(missingMetric.output, /thresholds.statements/);
});

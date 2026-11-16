import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";
import { testDepth } from "./support/depth.ts";
import { testTime } from "../scripts/test-time.ts";

test("quick depth keeps a deterministic prefix, a 25-case floor and full default", () => {
  const saved = process.env.PM_TEST_DEPTH;
  try {
    for (const mode of [undefined, "full", "unknown"]) {
      if (mode === undefined) delete process.env.PM_TEST_DEPTH;
      else process.env.PM_TEST_DEPTH = mode;
      assert.equal(testDepth(500), 500);
    }
    process.env.PM_TEST_DEPTH = "quick";
    for (const [full, quick] of [[500, 50], [1000, 100], [26, 25], [20, 20], [251, 26]]) {
      assert.equal(testDepth(full), quick);
    }
  } finally {
    if (saved === undefined) delete process.env.PM_TEST_DEPTH;
    else process.env.PM_TEST_DEPTH = saved;
  }
});

test("harness scales reject invalid factors before child work and ceil fractional milliseconds", () => {
  const module = new URL("../scripts/test-time.ts", import.meta.url).href;
  for (const scale of ["0", "-1", "NaN", "Infinity", "", "0.3333", "3"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { testTime } from ${JSON.stringify(module)}; console.log(testTime(101));`], {
      env: { ...process.env, PM_TEST_TIME_SCALE: scale }, encoding: "utf8", timeout: testTime(30000),
    });
    if (["0.3333", "3"].includes(scale)) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(Number(result.stdout), Math.ceil(101 * Number(scale)));
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "", "invalid scale must fail before subsequent work");
      assert.match(result.stderr, /PM_TEST_TIME_SCALE/);
    }
  }
});

test("tier workflows parse strictly and preserve hosted service gates and isolated local checks", () => {
  const workflows = Object.fromEntries(["ci", "ci-deep", "codeql"].map(name => {
    const document = parseDocument(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"), { uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    return [name, document.toJS()];
  }));
  assert.deepEqual(Object.keys(workflows.ci.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflows.ci.jobs.test.strategy.matrix["node-version"], [22, 26]);
  assert.equal(workflows.ci.jobs.test["runs-on"], "ubuntu-latest");
  assert.ok(workflows.ci.jobs.test.services.postgres);
  const deep = workflows["ci-deep"].jobs;
  assert.deepEqual(deep.deep.strategy.matrix["package-manager"], ["npm", "bun"]);
  assert.deepEqual(deep.deep.strategy.matrix["node-version"], [22, 26]);
  assert.equal(deep.deep["runs-on"], "ubuntu-latest");
  assert.ok(deep.deep.services.postgres);
  assert.match(deep.independent["runs-on"], /pm-local/);
  assert.equal(deep.independent.services, undefined);
  for (const [workflow, config] of Object.entries(workflows)) {
    for (const job of Object.values(config.jobs) as Record<string, unknown>[]) {
      const timeout = Number(job["timeout-minutes"]);
      assert.ok(timeout > 0 && timeout <= (workflow === "ci-deep" ? 120 : 30));
    }
  }
});

/** Exercise the documented no-Git control using real directories, Git and SDK initialization. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { transformSync } from "esbuild";

/** Execute the actual documented plain setup in a child with independent Git discovery settings. */
async function initializePlain(scratch: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const document = readFileSync(new URL("../docs/gated-sync-288-verification.md", import.meta.url), "utf8");
  const guard = document.match(/^function assertOutsideGit\(directory: string\): void \{[\s\S]*?^\}/m);
  const setup = document.match(/^  const plain = path.join\(scratch, 'plain'\);[\s\S]*?(?=^  await plainClient.create\()/m);
  assert.ok(guard, "The documented Git boundary function must be runnable");
  assert.ok(setup, "The documented plain setup must be runnable");
  const code = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
const scratch = ${JSON.stringify(scratch)};
${guard[0]}
await (async () => {\n${setup[0]}\n})();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", transformSync(code, { loader: "ts", target: "es2022" }).code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: environment, encoding: "utf8", timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

for (const scenario of ["plain", "worktree", "bare", "corrupt", "empty-ancestor", "hidden-worktree", "hidden-bare"] as const) {
  test(`documented no-Git setup ${scenario === "plain" ? "accepts" : "refuses"} ${scenario} directory`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "pm-web-git-boundary-"));
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
    const repository = ["worktree", "bare", "hidden-worktree", "hidden-bare"].includes(scenario);
    const bare = scenario === "bare" || scenario === "hidden-bare";
    const config = path.join(scratch, bare ? "config" : ".git/config");
    let plainScratch = scratch;
    try {
      if (repository) {
        const init = spawnSync("git", ["init", "-q", ...(bare ? ["--bare"] : [])], { cwd: scratch, env: environment, encoding: "utf8" });
        assert.equal(init.status, 0, init.stderr);
        await writeFile(path.join(scratch, ".gitattributes"), "synthetic-probe -diff\n");
      } else if (scenario === "corrupt") {
        await writeFile(path.join(scratch, ".git"), "gitdir: missing-synthetic-repository\n");
      } else if (scenario === "empty-ancestor") {
        await mkdir(path.join(scratch, ".git"));
        plainScratch = path.join(scratch, "nested");
        await mkdir(plainScratch);
        environment.TMPDIR = plainScratch;
      }
      const beforeConfig = repository ? readFileSync(config) : undefined;
      // A bare repository has no .git entry, so its hidden case independently tests the sanitized probe.
      if (scenario.startsWith("hidden-")) environment.GIT_CEILING_DIRECTORIES = scratch;
      if (scenario === "plain") {
        const outside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: scratch, encoding: "utf8", env: { ...environment, LC_ALL: "C" } });
        assert.equal(outside.status, 128, "Test temporary directory must itself be outside Git");
        assert.match(outside.stderr, /not a git repository \(or any of the parent directories\)/);
        await initializePlain(plainScratch, environment);
        const client = new PmClient({ cwd: path.join(plainScratch, "plain"), noExtensions: true });
        assert.equal((await client.listAllComplete()).items.length, 0);
        assert.ok(existsSync(path.join(plainScratch, "plain/.agents/pm/settings.json")));
        assert.equal(existsSync(path.join(plainScratch, "plain/.git")), false);
      } else {
        await assert.rejects(initializePlain(plainScratch, environment), /outside every Git repository/);
        assert.equal(existsSync(path.join(plainScratch, "plain/.agents")), false, "Refusal must precede SDK tracker initialization");
        if (repository) {
          assert.deepEqual(readFileSync(config), beforeConfig, "Refusal must preserve ancestor Git configuration");
          assert.equal(readFileSync(path.join(scratch, ".gitattributes"), "utf8"), "synthetic-probe -diff\n");
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

/** Execute the documented receipt validator itself, including every zero-count assertion. */
test("documented plan asserts every gate count and success receipt", () => {
  const document = readFileSync(new URL("../docs/gated-sync-288-verification.md", import.meta.url), "utf8");
  const functions = document.match(/^function assertZeroGateCounts[\s\S]*?(?=^try \{)/m);
  assert.ok(functions);
  const control = `
const clean = [{ id: 'owner', tags: ['gh:unbraind/pm-web#288'] }];
const value = { plan: [{ issue: 288, item: 'owner' }], gate: {
  completeness: { fetched: 1, planned: 1, skipped: 0 },
  idempotency: { provenance_indexed: 19, matched_by_provenance: 1, new_entries: 0 }
} };
assertPlan(value, clean);
assert.throws(() => assertPlan(value, [...clean, { id: 'duplicate', tags: clean[0].tags }]), /duplicate_provenance/);
assert.throws(() => assertPlan(value, [{ id: 'owner', tags: [] }]), /missing_provenance/);
assert.throws(() => assertPlan({ ...value, plan: [...value.plan, ...value.plan] }, clean), /conflicting_targets/);
for (const group of ['completeness', 'idempotency']) for (const key of Object.keys(value.gate[group])) {
  const broken = structuredClone(value); broken.gate[group][key]++;
  assert.throws(() => assertPlan(broken, clean));
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", transformSync(`import assert from 'node:assert/strict';\n${functions[0]}\n${control}`, { loader: "ts" }).code], { encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("documented boundary command returns from the historical to the reviewed checkout", async () => {
  const document = readFileSync(new URL("../docs/gated-sync-288-verification.md", import.meta.url), "utf8");
  assert.match(document, /reviewed_checkout=\$\(pwd -P\)[\s\S]*git worktree add/);
  const command = document.match(/```sh\n([^`]*node --test --test-concurrency=2 test\/gated-sync-verification\.test\.ts\n)```/);
  assert.ok(command);
  const scratch = await mkdtemp(path.join(tmpdir(), "pm-web-reviewed-command-"));
  try {
    const reviewed = path.join(scratch, "reviewed"); const historical = path.join(scratch, "historical");
    await mkdir(path.join(reviewed, "test"), { recursive: true }); await mkdir(historical);
    await writeFile(path.join(reviewed, "test/gated-sync-verification.test.ts"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('reviewed checkout', () => assert.equal(process.cwd(), process.env.reviewed_checkout));\n");
    const result = spawnSync("bash", ["-eu", "-c", command[1]], { cwd: historical, env: { ...process.env, NODE_TEST_CONTEXT: undefined, reviewed_checkout: reviewed }, encoding: "utf8", timeout: 60000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /reviewed checkout/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

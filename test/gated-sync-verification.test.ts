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

/** Exercise the documented no-Git control using real directories, Git and SDK initialization. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { transformSync } from "esbuild";

/** Execute the actual documented plain setup, stopping before the provenance scenarios. */
async function initializePlain(scratch: string): Promise<void> {
  const document = readFileSync(new URL("../docs/gated-sync-288-verification.md", import.meta.url), "utf8");
  const guard = document.match(/^function assertOutsideGit\(directory: string\): void \{[\s\S]*?^\}/m);
  const setup = document.match(/^  const plain = path.join\(scratch, 'plain'\);[\s\S]*?(?=^  await plainClient.create\()/m);
  assert.ok(guard, "The documented Git boundary function must be runnable");
  assert.ok(setup, "The documented plain setup must be runnable");
  const realm = { assert, spawnSync, process, mkdir, path, PmClient, scratch, result: undefined as Promise<void> | undefined };
  const code = `${guard[0]}\nglobalThis.result = (async () => {\n${setup[0]}\n})();`;
  runInNewContext(transformSync(code, { loader: "ts", target: "es2022" }).code, realm);
  await realm.result;
}

for (const scenario of ["plain", "worktree", "bare", "corrupt"] as const) {
  test(`documented no-Git setup ${scenario === "plain" ? "accepts" : "refuses"} ${scenario} directory`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "pm-web-git-boundary-"));
    try {
      if (scenario === "worktree" || scenario === "bare") {
        const init = spawnSync("git", ["init", "-q", ...(scenario === "bare" ? ["--bare"] : [])], { cwd: scratch, encoding: "utf8" });
        assert.equal(init.status, 0, init.stderr);
      } else if (scenario === "corrupt") {
        await writeFile(path.join(scratch, ".git"), "gitdir: missing-synthetic-repository\n");
      }
      if (scenario === "plain") {
        const outside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: scratch, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
        assert.equal(outside.status, 128, "Test temporary directory must itself be outside Git");
        assert.match(outside.stderr, /not a git repository \(or any of the parent directories\)/);
        await initializePlain(scratch);
        const client = new PmClient({ cwd: path.join(scratch, "plain"), noExtensions: true });
        assert.equal((await client.listAllComplete()).items.length, 0);
        assert.ok(existsSync(path.join(scratch, "plain/.agents/pm/settings.json")));
        assert.equal(existsSync(path.join(scratch, "plain/.git")), false);
      } else {
        await assert.rejects(initializePlain(scratch), scenario === "corrupt" ? /not a git repository/ : /outside every Git repository/);
        assert.equal(existsSync(path.join(scratch, "plain/.agents")), false, "Refusal must precede SDK tracker initialization");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

/** Prove package SDK dispatch reads and mutates a real tracker with git unavailable. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runPm } from "../../dist/services/pm-runner.js";

const root = process.env.PROJECTS_ROOT!;
const dir = path.join(root, "owner", "plain");
await mkdir(dir, { recursive: true });
const init = spawnSync(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", path.join(dir, ".agents", "pm"), "init", "--defaults", "--agent-guidance", "skip"], { cwd: dir, env: process.env, encoding: "utf8" });
assert.equal(init.status, 0, init.stderr);
assert.equal(existsSync(path.join(dir, ".git")), false);
assert.ok(spawnSync("git", ["--version"], { env: process.env }).error, "git must be unavailable");
const call = (args: string[]) => runPm({ userId: "owner", slug: "plain", args, jsonOutput: true });
const created = await call(["create", "--type", "Task", "--title", "Plain tracker item"]);
assert.equal(created.ok, true, created.stderr);
const id = (created.parsed as { id: string }).id;
assert.ok(id);
const read = await call(["get", "--id", id]);
assert.equal(read.ok, true, read.stderr);
assert.match(read.stdout, /Plain tracker item/);
const updated = await call(["update", "--id", id, "--title", "Updated plain item"]);
assert.equal(updated.ok, true, updated.stderr);
const listed = await call(["list", "--all", "--full"]);
assert.equal(listed.ok, true, listed.stderr);
assert.match(listed.stdout, /Updated plain item/);
console.log("SDK create/get/update/list passed without git");

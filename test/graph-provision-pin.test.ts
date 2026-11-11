/** Real provisioning retains its admitted tracker when a logical tracker symlink changes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureGraphExtension, readProjectExtensionStates, setGraphProvisionInventoryHookForTest } from "../src/services/pm-runner.ts";

test("graph provisioning and shared waiters stay on the inventoried physical tracker after a symlink swap", { timeout: 240000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-graph-pin-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  const cli = path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" };
  for (const key of Object.keys(childEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|NPM_MEDIA_SERVER|^PM_PATH$/i.test(key)) delete childEnv[key];
  let resume!: () => void; let inventoried!: () => void;
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  const inventory = new Promise<void>(resolve => { inventoried = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    const trackers = ["tracker-a", "tracker-b"].map(name => path.join(root, name));
    for (const workspace of trackers) {
      await mkdir(workspace);
      const result = spawnSync(process.execPath, [cli, "workspace", "init", "--workspace", workspace, "--prefix", "pin", "--defaults", "--agent-guidance", "skip", "--no-merge-fence"], { cwd: workspace, env: childEnv, encoding: "utf8", timeout: 30000 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    }
    const aliases = ["first", "waiter"].map(slug => path.join(root, "owner", slug));
    for (const workspace of aliases) {
      await mkdir(path.join(workspace, ".agents"), { recursive: true });
      await symlink(path.join(trackers[0], ".agents/pm"), path.join(workspace, ".agents/pm"), "dir");
    }
    process.env.PROJECTS_ROOT = root;
    setGraphProvisionInventoryHookForTest(async () => { inventoried(); await barrier; });
    const first = ensureGraphExtension("owner", "first"); pending.push(first);
    await Promise.race([inventory, first.then(result => { throw new Error(`Inventory did not reach barrier: ${JSON.stringify(result)}`); })]);
    const waiter = ensureGraphExtension("owner", "waiter"); pending.push(waiter);
    await unlink(path.join(aliases[0], ".agents/pm"));
    await symlink(path.join(trackers[1], ".agents/pm"), path.join(aliases[0], ".agents/pm"), "dir");
    resume();
    const results = await Promise.all([first, waiter]);
    assert.deepEqual(results, [{ ok: true, installed: true, active: true }, { ok: true, installed: true, active: true }]);
    const original = await readProjectExtensionStates(trackers[0]!);
    const replacement = await readProjectExtensionStates(trackers[1]!);
    assert.equal(original.ok, true, original.error ?? "");
    assert.equal(replacement.ok, true, replacement.error ?? "");
    assert.equal(original.states.get("pm-graph")?.active, true, "shared success must describe tracker A actually provisioned");
    assert.equal(original.states.get("pm-graph")?.enabled, true);
    assert.equal(replacement.states.has("pm-graph"), false, "tracker B must remain untouched");
  } finally {
    resume(); await Promise.allSettled(pending);
    setGraphProvisionInventoryHookForTest(undefined);
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

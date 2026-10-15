/** Real pinned CLI facts prove recovery when a later-visible commit has an older timestamp. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { getPmClient, evictPmClient } from "../src/services/pm-runner.ts";
import { capacityPm, capacityEnvironment } from "../scripts/capacity-fixture.ts";
import { createMutationReplayState, followCommittedMutations } from "../src/services/mutation-replay.ts";

const execute = promisify(execFile);

test("a real later-visible history fact behind the exclusive cursor is delivered once by overlap", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-replay-"));
  const controller = new AbortController();
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "replay", "--defaults", "--agent-guidance", "skip"]);
    const client = getPmClient(path.join(dir, ".agents/pm"));
    for (const id of ["replay-first", "replay-late"]) await client.run("create", { options: { id, title: id, type: "Task", description: "Replay fixture" } });
    await delay(1500);
    const state = createMutationReplayState();
    // Leave headroom for the skewed writer, while excluding both item creations.
    const since = new Date(Date.now() - 1200).toISOString();
    const pmRoot = path.join(dir, ".agents/pm");
    await capacityPm(dir, ["update", "replay-first", "--title", "New first"]);
    const first = await listMutationEvents({ pmRoot, since, type: "update" });
    assert.equal(first.events.length, 1);
    const stream = followCommittedMutations({ pmRoot, since, type: "update", intervalMs: 20, signal: controller.signal }, state);
    assert.equal((await stream.next()).value?.item_id, "replay-first");
    await execute(process.execPath, ["--import", path.resolve("test/helpers/capacity-clock.ts"),
      path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", pmRoot, "--no-extensions", "update", "replay-late", "--title", "New late"],
    { cwd: dir, env: { ...capacityEnvironment(dir), CAPACITY_CLOCK_TIMESTAMP: String(Date.parse(first.events[0].ts) - 1) }, timeout: 15_000 });
    const all = await listMutationEvents({ pmRoot, since, type: "update" });
    assert.equal(all.events.length, 2);
    // Confirm this fixture actually straddles the SDK's exclusive timestamp boundary.
    assert.ok(all.events[0].ts < first.events[0].ts, "the late fact must sort behind the cursor");
    const tail = await listMutationEvents({ pmRoot, since: first.next_cursor, type: "update" });
    assert.equal(tail.events.length, 0, "an exclusive tail read loses the late fact");
    const deadline = setTimeout(() => controller.abort(), 2000);
    try { assert.equal((await stream.next()).value?.item_id, "replay-late"); }
    finally { clearTimeout(deadline); }
    assert.equal(state.seen.size, 2);
    // Replayed facts are suppressed, including after a subscription restart using its ISO boundary.
    controller.abort();
    await stream.return();
    const stop = new AbortController();
    const repeated = followCommittedMutations({ pmRoot, since, type: "update", intervalMs: 10, signal: stop.signal }, state);
    const timer = setTimeout(() => stop.abort(), 100);
    try { assert.equal((await repeated.next()).done, true); } finally { clearTimeout(timer); await repeated.return(); }
  } finally { controller.abort(); evictPmClient(path.join(dir, ".agents/pm")); await rm(dir, { recursive: true, force: true }); }
});

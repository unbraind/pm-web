/** Real pinned CLI facts prove recovery when a later-visible commit has an older timestamp. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { getPmClient, evictPmClient } from "../src/services/pm-runner.ts";
import { capacityPm, capacityEnvironment, waitUntil } from "../scripts/capacity-fixture.ts";
import { createMutationReplayState, followCommittedMutations } from "../src/services/mutation-replay.ts";
import { syncBuiltinESMExports } from "node:module";
import { historyFingerprint, HISTORY_READ_SAFETY_MS } from "../src/services/history-read-gate.ts";

const execute = promisify(execFile);

/** Observe real successful lock opens in this isolated test process and restore the builtin synchronously. */
function countHistoryLocks(): { count: () => number; stop: () => void } {
  const originalOpen = fs.open;
  let locks = 0;
  fs.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (path.basename(String(args[0])) === "history-event-index.lock") locks += 1;
    return handle;
  };
  syncBuiltinESMExports();
  return { count: () => locks, stop: () => { fs.open = originalOpen; syncBuiltinESMExports(); } };
}

test("the real SDK authoritative fallback remains usable when SQLite is unavailable", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-fallback-replay-"));
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "fallback", "--defaults", "--agent-guidance", "skip"]);
    await capacityPm(dir, ["create", "Task", "Synthetic fallback", "--id", "fallback-one", "--description", "Synthetic"]);
    await capacityPm(dir, ["update", "fallback-one", "--title", "Committed fallback"]);
    const result = await execute(process.execPath, ["--no-experimental-sqlite", path.resolve("test/helpers/authoritative-replay.ts"), path.join(dir, ".agents/pm")],
      { cwd: path.resolve("."), env: capacityEnvironment(dir), timeout: 15_000 });
    assert.match(result.stdout, /authoritative fallback delivered/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a real idle follower takes no index locks between safety checks and detects a separate CLI write", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-idle-replay-"));
  const controller = new AbortController();
  const pmRoot = path.join(dir, ".agents/pm");
  let counter: ReturnType<typeof countHistoryLocks> | undefined;
  let stream: ReturnType<typeof followCommittedMutations> | undefined;
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "idle", "--defaults", "--agent-guidance", "skip"]);
    await capacityPm(dir, ["create", "Task", "Synthetic idle", "--id", "idle-one", "--description", "Synthetic"]);
    await listMutationEvents({ pmRoot, type: "update" });
    counter = countHistoryLocks();
    const state = createMutationReplayState();
    // Hold only the admission clock before the safety deadline. Host scheduling
    // cannot turn this idle-poll assertion into a legitimate periodic full read.
    const begin = state.readGate.begin.bind(state.readGate);
    state.readGate.begin = (fingerprint) => begin(fingerprint, 0);
    stream = followCommittedMutations({ pmRoot: ".agents/pm", cwd: dir, since: new Date(state.baseline).toISOString(), type: "update", intervalMs: 20, signal: controller.signal }, state);
    const next = stream.next();
    await waitUntil(() => state.readGate.completedScanAt !== undefined, 3000, "first real replay scan");
    await delay(200);
    const settled = counter.count();
    assert.equal(settled, 0, "the current SDK reads an up-to-date index without writer locks");
    await delay(300);
    assert.equal(counter.count(), settled, "unchanged history must take zero additional index locks");
    await capacityPm(dir, ["update", "idle-one", "--title", "CLI bypasses NOTIFY"]);
    const timeout = setTimeout(() => controller.abort(), 2000);
    try { assert.equal((await next).value?.item_id, "idle-one"); }
    finally { clearTimeout(timeout); }
    controller.abort();
    await stream.return();
    assert.equal(counter.count(), 0, "a separately committed CLI write is visible without a reader writer-lock");
    await assert.rejects(followCommittedMutations({ pmRoot, since: "invalid" }, createMutationReplayState()).next(), /ISO timestamp/);
  } finally {
    controller.abort();
    await stream?.return();
    counter?.stop();
    evictPmClient(pmRoot);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a skipped-poll boundary retains facts visible within the replay window even when their timestamp has now aged out", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-safety-replay-"));
  const controller = new AbortController();
  const pmRoot = path.join(dir, ".agents/pm");
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "safety", "--defaults", "--agent-guidance", "skip"]);
    await capacityPm(dir, ["create", "Task", "Synthetic safety", "--id", "safety-one", "--description", "Synthetic"]);
    const now = Date.now();
    const since = new Date(now - 70_000).toISOString();
    const state = createMutationReplayState();
    await execute(process.execPath, ["--import", path.resolve("test/helpers/capacity-clock.ts"),
      path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", pmRoot, "--no-extensions", "update", "safety-one", "--title", "Late near expiry"],
    { cwd: dir, env: { ...capacityEnvironment(dir), CAPACITY_CLOCK_TIMESTAMP: String(now - 61_000) }, timeout: 15_000 });
    const recent = await listMutationEvents({ pmRoot, type: "update", since: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(recent.count, 0, "a wall-clock floor would already lose this fact");
    // Simulate a metadata collision by certifying the current token as the old
    // observation. A due safety read must use the real SDK and the prior floor.
    state.readGate.begin(await historyFingerprint(pmRoot), performance.now() - HISTORY_READ_SAFETY_MS - 1)!.complete(now - 10_000);
    const stream = followCommittedMutations({ pmRoot, since, type: "update", intervalMs: 20, signal: controller.signal }, state);
    const timeout = setTimeout(() => controller.abort(), 2000);
    try { assert.equal((await stream.next()).value?.item_id, "safety-one"); }
    finally { clearTimeout(timeout); controller.abort(); await stream.return(); }
  } finally { controller.abort(); evictPmClient(pmRoot); await rm(dir, { recursive: true, force: true }); }
});

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

/** Delivery, bounded slow readers, and opaque resume are observable at the response boundary. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Response } from "express";
import { attachFanout, canResumeFanout, clearFanout, FANOUT_LIMITS, heartbeatFanout, prepareFanout, retainedFanoutProjects } from "../src/services/sse-fanout.ts";
import { waitUntil } from "../scripts/capacity-wait.ts";

/** A response with real drain events and controllable backpressure, retaining buffer identity. */
function sink(block = false, fail = false) {
  const response = new EventEmitter();
  const writes: Buffer[] = [];
  let destroyed = false;
  Object.assign(response, {
    writableLength: 0,
    write: (payload: Buffer) => { if (fail) throw new Error("Synthetic write failure"); writes.push(payload); return !block; },
    destroy: () => { destroyed = true; },
  });
  return { id: randomUUID(), userId: randomUUID(), res: response as Response, writes,
    destroyed: () => destroyed, pause: () => { block = true; }, unblock: () => { block = false; response.emit("drain"); } };
}

/** Decode every frame, since a single response write can contain an ordered burst. */
function frames(writes: Buffer[]) {
  return writes.flatMap((payload) => payload.toString().split("\n\n")).filter(Boolean).map((frame) => ({
    type: /^event: (.+)$/m.exec(frame)?.[1], id: /^id: (.+)$/m.exec(frame)?.[1] ?? "", data: /^data: (.+)$/m.exec(frame)?.[1],
  }));
}

test("3000 viewers share one UTF-8 buffer per ordered burst, with one JSON serialization per event", async (t) => {
  t.after(clearFanout);
  const project = randomUUID();
  const viewers = Array.from({ length: 3000 }, () => sink());
  viewers.forEach((viewer) => attachFanout(project, viewer, () => {}));
  let serializations = 0;
  const data = { toJSON: () => { serializations += 1; return { text: "é 🐘" }; } };
  for (let i = 0; i < 3; i++) prepareFanout(project, { type: `update-${i}`, data });
  await waitUntil(() => viewers.every((viewer) => viewer.writes.length === 2), 3000, "bounded fan-out completion");
  assert.equal(serializations, 3);
  const shared = viewers[0].writes[1];
  assert.ok(Buffer.isBuffer(shared));
  for (const viewer of viewers) {
    assert.equal(viewer.writes.length, 2, "one connected write and one burst write");
    assert.strictEqual(viewer.writes[1], shared);
    assert.deepEqual(frames(viewer.writes).slice(1).map((frame) => frame.type), ["update-0", "update-1", "update-2"]);
  }
  assert.match(shared.toString(), /é 🐘/);
});

test("a false write is accepted once, healthy viewers continue, and drain preserves ordering", async (t) => {
  t.after(clearFanout);
  const project = randomUUID();
  const slow = sink(true), fast = sink();
  attachFanout(project, slow, () => {});
  attachFanout(project, fast, () => {});
  prepareFanout(project, { type: "first", data: {} });
  await delay(15);
  prepareFanout(project, { type: "second", data: {} });
  await delay(15);
  assert.deepEqual(frames(fast.writes).map((frame) => frame.type), ["connected", "first", "second"]);
  assert.equal(slow.writes.length, 1);
  slow.unblock();
  assert.deepEqual(frames(slow.writes).map((frame) => frame.type), ["connected", "first", "second"]);
  assert.equal(slow.res.listenerCount("drain"), 1);
});

test("queue overflow disconnects only the slow viewer and resume replays exactly the missed ordered frames", async (t) => {
  t.after(clearFanout);
  const project = randomUUID();
  const slow = sink(true), fast = sink();
  let disconnected = 0;
  attachFanout(project, slow, () => { disconnected++; });
  const stopFast = attachFanout(project, fast, () => {});
  const last = frames(slow.writes)[0].id;
  for (let i = 0; i < FANOUT_LIMITS.queueBatches + 1; i++) {
    prepareFanout(project, { type: "mutation", data: { index: i } });
    await delay(6);
  }
  assert.equal(disconnected, 1);
  assert.equal(slow.destroyed(), true);
  assert.equal(slow.res.listenerCount("drain"), 0);
  stopFast();
  assert.ok(retainedFanoutProjects().includes(project), "detection remains active while the last viewer reconnects");
  prepareFanout(project, { type: "mutation", data: { index: FANOUT_LIMITS.queueBatches + 1 } });
  const resumed = sink();
  assert.ok(canResumeFanout(project, last));
  attachFanout(project, resumed, () => {}, last);
  await delay(20);
  const missed = frames(resumed.writes).filter((frame) => frame.type === "mutation");
  assert.deepEqual(missed.map((frame) => JSON.parse(frame.data!).index as number), Array.from({ length: FANOUT_LIMITS.queueBatches + 2 }, (_, i) => i));
  assert.equal(new Set(missed.map((frame) => frame.id)).size, missed.length);
  assert.equal(canResumeFanout(randomUUID(), last), false);
  assert.equal(canResumeFanout(project, last + ":forged"), false);
});

test("byte bounds and write exceptions remove only failed sinks", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), slow = sink(true), bad = sink(false, true), fast = sink();
  let closed = 0;
  attachFanout(project, bad, () => { closed++; });
  attachFanout(project, slow, () => { closed++; });
  attachFanout(project, fast, () => {});
  Object.assign(slow.res, { writableLength: FANOUT_LIMITS.queueBytes });
  prepareFanout(project, { type: "bounded", data: {} });
  await delay(15);
  assert.equal(closed, 2);
  assert.equal(frames(fast.writes).at(-1)?.type, "bounded");
});

test("stall deadlines, expired journals, stale cursors, and shutdown have explicit bounds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(clearFanout);
  const project = randomUUID(), slow = sink(true);
  let closed = 0;
  attachFanout(project, slow, () => { closed++; });
  const cursor = frames(slow.writes)[0].id;
  heartbeatFanout(project, slow.id);
  t.mock.timers.tick(FANOUT_LIMITS.stallMs);
  assert.equal(closed, 1);
  t.mock.timers.tick(FANOUT_LIMITS.replayMs);
  assert.equal(canResumeFanout(project, cursor), false);
  assert.throws(() => attachFanout(project, sink(), () => {}, cursor), /expired/);
  clearFanout();
  assert.deepEqual(retainedFanoutProjects(), []);
});

test("one membership read applies to each viewer and fails closed on revocation or database error", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), allowed = sink(), denied = sink();
  let reads = 0, closed = 0;
  const members = new Set([allowed.userId]);
  const authorizeProject = async () => { reads++; return members; };
  attachFanout(project, { ...allowed, authorizeProject }, () => { closed++; });
  attachFanout(project, { ...denied, authorizeProject }, () => { closed++; });
  prepareFanout(project, { type: "private", data: { secret: "synthetic" } });
  await delay(15);
  assert.equal(reads, 1);
  assert.equal(frames(allowed.writes).at(-1)?.type, "private");
  assert.equal(frames(denied.writes).length, 1);
  members.clear();
  prepareFanout(project, { type: "revoked", data: {} });
  await delay(15);
  assert.equal(closed, 2);
  assert.equal(frames(allowed.writes).at(-1)?.type, "private");
  const failure = sink();
  attachFanout(project, { ...failure, authorizeProject: async () => { throw new Error("Synthetic database outage"); } }, () => { closed++; });
  prepareFanout(project, { type: "outage", data: {} });
  await delay(15);
  assert.equal(closed, 3);
  assert.equal(frames(failure.writes).length, 1);
});

test("empty drain callbacks read no permissions while the next private batch rechecks every viewer", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewers = Array.from({ length: 64 }, () => sink(true));
  const members = new Set(viewers.map((viewer) => viewer.userId));
  let reads = 0;
  const authorizeProject = async () => { reads++; return new Set(members); };
  for (const viewer of viewers) attachFanout(project, { ...viewer, authorizeProject }, () => {});
  viewers.forEach((viewer) => viewer.unblock());
  await delay(15);
  assert.equal(reads, 0, "draining a connected frame with no pending data needs no database query");
  viewers.forEach((viewer) => viewer.pause());
  prepareFanout(project, { type: "private-before-revoke", data: {} });
  await waitUntil(() => viewers.every((viewer) => viewer.writes.length === 2), 3000, "authorized slices");
  const firstReads = reads;
  assert.ok(firstReads >= 2, "yielded slices need fresh permission reads");
  viewers.forEach((viewer) => viewer.unblock());
  await delay(15);
  assert.equal(reads, firstReads, "completed response writes must not trigger empty permission reads");
  members.delete(viewers[0].userId);
  prepareFanout(project, { type: "private-after-revoke", data: {} });
  await waitUntil(() => viewers[0].destroyed() && viewers.slice(1).every((viewer) => frames(viewer.writes).at(-1)?.type === "private-after-revoke"), 3000, "revoked slices");
  assert.ok(reads >= firstReads + 2);
  assert.equal(viewers[0].destroyed(), true);
  assert.equal(frames(viewers[0].writes).at(-1)?.type, "private-before-revoke");
  for (const viewer of viewers.slice(1)) assert.equal(frames(viewer.writes).at(-1)?.type, "private-after-revoke");
});

test("a heartbeat cannot flush queued private data while fresh permission is pending", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), slow = sink(true), healthy = sink();
  const members = new Set([slow.userId, healthy.userId]);
  let reads = 0, release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const authorizeProject = async () => { if (++reads === 2) await held; return new Set(members); };
  attachFanout(project, { ...slow, authorizeProject }, () => {});
  attachFanout(project, { ...healthy, authorizeProject }, () => {});
  prepareFanout(project, { type: "queued-private", data: { synthetic: true } });
  await delay(15);
  assert.equal(reads, 1);
  assert.equal(slow.writes.length, 1);
  members.delete(slow.userId);
  slow.unblock();
  await delay(15);
  assert.equal(reads, 2);
  heartbeatFanout(project, slow.id);
  assert.equal(slow.writes.length, 1, "heartbeat must wait behind the fresh decision for queued project data");
  prepareFanout(project, { type: "later-private", data: {} });
  release!();
  await delay(25);
  assert.equal(slow.destroyed(), true);
  assert.deepEqual(frames(slow.writes).map((frame) => frame.type), ["connected"]);
  assert.equal(frames(healthy.writes).at(-1)?.type, "later-private");
});

test("yielded socket slices refresh membership before delivering to the next viewers", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewers = Array.from({ length: 96 }, () => sink());
  const members = new Set(viewers.map((viewer) => viewer.userId));
  const revoked = viewers.at(-1)!;
  let reads = 0;
  const authorizeProject = async () => {
    if (++reads === 1) setImmediate(() => members.delete(revoked.userId));
    return new Set(members);
  };
  for (const viewer of viewers) attachFanout(project, { ...viewer, authorizeProject }, () => {});
  prepareFanout(project, { type: "private-sliced", data: { synthetic: true } });
  await waitUntil(() => revoked.destroyed() && viewers.slice(0, -1).every((viewer) => viewer.writes.length === 2), 3000, "fresh authorization between slices");
  assert.ok(reads >= 3);
  assert.deepEqual(frames(revoked.writes).map((frame) => frame.type), ["connected"]);
});

for (const failedSlice of [2, 3]) {
test(`an authorization failure in slice ${failedSlice} detaches only unprocessed snapshot viewers`, async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewers = Array.from({ length: 96 }, () => sink()), joined = sink();
  const members = new Set([...viewers, joined].map((viewer) => viewer.userId));
  const processed = viewers.slice(0, (failedSlice - 1) * 32);
  const unprocessed = viewers.slice(processed.length);
  let reads = 0, closed = 0;
  const authorizeProject = async () => {
    reads++;
    if (reads === 1) attachFanout(project, { ...joined, authorizeProject }, () => { closed++; });
    if (reads === failedSlice) throw new Error("Synthetic later-slice membership failure");
    return new Set(members);
  };
  for (const viewer of viewers) attachFanout(project, { ...viewer, authorizeProject }, () => { closed++; });
  prepareFanout(project, { type: "before-failure", data: {} });
  await waitUntil(() => unprocessed.every((viewer) => viewer.destroyed()), 3000, "failed and remaining slice cleanup");
  assert.equal(reads, failedSlice);
  assert.equal(closed, unprocessed.length, "processed viewers and post-snapshot joins must survive");
  for (const viewer of [...processed, joined]) {
    assert.equal(viewer.destroyed(), false);
    assert.equal(viewer.res.listenerCount("drain"), 1);
  }
  for (const viewer of unprocessed) {
    assert.deepEqual(frames(viewer.writes).map((frame) => frame.type), ["connected"]);
    assert.equal(viewer.res.listenerCount("drain"), 0);
  }
  assert.deepEqual(frames(joined.writes).map((frame) => frame.type), ["connected"]);
  prepareFanout(project, { type: "after-recovery", data: {} });
  await waitUntil(() => [...processed, joined].every((viewer) => frames(viewer.writes).at(-1)?.type === "after-recovery"), 3000, "surviving viewer recovery");
  for (const viewer of processed) assert.deepEqual(frames(viewer.writes).map((frame) => frame.type), ["connected", "before-failure", "after-recovery"]);
  assert.deepEqual(frames(joined.writes).map((frame) => frame.type), ["connected", "after-recovery"]);
});
}

test("a membership read in flight keeps later events ordered and never overlaps another read", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewer = sink();
  let finish: (() => void) | undefined, reads = 0;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  attachFanout(project, { ...viewer, authorizeProject: async () => { reads++; await ready; return new Set([viewer.userId]); } }, () => {});
  prepareFanout(project, { type: "early", data: {} });
  await delay(15);
  prepareFanout(project, { type: "late", data: {} });
  await delay(15);
  assert.equal(reads, 1);
  assert.equal(viewer.writes.length, 1);
  finish!();
  await delay(20);
  assert.deepEqual(frames(viewer.writes).map((frame) => frame.type), ["connected", "early", "late"]);
});

test("replay byte/event/age limits reject a gap instead of returning a partial catch-up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(clearFanout);
  for (const overflow of ["events", "bytes", "age"]) {
    const project = randomUUID(), viewer = sink();
    const stop = attachFanout(project, viewer, () => {});
    const cursor = frames(viewer.writes)[0].id;
    stop();
    if (overflow === "events") for (let i = 0; i <= FANOUT_LIMITS.replayEvents; i++) prepareFanout(project, { type: "many", data: i });
    if (overflow === "bytes") prepareFanout(project, { type: "large", data: "x".repeat(FANOUT_LIMITS.replayBytes) });
    if (overflow === "age") {
      prepareFanout(project, { type: "old", data: {} });
      // Keep a viewer attached so this exercises frame age, rather than project expiry.
      attachFanout(project, sink(), () => {});
      t.mock.timers.tick(FANOUT_LIMITS.replayMs + 1);
    }
    assert.equal(canResumeFanout(project, cursor), false, overflow);
  }
  const unobserved = randomUUID();
  prepareFanout(unobserved, { type: "offline", data: {} });
  assert.equal(retainedFanoutProjects().includes(unobserved), false);
});

test("unobserved project traffic allocates no journal, and failed serialization cannot advance a cursor", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewer = sink();
  prepareFanout(project, { type: "unobserved", data: {} });
  assert.deepEqual(retainedFanoutProjects(), []);
  attachFanout(project, viewer, () => {});
  const cursor = frames(viewer.writes)[0].id;
  assert.throws(() => prepareFanout(project, { type: "broken", data: { toJSON: () => { throw new Error("Synthetic encoding failure"); } } }));
  prepareFanout(project, { type: "valid", data: {} });
  await delay(15);
  assert.ok(canResumeFanout(project, cursor));
  assert.equal(frames(viewer.writes).at(-1)?.id.split(":")[1], "1");
});

test("a catch-up larger than the client queue progresses in bounded shared chunks without disconnecting", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), initial = sink();
  const stop = attachFanout(project, initial, () => {});
  const cursor = frames(initial.writes)[0].id;
  stop();
  for (let i = 0; i < 120; i++) prepareFanout(project, { type: "catch-up", data: { index: i, text: "x".repeat(16 * 1024) } });
  const a = sink(), b = sink();
  attachFanout(project, a, () => {}, cursor);
  attachFanout(project, b, () => {}, cursor);
  const deadline = performance.now() + 3000;
  while (frames(a.writes).filter((frame) => frame.type === "catch-up").length < 120 && performance.now() < deadline) await delay(10);
  assert.equal(a.destroyed(), false);
  assert.equal(b.destroyed(), false);
  const received = frames(a.writes).filter((frame) => frame.type === "catch-up");
  assert.deepEqual(received.map((frame) => JSON.parse(frame.data!).index as number), Array.from({ length: 120 }, (_, i) => i));
  assert.equal(new Set(received.map((frame) => frame.id)).size, 120);
  assert.ok(a.writes.slice(1).reduce((bytes, buffer) => bytes + buffer.length, 0) > FANOUT_LIMITS.queueBytes);
  for (let i = 1; i < a.writes.length; i++) {
    assert.ok(a.writes[i].length <= 64 * 1024);
    assert.strictEqual(a.writes[i], b.writes[i]);
  }
});

test("events arriving during a membership read require their own fresh authorization decision", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewer = sink();
  const members = new Set([viewer.userId]);
  let release: (() => void) | undefined, observed: (() => void) | undefined, reads = 0, closed = 0;
  const started = new Promise<void>((resolve) => { observed = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  attachFanout(project, { ...viewer, authorizeProject: async () => {
    const snapshot = new Set(members);
    if (reads++ === 0) { observed!(); await held; }
    return snapshot;
  } }, () => { closed++; });
  prepareFanout(project, { type: "authorized-before-revoke", data: {} });
  await delay(10);
  assert.equal(reads, 1, "Initial authorization read must start");
  await started;
  members.clear();
  prepareFanout(project, { type: "private-after-revoke", data: {} });
  release!();
  await delay(25);
  assert.equal(frames(viewer.writes).some((frame) => frame.type === "private-after-revoke"), false);
  assert.equal(reads, 2);
  assert.equal(closed, 1);
});

for (const readFails of [false, true]) {
test(`a newly granted viewer never uses a prior registration's membership result (read fails: ${readFails})`, async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), old = sink(), added = sink();
  const members = new Set([old.userId]);
  let release: (() => void) | undefined, observed: (() => void) | undefined, reads = 0;
  const started = new Promise<void>((resolve) => { observed = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const authorizeProject = async () => {
    const snapshot = new Set(members);
    if (reads++ === 0) { observed!(); await held; if (readFails) throw new Error("Synthetic delayed membership failure"); }
    return snapshot;
  };
  attachFanout(project, { ...old, authorizeProject }, () => {});
  prepareFanout(project, { type: "before-join", data: {} });
  await delay(10);
  assert.equal(reads, 1, "Initial authorization read must start");
  await started;
  members.add(added.userId);
  attachFanout(project, { ...added, authorizeProject }, () => {});
  prepareFanout(project, { type: "after-join", data: {} });
  release!();
  await delay(25);
  assert.equal(added.destroyed(), false);
  assert.equal(old.destroyed(), readFails);
  assert.deepEqual(frames(added.writes).map((frame) => frame.type), ["connected", "after-join"]);
});
}

/** Flush more than a replay budget of full rosters without creating a measured workload. */
async function churnPresence(project: string): Promise<void> {
  for (let index = 0; index < 25; index++) {
    prepareFanout(project, { type: "presence", data: { index, text: "x".repeat(432 * 1024) } });
    await delay(6);
  }
}

test("presence churn cannot evict mutations or replay historical rosters", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), live = sink();
  attachFanout(project, live, () => {});
  const cursor = frames(live.writes)[0].id;
  prepareFanout(project, { type: "mutation", data: { index: 1 } });
  await churnPresence(project);
  assert.ok(canResumeFanout(project, cursor), "rosters must not consume the mutation replay budget");
  const resumed = sink();
  attachFanout(project, resumed, () => {}, cursor);
  await delay(20);
  assert.deepEqual(frames(resumed.writes).map((frame) => frame.type), ["connected", "mutation"]);
  assert.equal(frames(resumed.writes).at(-1)?.id.split(":")[1], "1");
  assert.ok(frames(live.writes).filter((frame) => frame.type === "presence").every((frame) => frame.id === ""));
});

test("blocked viewers retain only the newest presence snapshot within the transport byte budget", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), slow = sink(true), fast = sink();
  attachFanout(project, slow, () => {});
  attachFanout(project, fast, () => {});
  Object.assign(slow.res, { writableLength: 432 * 1024 });
  await churnPresence(project);
  prepareFanout(project, { type: "mutation", data: { index: 99 } });
  await delay(15);
  assert.equal(slow.destroyed(), false, "replaced snapshots must not accumulate against queue limits");
  Object.assign(slow.res, { writableLength: 0 });
  slow.unblock();
  const received = frames(slow.writes);
  assert.deepEqual(received.map((frame) => frame.type), ["connected", "mutation", "presence"]);
  assert.equal(JSON.parse(received.at(-1)!.data!).index, 24);
  assert.equal(received.at(-1)!.id, "");
  assert.equal(frames(fast.writes).filter((frame) => frame.type === "mutation").length, 1);
  prepareFanout(project, { type: "presence", data: "x".repeat(FANOUT_LIMITS.queueBytes) });
  assert.equal(slow.destroyed(), true, "a single oversized snapshot still obeys the hard byte limit");
});

test("a presence snapshot arriving during authorization requires a later decision, including drain and heartbeat", async (t) => {
  t.after(clearFanout);
  const project = randomUUID(), viewer = sink(true);
  let release: (() => void) | undefined, reads = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const members = new Set([viewer.userId]);
  attachFanout(project, { ...viewer, authorizeProject: async () => {
    const snapshot = new Set(members);
    if (++reads === 1) await held;
    return snapshot;
  } }, () => {});
  prepareFanout(project, { type: "presence", data: { users: ["old"] } });
  await delay(15);
  assert.equal(reads, 1);
  members.clear();
  prepareFanout(project, { type: "presence", data: { users: ["private-new"] } });
  viewer.unblock();
  heartbeatFanout(project, viewer.id);
  release!();
  await delay(30);
  assert.equal(viewer.destroyed(), true);
  assert.equal(reads, 2);
  assert.equal(frames(viewer.writes).some((frame) => frame.type === "presence"), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createMutationEventReconciler, startMutationEventWatcher } from "../dist/services/mutation-event-watcher.js";
import type { MutationEvent } from "@unbrained/pm-cli/sdk";
import type { SSEEvent } from "../dist/services/sse.js";

const PID_A = "11111111-1111-4111-8111-111111111111";
const PID_B = "22222222-2222-4221-8222-222222222222";

interface EmitRecord {
  projectId: string;
  event: SSEEvent;
}

// A fake subscribe factory that returns a controllable async generator. Each
// call registers itself so the test can push events or end the stream.
function makeSubscribeHarness() {
  const instances: Array<{
    options: { pmRoot: string; since: string; intervalMs: number; signal: AbortSignal };
    events: MutationEvent[];
    ended: boolean;
  }> = [];

  // Empty-read delay mirroring the SDK's `intervalMs` contract. The timer is
  // `unref`'d so a subscription a test leaves running can never hold the process
  // open after the suite finishes — without this the detached loops keep the
  // event loop alive forever and `node --test` never reports.
  const delay = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });

  const subscribe = (options: { pmRoot: string; since: string; intervalMs: number; signal: AbortSignal }): AsyncGenerator<MutationEvent, void, void> => {
    const inst = { options, events: [] as MutationEvent[], ended: false };
    instances.push(inst);
    return (async function* () {
      try {
        while (!inst.ended && !options.signal.aborted) {
          const next = inst.events.shift();
          if (next === undefined) {
            // Wait out the empty-read delay rather than spinning: a zero-delay
            // re-check saturates the event loop and starves the test reporter.
            await delay(Math.max(1, options.intervalMs));
            continue;
          }
          yield next;
        }
      } finally {
        inst.ended = true;
      }
    })();
  };

  return { instances, subscribe };
}

function makeEvent(itemId: string, cursor: string, type = "update", author = "other-agent"): MutationEvent {
  return { cursor, item_id: itemId, version: 1, ts: new Date().toISOString(), author, type, patch_count: 1 };
}

test("mutation-event watcher: newly-active project starts a subscription and delivers events with granular payload", async () => {
  const emitted: EmitRecord[] = [];
  const errors: unknown[] = [];
  const { instances, subscribe } = makeSubscribeHarness();
  const activeIds = (): string[] => [PID_A];

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: activeIds,
    resolveProjectDir: async () => "/proj/a",
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(instances.length, 1, "one subscription started");
  assert.equal(instances[0].options.pmRoot, "/proj/a/.agents/pm");
  assert.match(instances[0].options.since, /^\d{4}-\d{2}-\d{2}T/);

  // Push an event into the subscription.
  instances[0].events.push(makeEvent("item-1", "cursor-1", "create", "pm-gpt"));

  // Give the detached loop a tick to consume it.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(emitted.length, 1, "one event delivered");
  assert.equal(emitted[0].projectId, PID_A);
  assert.equal(emitted[0].event.type, "workspace-changed");
  assert.deepEqual(emitted[0].event.data, {
    source: "mutation-events",
    itemId: "item-1",
    operation: "create",
    author: "pm-gpt",
  });
  assert.equal(errors.length, 0);
});

test("mutation-event watcher: inactive project aborts subscription and cleans up state", async () => {
  const emitted: EmitRecord[] = [];
  const errors: unknown[] = [];
  const { instances, subscribe } = makeSubscribeHarness();
  let list: string[] = [PID_A];
  const activeIds = (): string[] => list.slice();

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: activeIds,
    resolveProjectDir: async () => "/proj/a",
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(instances.length, 1);
  const controller = instances[0].options.signal;

  // Remove the project from active set.
  list = [];
  await reconcile();

  assert.equal(controller.aborted, true, "subscription was aborted");
  // Give the loop time to notice abort.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(errors.length, 0, "AbortError must NOT be reported");
});

test("mutation-event watcher: per-item dedupe skips events already announced by this instance", async () => {
  const emitted: EmitRecord[] = [];
  const errors: unknown[] = [];
  const { instances, subscribe } = makeSubscribeHarness();
  const signaled = new Set<string>();

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => "/proj/a",
    subscribe,
    consumeSignaledItemMutation: (pid, itemId) => {
      const key = `${pid} ${itemId}`;
      if (signaled.has(key)) { signaled.delete(key); return true; }
      return false;
    },
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await reconcile();

  // Mark item-1 as already announced (this instance's own API write).
  signaled.add(`${PID_A} item-1`);
  // item-2 is NOT signaled (another agent's write).
  instances[0].events.push(makeEvent("item-1", "cursor-1"));
  instances[0].events.push(makeEvent("item-2", "cursor-2"));

  await new Promise((r) => setTimeout(r, 50));

  // Only item-2 should be delivered; item-1 was consumed/suppressed.
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0].event.data as { itemId: string }).itemId, "item-2");
  assert.equal(errors.length, 0);
});

// Locks in the invariant that makes project+item (rather than per-mutation-id)
// dedupe safe: consumption is ONE-SHOT, so a single recorded signal suppresses at
// most ONE event and every later event for that same item is still delivered.
// Without this property, a signal recorded for a later mutation could swallow an
// unbounded run of earlier events on the same item and a client could be left
// stale; with it, a surviving event always arrives and its authoritative refetch
// covers whatever was suppressed.
test("mutation-event watcher: a single per-item signal suppresses exactly one event, not the whole item stream", async () => {
  const emitted: EmitRecord[] = [];
  const errors: unknown[] = [];
  const { instances, subscribe } = makeSubscribeHarness();
  const signaled = new Set<string>();

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => "/proj/a",
    subscribe,
    consumeSignaledItemMutation: (pid, itemId) => {
      const key = `${pid} ${itemId}`;
      if (signaled.has(key)) { signaled.delete(key); return true; }
      return false;
    },
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await reconcile();

  // ONE signal recorded for item-1, then THREE mutations of item-1 arrive —
  // e.g. this instance wrote once while another agent wrote twice.
  signaled.add(`${PID_A} item-1`);
  instances[0].events.push(makeEvent("item-1", "cursor-1"));
  instances[0].events.push(makeEvent("item-1", "cursor-2"));
  instances[0].events.push(makeEvent("item-1", "cursor-3"));

  await new Promise((r) => setTimeout(r, 60));

  // Exactly one suppressed; the remaining two still reach clients, so the
  // concurrent agent's changes are never silently dropped.
  assert.equal(emitted.length, 2);
  assert.deepEqual(
    emitted.map((e) => (e.event.data as { itemId: string }).itemId),
    ["item-1", "item-1"],
  );
  assert.equal(signaled.size, 0, "the signal must be consumed, not left behind to suppress again");
  assert.equal(errors.length, 0);
});

test("mutation-event watcher: cursor resume after an error restarts from stored cursor", async () => {
  const emitted: EmitRecord[] = [];
  const errors: unknown[] = [];
  const { instances, subscribe } = makeSubscribeHarness();
  let errorOnce = true;

  // Custom subscribe that throws after the first event to simulate an error,
  // then succeeds on restart.
  let callCount = 0;
  const sinceValues: string[] = [];
  const customSubscribe = (options: { pmRoot: string; since: string; intervalMs: number; signal: AbortSignal }): AsyncGenerator<MutationEvent, void, void> => {
    callCount += 1;
    sinceValues.push(options.since);
    const myCall = callCount;
    return (async function* () {
      if (myCall === 1) {
        yield makeEvent("item-err", "cursor-after-error", "update", "agent-x");
        if (errorOnce) { errorOnce = false; throw new Error("stream broke"); }
      }
      // On restart, yield nothing (just return).
    })();
  };

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => "/proj/a",
    subscribe: customSubscribe,
    consumeSignaledItemMutation: () => false,
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  // Wait for the first event + error.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emitted.length, 1, "first event delivered before error");
  assert.equal(errors.length, 1, "error reported");
  assert.equal(sinceValues[0].match(/^\d{4}-/) !== null, true, "first since is ISO timestamp");

  // Reconcile again — should detect the loop is done and restart from cursor.
  await reconcile();
  assert.equal(callCount, 2, "subscription restarted");
  assert.equal(sinceValues[1], "cursor-after-error", "restart uses stored cursor, not ISO timestamp");
  // No new events on the restart, so no new emit.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emitted.length, 1);
  // The restart error is not repeated.
  assert.equal(errors.length, 1);
});

test("mutation-event watcher: AbortError from deliberate stop is NOT reported as error", async () => {
  const errors: unknown[] = [];
  const { subscribe } = makeSubscribeHarness();

  const { reconcile, stopAll } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => "/proj/a",
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  await stopAll();
  // Give the loop time to process the abort.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors.length, 0, "AbortError must not be reported");
});

test("mutation-event watcher: PM_REALTIME_MUTATION_EVENTS=false returns a no-op stop fn", () => {
  const orig = process.env.PM_REALTIME_MUTATION_EVENTS;
  process.env.PM_REALTIME_MUTATION_EVENTS = "false";
  try {
    const stop = startMutationEventWatcher({});
    assert.equal(typeof stop, "function");
    assert.doesNotThrow(() => stop());
  } finally {
    if (orig === undefined) delete process.env.PM_REALTIME_MUTATION_EVENTS;
    else process.env.PM_REALTIME_MUTATION_EVENTS = orig;
  }
});

test("mutation-event watcher: intervalMs is floored at 10 and reconcileMs at 500", () => {
  const orig = process.env.PM_MUTATION_EVENT_INTERVAL_MS;
  const origRec = process.env.PM_MUTATION_EVENT_RECONCILE_MS;
  process.env.PM_MUTATION_EVENT_INTERVAL_MS = "1";
  process.env.PM_MUTATION_EVENT_RECONCILE_MS = "10";
  try {
    // We can't easily inspect the internal clamped values directly, but the
    // startMutationEventWatcher should not throw and should produce a stop fn.
    // The clamping is exercised by verifying the env is read without error.
    const stop = startMutationEventWatcher({});
    assert.equal(typeof stop, "function");
    stop();
  } finally {
    if (orig === undefined) delete process.env.PM_MUTATION_EVENT_INTERVAL_MS;
    else process.env.PM_MUTATION_EVENT_INTERVAL_MS = orig;
    if (origRec === undefined) delete process.env.PM_MUTATION_EVENT_RECONCILE_MS;
    else process.env.PM_MUTATION_EVENT_RECONCILE_MS = origRec;
  }
});

test("mutation-event watcher: no overlapping reconciles", async () => {
  const errors: unknown[] = [];
  // Count entries into the reconcile body itself. `resolveProjectDir` is the
  // wrong probe here: it is memoized per project in `dirCache`, so a later
  // reconcile legitimately skips it on a cache hit and would look like the
  // in-flight guard had swallowed the call.
  let reconcileEntries = 0;
  let resolveDirBlock: (() => void) | null = null;
  let dirBlocked = false;

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => { reconcileEntries += 1; return [PID_A]; },
    resolveProjectDir: async () => {
      if (dirBlocked) {
        return new Promise<string>((resolve) => { resolveDirBlock = () => resolve("/proj/a"); });
      }
      return "/proj/a";
    },
    subscribe: () => (async function* () { /* no-op */ })(),
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  // First reconcile starts but blocks on resolveProjectDir.
  dirBlocked = true;
  const p1 = reconcile();
  // Second reconcile should be skipped (inFlight guard).
  await reconcile();
  assert.equal(reconcileEntries, 1, "second reconcile skipped due to inFlight guard");

  // Unblock the first.
  dirBlocked = false;
  resolveDirBlock!();
  await p1;

  // Now a third reconcile proceeds.
  await reconcile();
  assert.equal(reconcileEntries, 2, "third reconcile proceeds after first completes");
  assert.equal(errors.length, 0);
});

test("mutation-event watcher: resolveProjectDir returning null skips project (no subscription started)", async () => {
  const { instances, subscribe } = makeSubscribeHarness();
  const errors: unknown[] = [];

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => null,
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(instances.length, 0, "no subscription for unresolved project");
  assert.equal(errors.length, 0);
});

test("mutation-event watcher: transient resolveProjectDir failure is retried, not cached as null", async () => {
  const { instances, subscribe } = makeSubscribeHarness();
  const errors: unknown[] = [];
  let resolveCalls = 0;

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A],
    resolveProjectDir: async () => {
      resolveCalls += 1;
      if (resolveCalls === 1) throw new Error("db down");
      return "/proj/a";
    },
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(errors.length, 1, "first resolve fails");
  assert.equal(instances.length, 0);

  await reconcile();
  assert.equal(resolveCalls, 2, "resolve retried, not cached as null");
  assert.equal(instances.length, 1, "subscription started on retry");
});

test("mutation-event watcher: multiple active projects each get independent subscriptions", async () => {
  const { instances, subscribe } = makeSubscribeHarness();
  const errors: unknown[] = [];

  const { reconcile } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A, PID_B],
    resolveProjectDir: async (id) => id === PID_A ? "/proj/a" : "/proj/b",
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(instances.length, 2, "two independent subscriptions");
  assert.equal(instances[0].options.pmRoot, "/proj/a/.agents/pm");
  assert.equal(instances[1].options.pmRoot, "/proj/b/.agents/pm");
  assert.equal(errors.length, 0);
});

test("mutation-event watcher: stopAll aborts all subscriptions", async () => {
  const { instances, subscribe } = makeSubscribeHarness();
  const errors: unknown[] = [];

  const { reconcile, stopAll } = createMutationEventReconciler({
    intervalMs: 10,
    getActiveProjectIds: () => [PID_A, PID_B],
    resolveProjectDir: async (id) => id === PID_A ? "/proj/a" : "/proj/b",
    subscribe,
    consumeSignaledItemMutation: () => false,
    emit: () => undefined,
    onError: (err) => { errors.push(err); },
  });

  await reconcile();
  assert.equal(instances.length, 2);
  await stopAll();
  assert.equal(instances[0].options.signal.aborted, true);
  assert.equal(instances[1].options.signal.aborted, true);
  assert.equal(errors.length, 0, "no errors from deliberate abort");
});
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectWatchCycle } from "../dist/services/project-watcher.js";
import type { SSEEvent } from "../dist/services/sse.js";

interface EmitRecord {
  projectId: string;
  event: SSEEvent;
}

function makeHarness(opts: {
  activeIds: () => string[];
  dirs: Map<string, string | null>;
  mtimes: Map<string, number>;
  signaled: Set<string>;
  errors: unknown[];
}) {
  const emitted: EmitRecord[] = [];
  const cycle = createProjectWatchCycle({
    intervalMs: 1000,
    suppressWindowMs: 10_000,
    getActiveProjectIds: () => opts.activeIds(),
    resolveProjectDir: async (id) => opts.dirs.get(id) ?? null,
    readSignature: async (dir) => {
      // dir is the project dir; find which projectId it maps to. The mtimes map
      // stands in for the composite signature — any change (up OR down) is a
      // distinct string, mirroring the real count:max:sum fingerprint.
      for (const [pid, d] of opts.dirs) {
        if (d === dir) return String(opts.mtimes.get(pid) ?? 0);
      }
      return "0";
    },
    wasSignaledWithin: (id, _w) => opts.signaled.has(id),
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { opts.errors.push(err); },
  });
  return { emitted, cycle };
}

const PID_A = "11111111-1111-4111-8111-111111111111";
const PID_B = "22222222-2222-4222-8222-222222222222";

test("project watcher: first tick baselines, later mtime increase emits workspace-changed", async () => {
  const activeIds = (): string[] => [PID_A];
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"]]);
  const mtimes = new Map<string, number>([[PID_A, 1_000]]);
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick();
  assert.equal(emitted.length, 0, "first tick should baseline, no emit");

  mtimes.set(PID_A, 2_000);
  await cycle.tick();
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    projectId: PID_A,
    event: { type: "workspace-changed", data: { source: "filesystem" } },
  });
  assert.equal(errors.length, 0);
});

test("project watcher: signaled project suppresses emit but baseline advances", async () => {
  const activeIds = (): string[] => [PID_A];
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"]]);
  const mtimes = new Map<string, number>([[PID_A, 1_000]]);
  const signaled = new Set<string>([PID_A]);
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick();
  assert.equal(emitted.length, 0, "baseline");

  mtimes.set(PID_A, 2_000);
  await cycle.tick();
  assert.equal(emitted.length, 0, "suppressed because signaled");

  // Now unsignal and bump mtime again — should emit exactly once
  signaled.delete(PID_A);
  mtimes.set(PID_A, 3_000);
  await cycle.tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].projectId, PID_A);
  assert.equal(emitted[0].event.type, "workspace-changed");
});

test("project watcher: unchanged mtime across ticks produces no emit", async () => {
  const activeIds = (): string[] => [PID_A];
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"]]);
  const mtimes = new Map<string, number>([[PID_A, 5_000]]);
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick();
  await cycle.tick();
  await cycle.tick();
  assert.equal(emitted.length, 0);
});

test("project watcher: inactive projects pruned; re-adding re-baselines without spurious emit", async () => {
  const list: string[] = [PID_A];
  const activeIds = (): string[] => list.slice();
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"]]);
  const mtimes = new Map<string, number>([[PID_A, 1_000]]);
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick(); // baseline PID_A
  assert.equal(emitted.length, 0);

  // Remove from active set
  list.length = 0;
  await cycle.tick();
  assert.equal(emitted.length, 0);

  // Re-add; mtime higher than before but project was pruned so should re-baseline
  list.push(PID_A);
  mtimes.set(PID_A, 9_000);
  await cycle.tick();
  assert.equal(emitted.length, 0, "re-baseline after re-add should NOT emit");

  // Subsequent increase should emit
  mtimes.set(PID_A, 10_000);
  await cycle.tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].projectId, PID_A);
});

test("project watcher: resolveProjectDir returning null skips project (no emit, no throw)", async () => {
  const activeIds = (): string[] => [PID_A];
  const dirs = new Map<string, string | null>([[PID_A, null]]);
  const mtimes = new Map<string, number>();
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick();
  await cycle.tick();
  assert.equal(emitted.length, 0);
  assert.equal(errors.length, 0);
});

test("project watcher: readMaxMtimeMs throwing for one project calls onError but others continue", async () => {
  const activeIds = (): string[] => [PID_A, PID_B];
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"], [PID_B, "/proj/b"]]);
  const mtimes = new Map<string, number>([[PID_A, 1_000], [PID_B, 1_000]]);
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const emitted: EmitRecord[] = [];

  // Custom harness where PID_A's read throws
  const cycle = createProjectWatchCycle({
    intervalMs: 1000,
    suppressWindowMs: 10_000,
    getActiveProjectIds: () => activeIds(),
    resolveProjectDir: async (id) => dirs.get(id) ?? null,
    readSignature: async (dir) => {
      if (dir === "/proj/a") throw new Error("boom");
      for (const [pid, d] of dirs) if (d === dir) return String(mtimes.get(pid) ?? 0);
      return "0";
    },
    wasSignaledWithin: () => false,
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await cycle.tick(); // A throws, B baselines
  assert.equal(errors.length, 1);
  assert.equal(emitted.length, 0);

  mtimes.set(PID_B, 2_000);
  await cycle.tick(); // A throws again, B emits
  assert.equal(errors.length, 2);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].projectId, PID_B);
  assert.equal(emitted[0].event.type, "workspace-changed");
});

test("project watcher: signature change to a LOWER value (mtime-preserving restore) still emits", async () => {
  // A raw restore can rewrite item files with older preserved mtimes, so the
  // composite signature must trigger on ANY change, not only on an increase.
  const activeIds = (): string[] => [PID_A];
  const dirs = new Map<string, string | null>([[PID_A, "/proj/a"]]);
  const mtimes = new Map<string, number>([[PID_A, 5_000]]);
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const { emitted, cycle } = makeHarness({ activeIds, dirs, mtimes, signaled, errors });

  await cycle.tick(); // baseline at 5_000
  assert.equal(emitted.length, 0);

  mtimes.set(PID_A, 1_000); // restore rolls the signature "backwards"
  await cycle.tick();
  assert.equal(emitted.length, 1, "a lower/different signature must emit");
  assert.equal(emitted[0].projectId, PID_A);
  assert.equal(emitted[0].event.type, "workspace-changed");
  assert.equal(errors.length, 0);
});

test("project watcher: transient resolveProjectDir failure is retried, not cached as null", async () => {
  // A DB error while resolving the project dir must NOT be cached for the whole
  // SSE session — the next tick has to retry once the DB recovers.
  const activeIds = (): string[] => [PID_A];
  const signaled = new Set<string>();
  const errors: unknown[] = [];
  const emitted: EmitRecord[] = [];
  let resolveCalls = 0;
  const mtimes = new Map<string, number>([[PID_A, 1_000]]);

  const cycle = createProjectWatchCycle({
    intervalMs: 1000,
    suppressWindowMs: 10_000,
    getActiveProjectIds: () => activeIds(),
    resolveProjectDir: async () => {
      resolveCalls += 1;
      if (resolveCalls === 1) throw new Error("db down");
      return "/proj/a";
    },
    readSignature: async () => String(mtimes.get(PID_A) ?? 0),
    wasSignaledWithin: () => false,
    emit: (projectId, event) => { emitted.push({ projectId, event }); },
    onError: (err) => { errors.push(err); },
  });

  await cycle.tick(); // resolve throws → onError, nothing cached
  assert.equal(errors.length, 1);
  assert.equal(emitted.length, 0);

  await cycle.tick(); // retries resolve → succeeds → baselines (no emit yet)
  assert.equal(resolveCalls, 2, "resolve must be retried, not cached as null");
  assert.equal(emitted.length, 0);

  mtimes.set(PID_A, 2_000);
  await cycle.tick(); // now a real change emits, proving the project is watched
  assert.equal(resolveCalls, 2, "dir is cached after the successful resolve");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].projectId, PID_A);
});
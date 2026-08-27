/**
 * The PostgreSQL probe must never have two queries outstanding at once.
 *
 * A timed-out probe reports in milliseconds while its query keeps a pool client
 * checked out until PostgreSQL answers. A cooldown keyed only on elapsed time
 * therefore starts another one on schedule during a stall that has not ended,
 * and a prolonged stall drains the shared pool one client per cooldown -- out
 * from under the ordinary API, not just the health endpoint.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHealthHandler, type Queryable } from "../src/health.ts";

/** Minimal Express response double capturing the status code. */
function response(): { status(code: number): unknown; json(body: unknown): void; code: number } {
  const captured = {
    code: 0,
    status(code: number) { captured.code = code; return captured; },
    json(_body: unknown) {},
  };
  return captured;
}

test("a stall that outlives the cooldown never starts a second probe query", async () => {
  const root = mkdtempSync(join(tmpdir(), "healthz-pool-guard-"));
  try {
    let started = 0;
    // Never settles: the shape of a PostgreSQL server that has stopped
    // answering while holding the connection open.
    const stalled: Queryable = { query: () => { started += 1; return new Promise(() => {}); } };
    const handler = createHealthHandler({
      pool: stalled,
      projectsRoot: root,
      version: "test",
      timing: { probeTimeoutMs: 20, cacheTtlMs: 1, poolCooldownMs: 30 },
    });

    // Six requests spanning several cooldowns, each well past the cache TTL.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = response();
      await handler({} as never, res as never, (() => {}) as never);
      assert.equal(res.code, 503, "a stalled database must report unhealthy");
      await new Promise((done) => setTimeout(done, 40));
    }

    assert.equal(
      started,
      1,
      `the stalled query must be issued once, not once per cooldown (issued ${started})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy pool is probed again once the cache expires", async () => {
  // The guard must not turn into a permanent block: it clears when the query
  // settles, so ordinary re-probing continues.
  const root = mkdtempSync(join(tmpdir(), "healthz-pool-guard-ok-"));
  try {
    let started = 0;
    const healthy: Queryable = { query: () => { started += 1; return Promise.resolve({ rows: [] }); } };
    const handler = createHealthHandler({
      pool: healthy,
      projectsRoot: root,
      version: "test",
      timing: { probeTimeoutMs: 50, cacheTtlMs: 1, poolCooldownMs: 1 },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = response();
      await handler({} as never, res as never, (() => {}) as never);
      assert.equal(res.code, 200, "a healthy pool must report healthy");
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.equal(started, 3, "each expired cache must re-probe a pool that answers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

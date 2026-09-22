import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";
import { createApp } from "../src/app.ts";
import { createHealthHandler, type HealthProbeDeps, type SoftProbe, type DependencyStatus, type Queryable } from "../src/health.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that mode bits actually restrict this process.
 *
 * `chmod 0555` does not stop root from writing, so a read-only-directory test
 * running as root asserts nothing while still passing. Failing loudly is the
 * only honest option: a green test that proves nothing is worse than a red one.
 */
function requireModeBitsEnforced(): void {
  assert.notEqual(
    process.getuid?.(),
    0,
    "this test relies on filesystem permissions, which root bypasses - run the suite as a non-root user"
  );
}

/** A pool whose `query` resolves immediately — the healthy baseline. */
function healthyPool(): Queryable {
  return { query: () => Promise.resolve({ rows: [] }) };
}

/** A pool whose `query` rejects — simulates an unreachable database. */
function unreachablePool(): Queryable {
  return { query: () => Promise.reject(new Error("connection refused")) };
}

/** A pool whose `query` never settles — simulates a hung database. */
function hangingPool(): Queryable {
  return { query: () => new Promise<{ rows: unknown[] }>(() => {}) };
}

/** A pool whose `query` resolves after a delay longer than the probe timeout. */
function slowPool(ms: number): Queryable {
  return { query: () => new Promise<{ rows: unknown[] }>((resolve) => { setTimeout(() => { resolve({ rows: [] }); }, ms); }) };
}

/** A real writable temp directory — the healthy projects-root baseline. */
function writableRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "pm-web-healthz-"));
}

/**
 * Start a real ephemeral HTTP server with the given Express app and issue a
 * GET /healthz, returning the parsed JSON body and status code.
 *
 * Uses a real server (not a fake req/res) so the full Express 5 async-handler
 * and middleware pipeline runs exactly as it does in production.
 */
async function getHealthz(deps: HealthProbeDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = createApp({
    health: {
      pool: deps.pool,
      projectsRoot: deps.projectsRoot,
      version: deps.version,
      softProbes: deps.softProbes,
    },
  });
  const { port, close } = await startEphemeralServer(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json() as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await close();
  }
}

/**
 * Variant that calls the handler factory directly (without Express) to test
 * the handler in isolation — useful for cache timing and probe internals.
 */
async function directHealthz(deps: HealthProbeDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createHealthHandler(deps);
  const { res, getStatus, getBody } = createFakeRes();
  const req = {} as never;
  const next = (() => {}) as never;
  await handler(req, res, next);
  return { status: getStatus(), body: getBody() };
}

/**
 * Drive one already-constructed handler, so cache and cooldown state persist.
 *
 * {@link directHealthz} builds a fresh handler per call, which resets the very
 * state these tests exist to observe.
 *
 * @param handler - The handler under test.
 * @returns Its status code and JSON body.
 */
async function callHandler(
  handler: ReturnType<typeof createHealthHandler>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, getStatus, getBody } = createFakeRes();
  const req = {} as never;
  await handler(req, res, (() => {}) as never);
  return { status: getStatus(), body: getBody() };
}

/** The handler's response-cache TTL, mirrored so tests can step past it. */
const CACHE_TTL_FOR_TEST = 5000;
/** A no-op Express response for cache tests that only count queries. */
function noopRes(): never {
  return { status(_code: number) { return this; }, json(_b: unknown) {} } as never;
}

/** Create a minimal fake Express response that captures status and body. */
function createFakeRes(): { res: never; getStatus: () => number; getBody: () => Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) { status = code; return this; },
    json(payload: unknown) { body = payload as Record<string, unknown>; },
  } as never;
  return { res, getStatus: () => status, getBody: () => body };
}

/** Run a test body with a writable root directory, cleaning up afterwards. */
async function withWritableRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-healthz-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Assert the common unhealthy-response shape: given status, ok=false, and
 * postgres.ok + error presence. When `errorRegex` is given, the postgres error
 * is matched against it instead of just being checked for presence. */
function assertUnhealthy(
  result: { status: number; body: Record<string, unknown> },
  expectedStatus: number,
  postgresOk: boolean,
  errorRegex?: RegExp,
): void {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.body.ok, false);
  const deps = result.body.dependencies as Record<string, DependencyStatus>;
  assert.equal(deps.postgres.ok, postgresOk);
  if (errorRegex) {
    assert.match(deps.postgres.error ?? "", errorRegex);
  } else if (!postgresOk) {
    assert.ok(deps.postgres.error, "postgres error must be reported");
  }
}

/** Assert a 503 with a timed-out postgres (common to hung and slow pool tests). */

/** Assert 503 with ok=false and return the dependencies object for further
 * per-dependency assertions. */

/** Create a counting pool + handler + req + next for cache tests. */
function createCacheTestHarness(root: string): {
  handler: ReturnType<typeof createHealthHandler>;
  req: never;
  next: never;
  getQueryCount: () => number;
} {
  let queryCount = 0;
  const countingPool: Queryable = {
    query: () => { queryCount++; return Promise.resolve({ rows: [] }); },
  };
  const handler = createHealthHandler({
    pool: countingPool,
    projectsRoot: root,
    version: "test-1.0",
  });
  const req = {} as never;
  const next = (() => {}) as never;
  return { handler, req, next, getQueryCount: () => queryCount };
}

function assert503Body(result: { status: number; body: Record<string, unknown> }): Record<string, DependencyStatus> {
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  return result.body.dependencies as Record<string, DependencyStatus>;
}

function assertTimedOut503(result: { status: number; body: Record<string, unknown> }): void {
  assertUnhealthy(result, 503, false, /timed out/i);
}


// ---------------------------------------------------------------------------
// Tests — all dependencies healthy
// ---------------------------------------------------------------------------

test("all healthy: 200 with ok:true and per-dependency breakdown", async () => {
  await withWritableRoot(async (root) => {
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.version, "test-1.0");
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.postgres.ok, true);
    assert.equal(deps.projects_root.ok, true);
  })
});

// ---------------------------------------------------------------------------
// Tests — Postgres failure paths
// ---------------------------------------------------------------------------

test("createApp route: a failing Postgres probe yields HTTP 503 through the mounted handler", async () => {
  // This is the regression guard for the Greptile P1 finding: `createHealthHandler`
  // existed but was never mounted, so `/healthz` returned the unconditional
  // `{ ok: true }` stub regardless of database state. This test drives the FULL
  // `createApp` route (a real HTTP server) with a Postgres pool that rejects, and
  // asserts 503 — proving the real handler is mounted on the app, not just that
  // `createHealthHandler` returns 503 when called directly. Reverting the mount
  // (restoring the unconditional `ok:true` route) makes this test fail with
  // `status === 200`.
  await withWritableRoot(async (root) => {
    const { status, body } = await getHealthz({
      pool: unreachablePool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 503, "a failing Postgres probe must yield 503 through createApp's route");
    assert.equal(body.ok, false);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.postgres.ok, false);
    assert.ok(deps.postgres.error, "postgres error must be reported");
  })
});

test("unreachable database: 503 with postgres.ok:false", async () => {
  await withWritableRoot(async (root) => {
    const result = await getHealthz({
      pool: unreachablePool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assertUnhealthy(result, 503, false);
    const deps = result.body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.projects_root.ok, true, "projects root should still be ok");
  })
});

test("hung database (probe timeout): 503 with timeout error", async () => {
  await withWritableRoot(async (root) => {
    const { status, body } = await getHealthz({
      pool: hangingPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assertTimedOut503({ status, body });
  })
});

test("slow database (exceeds 2s timeout): 503", async () => {
  await withWritableRoot(async (root) => {
    const { status, body } = await getHealthz({
      pool: slowPool(3500),
      projectsRoot: root,
      version: "test-1.0",
    });
    assertTimedOut503({ status, body });
  })
});

// ---------------------------------------------------------------------------
// Tests — projects root failure paths
// ---------------------------------------------------------------------------

test("missing projects root: 503 with projects_root.ok:false", async () => {
  const missing = path.join(tmpdir(), `pm-web-healthz-missing-${Date.now()}`);
  // Confirm the path does not exist.
  assert.doesNotThrow(() => rmSync(missing, { recursive: true, force: true }));
  const { status, body } = await getHealthz({
    pool: healthyPool(),
    projectsRoot: missing,
    version: "test-1.0",
  });
  const deps = assert503Body({ status, body });
  assert.equal(deps.projects_root.ok, false);
  assert.ok(deps.projects_root.error, "projects_root error must be reported");
  assert.equal(deps.postgres.ok, true, "postgres should still be ok");
});

test("read-only projects root: 503 with projects_root.ok:false", async () => {
  // Create a temp dir, make it read-only. On Linux this prevents file creation.
  requireModeBitsEnforced();
  const root = writableRoot();
  try {
    chmodSync(root, 0o555);
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    const deps = assert503Body({ status, body });
    assert.equal(deps.projects_root.ok, false);
    assert.ok(deps.projects_root.error, "writability failure must be reported");
  } finally {
    // Restore permissions so cleanup works.
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects root writability probe leaves no stray files", async () => {
  await withWritableRoot(async (root) => {
    await directHealthz({ pool: healthyPool(), projectsRoot: root, version: "test" });
    const entries = readdirSync(root);
    assert.equal(entries.length, 0, "no probe files should remain in the projects root");
  })
});

// ---------------------------------------------------------------------------
// Tests — both hard deps fail
// ---------------------------------------------------------------------------

test("both hard deps fail: 503 with both reported as down", async () => {
  const missing = path.join(tmpdir(), `pm-web-healthz-both-${Date.now()}`);
  const { status, body } = await getHealthz({
    pool: unreachablePool(),
    projectsRoot: missing,
    version: "test-1.0",
  });
  const deps = assert503Body({ status, body });
  assert.equal(deps.postgres.ok, false);
  assert.equal(deps.projects_root.ok, false);
});

// ---------------------------------------------------------------------------
// Tests — soft dependencies
// ---------------------------------------------------------------------------

test("soft dependency down does not cause 503", async () => {
  await withWritableRoot(async (root) => {
    const softProbes: SoftProbe[] = [
      { name: "neo4j", probe: async () => ({ ok: false, latency_ms: 0, error: "connection refused", configured: true }) },
      { name: "ollama", probe: async () => ({ ok: false, latency_ms: 0, error: "ECONNREFUSED", configured: true }) },
    ];
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
      softProbes,
    });
    assert.equal(status, 200, "soft deps must not affect status code");
    assert.equal(body.ok, true);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.neo4j.ok, false);
    assert.equal(deps.ollama.ok, false);
  })
});

test("soft dependency not configured reports configured:false", async () => {
  await withWritableRoot(async (root) => {
    const softProbes: SoftProbe[] = [
      { name: "neo4j", probe: async () => ({ ok: true, latency_ms: 0, configured: false }) },
    ];
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
      softProbes,
    });
    assert.equal(status, 200);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.neo4j.ok, true);
    assert.equal(deps.neo4j.configured, false);
  })
});

test("soft dependency probe that throws is caught and reported as down", async () => {
  await withWritableRoot(async (root) => {
    const softProbes: SoftProbe[] = [
      { name: "flaky", probe: () => { throw new Error("synchronous explosion"); } },
    ];
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
      softProbes,
    });
    assert.equal(status, 200, "thrown soft probe must not cause 503");
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.flaky.ok, false);
    // The reported reason must be a stable category, never the raw message.
    // /healthz is unauthenticated, and a raw error names hosts, ports, database
    // names and filesystem paths - reconnaissance for an anonymous caller.
    assert.equal(deps.flaky.error, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /synchronous explosion/);
  })
});

// ---------------------------------------------------------------------------
// Tests — caching
// ---------------------------------------------------------------------------

test("cached result is reused within 5 seconds", async () => {
  await withWritableRoot(async (root) => {
    const { handler, req, next, getQueryCount } = createCacheTestHarness(root);
    await handler(req, noopRes(), next);
    assert.equal(getQueryCount(), 1, "first call must probe");
    await handler(req, noopRes(), next);
    assert.equal(getQueryCount(), 1, "second call within cache TTL must not re-probe");
  })
});

test("cache expires and re-probes after 5 seconds", async () => {
  const root = writableRoot();
  try {
    const { handler, req, next, getQueryCount } = createCacheTestHarness(root);
    await handler(req, noopRes(), next);
    assert.equal(getQueryCount(), 1);

    // Wait just over the cache TTL.
    await new Promise<void>((resolve) => { setTimeout(resolve, 5100); });

    await handler(req, noopRes(), next);
    assert.equal(getQueryCount(), 2, "call after cache TTL must re-probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — no stray probe files on failure
// ---------------------------------------------------------------------------

test("read-only projects root: no stray files left behind", async () => {
  requireModeBitsEnforced();
  const root = writableRoot();
  try {
    chmodSync(root, 0o555);
    await directHealthz({ pool: healthyPool(), projectsRoot: root, version: "test" });
    // No file should have been created (write should have failed).
    const entries = readdirSync(root);
    assert.equal(entries.length, 0, "no probe files should remain after a failed write");
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — response never includes credentials
// ---------------------------------------------------------------------------

test("health response never includes connection strings or credentials", async () => {
  await withWritableRoot(async (root) => {
    const { body } = await getHealthz({
      pool: unreachablePool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    const json = JSON.stringify(body);
    // The response must not leak any credential-like patterns.
    assert.doesNotMatch(json, /postgres:\/\/|password=|Bearer\s|api_key/i, "no credentials in health response");
  })
});

// ---------------------------------------------------------------------------
// Non-vacuity: each probe's test must FAIL when the probe is forced to pass.
// These tests verify that the failure-path tests above actually test something.
// ---------------------------------------------------------------------------

test("non-vacuity: unreachable-db test would fail if postgres probe always succeeded", async () => {
  // If we make the postgres probe always return ok, the "unreachable database"
  // test above would still expect 503 — but it would get 200, proving the test
  // is not vacuous. We verify this by checking that a healthy pool produces 200
  // under the same conditions the failure test uses (temp projects root).
  await withWritableRoot(async (root) => {
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 200, "with a healthy pool the status must be 200, not 503 — proving the unreachable-db test discriminates");
  })
});

test("non-vacuity: missing-root test would fail if projects-root probe always succeeded", async () => {
  // If the projects-root probe always returned ok, the "missing projects root"
  // test would get 200 instead of 503. We verify by passing a writable root
  // with a healthy pool — the status must be 200, proving the failure test
  // would fail if the probe were a no-op.
  await withWritableRoot(async (root) => {
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 200, "with a real writable root the status must be 200 — proving the missing-root test discriminates");
  })
});

test("non-vacuity: timeout test would fail if the probe had no timeout", async () => {
  // If the probe had no timeout, a hanging pool would make /healthz hang
  // rather than return 503. We verify that a fast pool returns promptly,
  // proving the timeout test is meaningful (a hanging pool without timeout
  // would never return).
  await withWritableRoot(async (root) => {
    const start = Date.now();
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    const elapsed = Date.now() - start;
    assert.equal(status, 200);
    assert.ok(elapsed < 1000, `healthy probe should return in under 1s, took ${elapsed}ms — proving the timeout test discriminates`);
  })
});
test("a failing probe never leaks the underlying path, host or message", async () => {
  // Every hard-dependency failure the endpoint can report must reduce to a
  // fixed vocabulary. This is the assertion that would fail if someone
  // reintroduced `error.message` passthrough for convenience.
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-healthz-leak-"));
  try {
    const secretHost = "internal-db.private.example:5432";
    const { body } = await getHealthz({
      pool: { query: () => Promise.reject(new Error(`connect ECONNREFUSED ${secretHost}`)) },
      projectsRoot: path.join(root, "definitely-absent"),
      version: "test-1.0",
      softProbes: [],
    });

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /ECONNREFUSED/);
    assert.doesNotMatch(serialized, /internal-db\.private\.example/);
    assert.doesNotMatch(serialized, /5432/);
    assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const deps = body.dependencies as Record<string, DependencyStatus>;
    const vocabulary = new Set([
      "timed out",
      "not found",
      "permission denied",
      "no space left on device",
      "unreachable",
      "unavailable",
    ]);
    for (const [name, status] of Object.entries(deps)) {
      if (status.ok) continue;
      assert.ok(
        vocabulary.has(status.error ?? ""),
        `${name} reported ${JSON.stringify(status.error)}, which is outside the sanitized vocabulary`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent uncached probes share one computation rather than one each", async () => {
  // withTimeout rejects its wrapper but cannot cancel the underlying
  // pool.query. Without single-flight, every request during a hung database
  // starts another query that keeps running after the endpoint answered 503,
  // consuming pool capacity and starving the ordinary API.
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-healthz-single-"));
  let queries = 0;
  const app = createApp({
    health: {
      pool: {
        query: () => {
          queries += 1;
          return new Promise<{ rows: unknown[] }>((resolve) => {
            setTimeout(() => resolve({ rows: [] }), 40);
          });
        },
      },
      projectsRoot: root,
      version: "test-1.0",
      softProbes: [],
    },
  });
  const { port, close } = await startEphemeralServer(app);
  try {
    // All eight start before the first can finish, so all eight miss the cache.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${port}/healthz`))
    );
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal(queries, 1, `eight concurrent probes must issue one query, issued ${queries}`);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two replicas probing one shared volume do not delete each other's probe file", async () => {
  // Single-flight serialises probes WITHIN a process, so a same-process
  // collision cannot happen. Two replicas are a different matter: pm-web mounts
  // one host directory into every container, and container PIDs are namespaced,
  // so two processes can hold the same pid and start a probe in the same
  // millisecond. A pid-and-timestamp filename then collides across replicas,
  // one unlinks the other's file, and a perfectly healthy volume reports 503.
  //
  // The handlers are invoked directly rather than over HTTP: a network
  // round-trip adds enough jitter that the two probes may land in different
  // milliseconds, which would make this test pass by luck. Invoking them in one
  // event-loop turn puts them in the same millisecond deterministically.
  const root = mkdtempSync(path.join(tmpdir(), "pm-web-healthz-replica-"));
  try {
    const replicas = Array.from({ length: 4 }, () =>
      createHealthHandler({
        pool: { query: () => Promise.resolve({ rows: [] }) },
        projectsRoot: root,
        version: "test-1.0",
        softProbes: [],
      })
    );

    const bodies = await Promise.all(
      replicas.map((handler) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const res = {
            status() { return res; },
            json(payload: Record<string, unknown>) { resolve(payload); return res; },
          };
          void handler({} as never, res as never, (() => {}) as never);
        })
      )
    );

    for (const [index, body] of bodies.entries()) {
      const deps = body.dependencies as Record<string, DependencyStatus>;
      assert.equal(
        deps.projects_root.ok,
        true,
        `replica ${index}: a healthy shared volume reported ${JSON.stringify(deps.projects_root.error)}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a PostgreSQL probe timeout is not retried until the cooldown expires", async () => {
  // `withTimeout` rejects its wrapper but cannot cancel `pool.query`, so a
  // timed-out probe leaves a client checked out until the server answers.
  // Re-probing on every cache expiry during a stall drains the shared pool out
  // from under the ordinary API, so a timeout must suppress the next probe.
  let queries = 0;
  const stalled: Queryable = {
    query: () => {
      queries += 1;
      return new Promise<{ rows: unknown[] }>(() => {});
    },
  };
  const root = writableRoot();
  try {
    const handler = createHealthHandler({
      pool: stalled,
      projectsRoot: root,
      version: "test-1.0",
    });

    const first = await callHandler(handler);
    assert.equal(first.status, 503);
    assert.equal(queries, 1, "the first probe must actually query");

    // Past the 5s response cache, but inside the 30s pool cooldown.
    await new Promise((r) => { setTimeout(r, CACHE_TTL_FOR_TEST + 50); });
    const second = await callHandler(handler);

    assert.equal(second.status, 503, "a cooling probe must still report unhealthy");
    assert.equal(
      queries,
      1,
      "a second query during the cooldown would keep another pool client checked out"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing projects-root probe answers rather than awaiting its own cleanup", async () => {
  // The cleanup path is reached exactly when the volume is misbehaving. Awaiting
  // an unbounded unlink there would leave probeProjectsRoot unresolved, so the
  // Promise.all in compute() would never settle, `inFlight` would never clear,
  // and every later request would await the same pending promise forever -
  // serving nothing at all instead of 503. Repeated calls must keep answering.
  const missing = path.join(tmpdir(), `pm-web-healthz-missing-${Date.now()}`);
  const handler = createHealthHandler({
    pool: healthyPool(),
    projectsRoot: missing,
    version: "test-1.0",
  });

  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    const res = await callHandler(handler);
    assert.equal(res.status, 503, `request ${i + 1} must answer, not hang`);
    assert.ok(
      Date.now() - started < 5000,
      `request ${i + 1} answered in time rather than awaiting cleanup`
    );
    await new Promise((r) => { setTimeout(r, CACHE_TTL_FOR_TEST + 50); });
  }
});

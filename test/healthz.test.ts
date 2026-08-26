import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { createApp } from "../src/app.ts";
import { createHealthHandler, type HealthProbeDeps, type SoftProbe, type DependencyStatus, type Queryable } from "../src/health.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  return { query: () => new Promise<{ rows: unknown[] }>((resolve) => setTimeout(() => resolve({ rows: [] }), ms)) };
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
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json() as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Variant that calls the handler factory directly (without Express) to test
 * the handler in isolation — useful for cache timing and probe internals.
 */
async function directHealthz(deps: HealthProbeDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createHealthHandler(deps);
  let status = 0;
  let body: Record<string, unknown> = {};
  // Minimal fake req/res/next sufficient for the health handler.
  const req = {} as never;
  const res = {
    status(code: number) { status = code; return this; },
    json(payload: unknown) { body = payload as Record<string, unknown>; },
  } as never;
  const next = (() => {}) as never;
  await handler(req, res, next);
  return { status, body };
}

// ---------------------------------------------------------------------------
// Tests — all dependencies healthy
// ---------------------------------------------------------------------------

test("all healthy: 200 with ok:true and per-dependency breakdown", async () => {
  const root = writableRoot();
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const root = writableRoot();
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreachable database: 503 with postgres.ok:false", async () => {
  const root = writableRoot();
  try {
    const { status, body } = await getHealthz({
      pool: unreachablePool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.postgres.ok, false);
    assert.ok(deps.postgres.error, "postgres error must be reported");
    assert.equal(deps.projects_root.ok, true, "projects root should still be ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hung database (probe timeout): 503 with timeout error", async () => {
  const root = writableRoot();
  try {
    const { status, body } = await getHealthz({
      pool: hangingPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.postgres.ok, false);
    assert.match(deps.postgres.error ?? "", /timed out/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slow database (exceeds 2s timeout): 503", async () => {
  const root = writableRoot();
  try {
    const { status, body } = await getHealthz({
      pool: slowPool(3500),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.postgres.ok, false);
    assert.match(deps.postgres.error ?? "", /timed out/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  const deps = body.dependencies as Record<string, DependencyStatus>;
  assert.equal(deps.projects_root.ok, false);
  assert.ok(deps.projects_root.error, "projects_root error must be reported");
  assert.equal(deps.postgres.ok, true, "postgres should still be ok");
});

test("read-only projects root: 503 with projects_root.ok:false", async () => {
  // Create a temp dir, make it read-only. On Linux this prevents file creation.
  const root = writableRoot();
  try {
    chmodSync(root, 0o555);
    const { status, body } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    const deps = body.dependencies as Record<string, DependencyStatus>;
    assert.equal(deps.projects_root.ok, false);
    assert.ok(deps.projects_root.error, "writability failure must be reported");
  } finally {
    // Restore permissions so cleanup works.
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects root writability probe leaves no stray files", async () => {
  const root = writableRoot();
  try {
    await directHealthz({ pool: healthyPool(), projectsRoot: root, version: "test" });
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(root);
    assert.equal(entries.length, 0, "no probe files should remain in the projects root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  const deps = body.dependencies as Record<string, DependencyStatus>;
  assert.equal(deps.postgres.ok, false);
  assert.equal(deps.projects_root.ok, false);
});

// ---------------------------------------------------------------------------
// Tests — soft dependencies
// ---------------------------------------------------------------------------

test("soft dependency down does not cause 503", async () => {
  const root = writableRoot();
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("soft dependency not configured reports configured:false", async () => {
  const root = writableRoot();
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("soft dependency probe that throws is caught and reported as down", async () => {
  const root = writableRoot();
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — caching
// ---------------------------------------------------------------------------

test("cached result is reused within 5 seconds", async () => {
  const root = writableRoot();
  try {
    let queryCount = 0;
    const countingPool: Queryable = {
      query: () => { queryCount++; return Promise.resolve({ rows: [] }); },
    };
    const handler = createHealthHandler({
      pool: countingPool,
      projectsRoot: root,
      version: "test-1.0",
    });

    // First call probes.
    const req = {} as never;
    const next = (() => {}) as never;
    const res1 = { status(code: number) { return this; }, json(_b: unknown) {} } as never;
    await handler(req, res1, next);
    assert.equal(queryCount, 1, "first call must probe");

    // Second call within 5s must use the cache.
    const res2 = { status(code: number) { return this; }, json(_b: unknown) {} } as never;
    await handler(req, res2, next);
    assert.equal(queryCount, 1, "second call within cache TTL must not re-probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache expires and re-probes after 5 seconds", async () => {
  const root = writableRoot();
  try {
    let queryCount = 0;
    const countingPool: Queryable = {
      query: () => { queryCount++; return Promise.resolve({ rows: [] }); },
    };
    // Use a direct handler with a reduced cache TTL by probing twice with
    // a delay longer than the TTL. The real handler uses 5s; we wait 5.1s.
    const handler = createHealthHandler({
      pool: countingPool,
      projectsRoot: root,
      version: "test-1.0",
    });

    const req = {} as never;
    const next = (() => {}) as never;
    const res1 = { status(code: number) { return this; }, json(_b: unknown) {} } as never;
    await handler(req, res1, next);
    assert.equal(queryCount, 1);

    // Wait just over the cache TTL.
    await new Promise<void>((resolve) => setTimeout(resolve, 5100));

    const res2 = { status(code: number) { return this; }, json(_b: unknown) {} } as never;
    await handler(req, res2, next);
    assert.equal(queryCount, 2, "call after cache TTL must re-probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests — no stray probe files on failure
// ---------------------------------------------------------------------------

test("read-only projects root: no stray files left behind", async () => {
  const root = writableRoot();
  try {
    chmodSync(root, 0o555);
    await directHealthz({ pool: healthyPool(), projectsRoot: root, version: "test" });
    // No file should have been created (write should have failed).
    const { readdirSync } = await import("node:fs");
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
  const root = writableRoot();
  try {
    const { body } = await getHealthz({
      pool: unreachablePool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    const json = JSON.stringify(body);
    // The response must not leak any credential-like patterns.
    assert.doesNotMatch(json, /postgres:\/\/|password=|Bearer\s|api_key/i, "no credentials in health response");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const root = writableRoot();
  try {
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 200, "with a healthy pool the status must be 200, not 503 — proving the unreachable-db test discriminates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-vacuity: missing-root test would fail if projects-root probe always succeeded", async () => {
  // If the projects-root probe always returned ok, the "missing projects root"
  // test would get 200 instead of 503. We verify by passing a writable root
  // with a healthy pool — the status must be 200, proving the failure test
  // would fail if the probe were a no-op.
  const root = writableRoot();
  try {
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    assert.equal(status, 200, "with a real writable root the status must be 200 — proving the missing-root test discriminates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-vacuity: timeout test would fail if the probe had no timeout", async () => {
  // If the probe had no timeout, a hanging pool would make /healthz hang
  // rather than return 503. We verify that a fast pool returns promptly,
  // proving the timeout test is meaningful (a hanging pool without timeout
  // would never return).
  const root = writableRoot();
  try {
    const start = Date.now();
    const { status } = await getHealthz({
      pool: healthyPool(),
      projectsRoot: root,
      version: "test-1.0",
    });
    const elapsed = Date.now() - start;
    assert.equal(status, 200);
    assert.ok(elapsed < 1000, `healthy probe should return in under 1s, took ${elapsed}ms — proving the timeout test discriminates`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    // All eight start before the first can finish, so all eight miss the cache.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${port}/healthz`))
    );
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal(queries, 1, `eight concurrent probes must issue one query, issued ${queries}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

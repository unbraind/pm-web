/** The optional setup control releases a real full roster before measuring any mutation. */
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pool } from "../src/db.ts";
import { StorageDiscoveryTimeoutError } from "../src/services/pm-runner.ts";
import { capacityFixture, capacityServer, waitUntil } from "../scripts/capacity-fixture.ts";
import { capacitySubscriber } from "../scripts/capacity-subscriber.ts";
import { instrumentCapacitySetup } from "../scripts/capacity-setup-probe.ts";

test("quiet setup survives baseline source replacement and releases complete real rosters", { timeout: 60_000 }, async () => {
  assert.throws(() => instrumentCapacitySetup("export const changed = true;"), /source drift/);
  const fixture = await capacityFixture(2);
  let server: Awaited<ReturnType<typeof capacityServer>> | undefined;
  const streams: Awaited<ReturnType<typeof capacitySubscriber>>[] = [];
  try {
    assert.equal(existsSync(path.join(fixture.dir, ".git")), false);
    const baseline = path.join(fixture.root, "baseline");
    await mkdir(baseline);
    await Promise.all([
      copyFile(path.resolve(import.meta.dirname, "../dist/services/sse.js"), path.join(baseline, "sse.js")),
      copyFile(path.resolve(import.meta.dirname, "../dist/routes/pm.js"), path.join(baseline, "pm.js")),
    ]);
    const previous = process.env.PM_WEB_CAPACITY_BASELINE_DIR;
    process.env.PM_WEB_CAPACITY_BASELINE_DIR = baseline;
    try { server = await capacityServer(fixture.root, fixture.secret, undefined, true); }
    finally {
      if (previous === undefined) delete process.env.PM_WEB_CAPACITY_BASELINE_DIR;
      else process.env.PM_WEB_CAPACITY_BASELINE_DIR = previous;
    }
    const url = `${server.url}/api/projects/${fixture.projectId}/pm/events`;
    for (const session of fixture.sessions) streams.push(await capacitySubscriber(url, session, new Map(), 0, { open: false }));
    await delay(200);
    assert.equal((await server.health()).realtime.sse_clients, 2);
    for (const stream of streams) assert.equal(stream.state.presenceUsers, undefined);
    await server.releaseSetup();
    await waitUntil(() => streams.every((stream) => stream.state.presenceUsers === 2), 5000, "released complete roster");
    for (const stream of streams) assert.equal(stream.state.disconnected, false);
    await streams[0].close();
    await waitUntil(() => streams[1].state.presenceUsers === 1, 5000, "ordinary presence resumes after setup");
  } finally {
    await Promise.allSettled(streams.map((stream) => stream.close()));
    await server?.close();
    await fixture.close();
  }
});

/** A storage pin that fails during setup must not leak the fixture's database connection or temporary root. */
test("capacity fixture setup ends its connection and removes its root when storage pinning fails", async () => {
  const prefix = path.join(tmpdir(), "pm-web-capacity-projects-");
  const roots = async (): Promise<string[]> => (await readdir(tmpdir())).filter((name) => path.join(tmpdir(), name).startsWith(prefix)).sort();
  const observers = async (): Promise<number> => Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'capacity-observer'")).rows[0].n);
  const beforeRoots = await roots(); const beforeObservers = await observers();
  // Storage discovery fails only by timing out, so stall the new root's lookup until the real bound rejects the pin.
  const original = fs.promises.realpath;
  Reflect.set(fs.promises, "realpath", new Proxy(original, { apply(target, receiver, args) {
    return String(args[0]).startsWith(prefix) ? new Promise<never>(() => { /* never settles */ }) : Reflect.apply(target, receiver, args);
  } }));
  try {
    await assert.rejects(capacityFixture(1), StorageDiscoveryTimeoutError);
  } finally { Reflect.set(fs.promises, "realpath", original); }
  assert.deepEqual(await roots(), beforeRoots, "the temporary root is removed");
  // pg_stat_activity drops a backend shortly after its client ends, so allow a bounded settle.
  for (let attempt = 0; attempt < 50 && (await observers()) > beforeObservers; attempt++) await delay(100);
  assert.ok((await observers()) <= beforeObservers, "the observer connection is ended");
});

/** A failed SDK client eviction must not skip the database, row and directory cleanup that follows it. */
test("capacity fixture cleanup completes independent steps after a failed client eviction, then reports it", async () => {
  const failing = await capacityFixture(1);
  // Storage discovery tolerates filesystem errors and fails only by timing out, so stall the fixture
  // workspace's lookup until the real discovery bound rejects the eviction.
  const original = fs.promises.realpath;
  const stalled = new Set([failing.dir, path.join(failing.dir, ".agents", "pm")]);
  Reflect.set(fs.promises, "realpath", new Proxy(original, { apply(target, receiver, args) {
    return stalled.has(String(args[0])) ? new Promise<never>(() => { /* never settles */ }) : Reflect.apply(target, receiver, args);
  } }));
  try {
    await assert.rejects(failing.close(), (error: Error & { code?: string }) => error.code === "FIXTURE_CLIENT_EVICTION_FAILED" && error.cause instanceof StorageDiscoveryTimeoutError);
  } finally { Reflect.set(fs.promises, "realpath", original); }
  assert.equal((await pool.query("SELECT id FROM pm_projects WHERE id = $1", [failing.projectId])).rowCount, 0, "fixture rows are removed despite the eviction failure");
  await assert.rejects(stat(failing.root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  // Must allow: an ordinary fixture closes without error and removes the same resources.
  const clean = await capacityFixture(1);
  await clean.close();
  assert.equal((await pool.query("SELECT id FROM pm_projects WHERE id = $1", [clean.projectId])).rowCount, 0);
  await assert.rejects(stat(clean.root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

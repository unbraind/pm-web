/** Real production sockets prove coalescing and bounded fan-out without git or setup interception. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { capacityFixture, capacityServer } from "../scripts/capacity-fixture.ts";
import { capacitySubscriber } from "../scripts/capacity-subscriber.ts";
import { createCapacityClients } from "../scripts/capacity-clients.ts";

test("ordinary real-process joins coalesce rosters and yield bounded authorized batches without git", { timeout: 60_000 }, async () => {
  const fixture = await capacityFixture(128);
  let server: Awaited<ReturnType<typeof capacityServer>> | undefined;
  let first: Awaited<ReturnType<typeof capacitySubscriber>> | undefined;
  let clients: ReturnType<typeof createCapacityClients> | undefined;
  try {
    assert.equal(existsSync(path.join(fixture.dir, ".git")), false);
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try { server = await capacityServer(fixture.root, fixture.secret); }
    finally { process.env.PATH = previousPath; }
    const url = `${server.url}/api/projects/${fixture.projectId}/pm/events`;
    first = await capacitySubscriber(url, fixture.sessions[0], new Map(), 0, { open: false });
    await delay(200);
    assert.equal(first.state.presenceUsers, undefined, "joins must coalesce rather than submit an incremental full roster immediately");
    clients = createCapacityClients({ url, sessions: fixture.sessions.slice(1), indices: [], writes: 0, population: 128, concurrency: 16, manualJoin: true });
    await clients.ready;
    while (clients.opened() < 127) await clients.join();
    await clients.presence();
    const states = await clients.snapshot();
    assert.equal(states.length, 127);
    assert.ok(states.every((state) => state.presenceUsers === 128 && !state.disconnected));
    assert.equal(first.state.presenceUsers, 128);
    assert.equal((await server.health()).ok, true);
    await server.sample();
    assert.ok(server.samples.at(-1)!.fanout.max_synchronous_writes <= 32, "socket fan-out must yield after a bounded slice");
    assert.ok(server.samples.at(-1)!.fanout.max_synchronous_writes > 0, "the process probe must observe actual roster writes");
  } finally {
    await clients?.close();
    await first?.close();
    await server?.close();
    await fixture.close();
  }
});

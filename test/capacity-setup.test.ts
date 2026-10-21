/** The optional setup control releases a real full roster before measuring any mutation. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
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

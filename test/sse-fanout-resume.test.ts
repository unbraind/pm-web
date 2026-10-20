/** A real non-git tracker keeps detecting CLI commits while its last network viewer reconnects. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { capacityFixture, capacityPm, capacityServer, waitUntil } from "../scripts/capacity-fixture.ts";
import { capacitySubscriber } from "../scripts/capacity.ts";

test("forced last-viewer disconnect replays exactly the missed independent CLI commits", { timeout: 60_000 }, async () => {
  const fixture = await capacityFixture(1);
  let server: Awaited<ReturnType<typeof capacityServer>> | undefined;
  let first: Awaited<ReturnType<typeof capacitySubscriber>> | undefined;
  let resumed: Awaited<ReturnType<typeof capacitySubscriber>> | undefined;
  try {
    assert.equal(existsSync(path.join(fixture.dir, ".git")), false);
    const indices = new Map(Array.from({ length: 4 }, (_, i) => [`capacity-write-${i}`, i]));
    for (const itemId of indices.keys()) await fixture.client.run("create", { options: { id: itemId, title: "Synthetic resume item", type: "Task", description: "Synthetic resume fixture" } });
    server = await capacityServer(fixture.root, fixture.secret);
    const url = `${server.url}/api/projects/${fixture.projectId}/pm/events`;
    first = await capacitySubscriber(url, fixture.sessions[0], indices, 4, { open: true });
    const deadline = performance.now() + 20_000;
    while ((await server.health()).realtime.watcher_last_sweep_at === null) {
      assert.ok(performance.now() < deadline, "production detection must establish its baseline");
      await delay(50);
    }
    await capacityPm(fixture.dir, ["update", "capacity-write-0", "--title", "Before disconnect"]);
    await waitUntil(() => first!.state.counts[0] === 1, 5000, "initial network receipt");
    const cursor = first.state.lastEventId;
    assert.ok(cursor, "a complete received frame must carry a resume cursor");
    await first.close();
    first = undefined;
    const goneDeadline = performance.now() + 5000;
    while ((await server.health()).realtime.sse_clients !== 0) {
      assert.ok(performance.now() < goneDeadline, "the last viewer must actually disconnect");
      await delay(20);
    }
    for (const index of [1, 2, 3]) await capacityPm(fixture.dir, ["update", `capacity-write-${index}`, "--title", `Offline commit ${index}`]);
    resumed = await capacitySubscriber(url, { ...fixture.sessions[0], "Last-Event-ID": cursor }, indices, 4, { open: true });
    await waitUntil(() => [1, 2, 3].every((index) => resumed!.state.counts[index] === 1), 5000, "missed committed network receipts");
    await delay(500);
    assert.deepEqual([...resumed.state.counts], [0, 1, 1, 1], "no old commit repeats and every missed commit arrives once");
    assert.equal(resumed.state.disconnected, false);
  } finally {
    await first?.close();
    await resumed?.close();
    await server?.close();
    await fixture.close();
  }
});

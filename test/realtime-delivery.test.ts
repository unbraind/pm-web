/** Real committed identities exercise both sides of the route/watcher race at the shared delivery sink. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Response } from "express";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { capacityPm } from "../scripts/capacity-fixture.ts";
import { getPmClient, evictPmClient } from "../src/services/pm-runner.ts";
import { addSSEClient, broadcastProjectEvent, consumeSignaledItemMutation, deliverProjectEvent, mutationEventIdentity } from "../src/services/sse.ts";
import { buildEnvelope, handleIncomingEnvelope } from "../src/services/realtime-bus.ts";

test("20 subscribers receive each real same-item version once in watcher-first, route-first and peer-first order", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-delivery-receipts-"));
  const pmRoot = path.join(dir, ".agents/pm");
  const stops: (() => void)[] = [];
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "receipts", "--defaults", "--agent-guidance", "skip"]);
    const client = getPmClient(pmRoot);
    await client.run("create", { options: { id: "receipts-one", title: "Synthetic", type: "Task", description: "Synthetic" } });
    for (const title of ["First", "Second"]) await client.run("update", { options: { id: "receipts-one", title } });
    const page = await listMutationEvents({ pmRoot, item: "receipts-one", type: "update" });
    assert.equal(page.events.length, 2);
    assert.notEqual(mutationEventIdentity(page.events[0]), mutationEventIdentity(page.events[1]));
    for (const order of ["watcher-first", "route-first", "peer-first"]) {
      const projectId = randomUUID();
      const frames = Array.from({ length: 20 }, () => [] as string[]);
      for (const [index, received] of frames.entries()) {
        stops.push(addSSEClient({ id: randomUUID(), projectId, userId: `synthetic-${index}`, displayName: "Synthetic", currentView: "items", connectedAt: new Date(),
          res: { write: (payload: string) => { received.push(payload); return true; } } as unknown as Response }));
      }
      for (const fact of page.events) {
        const id = mutationEventIdentity(fact);
        const data = { itemId: fact.item_id, version: fact.version };
        const route = { id, type: "item-updated", data };
        const watcher = { id, type: "workspace-changed", data: { ...data, source: "mutation-events" } };
        /** Exercise the real envelope parser and peer sink, including identity transport. */
        const peer = (): void => handleIncomingEnvelope(buildEnvelope(projectId, route, "synthetic-peer")!, "local", deliverProjectEvent);
        if (order === "watcher-first") { deliverProjectEvent(projectId, watcher); broadcastProjectEvent(projectId, route); peer(); }
        else if (order === "route-first") { broadcastProjectEvent(projectId, route); peer(); deliverProjectEvent(projectId, watcher); }
        else { peer(); deliverProjectEvent(projectId, watcher); broadcastProjectEvent(projectId, route); }
        // A receipt for one version must never suppress another version of the same item.
        assert.equal(consumeSignaledItemMutation(projectId, fact.item_id, `${id}-distinct`), false);
      }
      for (const received of frames) {
        const mutations = received.filter((frame) => /event: (item-updated|workspace-changed)/.test(frame));
        assert.equal(mutations.length, 2, `${order}: each committed version must reach each subscriber once`);
        for (const fact of page.events) assert.equal(mutations.filter((frame) => frame.includes(`"version":${fact.version}`)).length, 1);
      }
    }
  } finally {
    stops.forEach((stop) => stop());
    evictPmClient(pmRoot);
    await rm(dir, { recursive: true, force: true });
  }
});

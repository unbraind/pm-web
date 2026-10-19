/** Real committed identities exercise both sides of the route/watcher race at the shared delivery sink. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Response } from "express";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { capacityPm, waitUntil } from "../scripts/capacity-fixture.ts";
import { getPmClient, evictPmClient } from "../src/services/pm-runner.ts";
import { addSSEClient, broadcastProjectEvent, consumeSignaledItemMutation, deliverProjectEvent, mutationEventIdentity, type SSEEvent } from "../src/services/sse.ts";
import { createMutationEventReconciler } from "../src/services/mutation-event-watcher.ts";
import { buildEnvelope, handleIncomingEnvelope } from "../src/services/realtime-bus.ts";

/** Exercise all transports with one common committed identity and a chosen arrival order. */
function deliverRace(projectId: string, order: string, route: SSEEvent, watcher: SSEEvent): void {
  /** Use the real peer parser so transport identity is verified as well as the local receipt. */
  const peer = (): void => handleIncomingEnvelope(buildEnvelope(projectId, route, "synthetic-peer")!, "local", deliverProjectEvent);
  const transports = { watcher: () => deliverProjectEvent(projectId, watcher), route: () => broadcastProjectEvent(projectId, route), peer };
  const sequence = order === "watcher-first" ? ["watcher", "route", "peer"] as const : order === "route-first" ? ["route", "peer", "watcher"] as const : ["peer", "watcher", "route"] as const;
  for (const transport of sequence) transports[transport]();
}

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
        deliverRace(projectId, order, route, watcher);
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

test("legacy plan and dependency signals consume one watcher identity and preserve exact-version priority", () => {
  for (const type of ["item-updated", "dependency-added", "dependency-removed"]) {
    const projectId = randomUUID();
    broadcastProjectEvent(projectId, { type, data: { itemId: "synthetic-plan" } });
    broadcastProjectEvent(projectId, { id: "exact-version", type: "item-updated", data: { itemId: "synthetic-plan" } });
    assert.equal(consumeSignaledItemMutation(projectId, "synthetic-plan", "exact-version"), true);
    assert.equal(consumeSignaledItemMutation(projectId, "other-item", "other-version"), false);
    assert.equal(consumeSignaledItemMutation(projectId, "synthetic-plan", "watcher-version"), true);
    assert.equal(consumeSignaledItemMutation(projectId, "synthetic-plan", "next-version"), false);
  }
});

test("real close and delete facts retain lifecycle types once in every delivery order", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-web-lifecycle-receipts-"));
  const pmRoot = path.join(dir, ".agents/pm");
  const stops: (() => void)[] = [];
  try {
    await capacityPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "lifecycle", "--defaults", "--agent-guidance", "skip"]);
    const client = getPmClient(pmRoot);
    for (const operation of ["close", "delete"]) {
      const created = await client.run("create", { options: { id: `lifecycle-${operation}`, title: "Synthetic", type: "Task", description: "Synthetic" } }) as { id: string };
      await client.run(operation, { options: { id: created.id, reason: "Synthetic completion", force: true } });
      const { events } = await listMutationEvents({ pmRoot, item: created.id, type: operation });
      assert.equal(events.length, 1);
      const fact = events[0];
      const expectedType = operation === "delete" ? "item-deleted" : "item-closed";
      for (const order of ["watcher-first", "route-first", "peer-first"]) {
        const projectId = randomUUID();
        const received: string[] = [];
        stops.push(addSSEClient({ id: randomUUID(), projectId, userId: "synthetic", displayName: "Synthetic", currentView: "items", connectedAt: new Date(),
          res: { write: (payload: string) => { received.push(payload); return true; } } as unknown as Response }));
        const observed: Parameters<typeof deliverProjectEvent>[1][] = [];
        const reconciler = createMutationEventReconciler({
          getActiveProjectIds: () => [projectId], resolveProjectDir: async () => dir,
          /** Follow the real committed fact through the production reconciler. */
          subscribe: async function* () { yield fact; },
          consumeSignaledItemMutation: () => false,
          emit: (_projectId, event) => { observed.push(event); },
        });
        try {
          await reconciler.reconcile();
          await waitUntil(() => observed.length === 1, 1000, "committed lifecycle fact");
        } finally { await reconciler.stopAll(); }
        const watcher = observed[0];
        const route = { id: mutationEventIdentity(fact), type: expectedType, data: { itemId: fact.item_id } };
        deliverRace(projectId, order, route, watcher);
        const mutations = received.filter((frame) => /event: (item-deleted|item-closed|workspace-changed)/.test(frame));
        assert.equal(mutations.length, 1, `${operation} ${order}: exactly one committed frame`);
        assert.ok(mutations[0].startsWith(`event: ${expectedType}\n`), `${operation} ${order}: lifecycle caption must survive`);
      }
    }
  } finally {
    stops.forEach((stop) => stop());
    evictPmClient(pmRoot);
    await rm(dir, { recursive: true, force: true });
  }
});

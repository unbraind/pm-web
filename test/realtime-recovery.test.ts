import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import express from "express";
import pg from "pg";
import { startRealtimeBus } from "../src/services/realtime-bus.ts";
import { addSSEClient, setupSSEHeaders } from "../src/services/sse.ts";

/** Wait for observable asynchronous delivery, failing within a bounded interval. */
async function waitUntil(ready: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!ready() && Date.now() < deadline) await delay(10);
  assert.ok(ready(), message);
}

test("real PostgreSQL reconnect refreshes open SSE projects and preserves subsequent isolation", { timeout: 15_000 }, async () => {
  const applicationName = `pm-web-reconnect-${randomUUID()}`;
  const database = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: applicationName });
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const projectIds = [randomUUID(), randomUUID()];
  const controllers = projectIds.map(() => new AbortController());
  const received = projectIds.map(() => "");
  const notifications: string[] = [];
  const streams: Promise<void>[] = [];
  const app = express();
  app.get("/:projectId", (req, res) => {
    setupSSEHeaders(res);
    const unsubscribe = addSSEClient({
      id: randomUUID(), projectId: req.params.projectId,
      userId: randomUUID(), displayName: "Synthetic recovery viewer", currentView: "items",
      res, connectedAt: new Date(),
    });
    req.on("close", unsubscribe);
  });
  const server = createServer(app);
  let stop: (() => Promise<void>) | undefined;
  try {
    await observer.connect();
    observer.on("notification", (message) => { if (message.payload) notifications.push(message.payload); });
    await observer.query("LISTEN pm_workspace_events");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    for (const [index, projectId] of projectIds.entries()) {
      const response = await fetch(`http://127.0.0.1:${address.port}/${projectId}`, { signal: controllers[index].signal });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body;
      streams.push((async () => {
        try {
          for await (const chunk of reader) received[index] += new TextDecoder().decode(chunk);
        } catch (error) {
          if (!controllers[index].signal.aborted) throw error;
        }
      })());
    }
    await waitUntil(() => received.every((body) => body.includes("event: connected")), "both real HTTP streams connect");
    stop = await startRealtimeBus(database);
    await observer.query("SELECT pg_notify($1, $2)", ["pm_workspace_events", JSON.stringify({
      projectId: projectIds[0], type: "item-updated", data: { itemId: "before-reconnect" }, sourceId: "external-writer",
    })]);
    await waitUntil(() => received[0].includes("before-reconnect"), "initial listener delivers remote mutations before disconnect");
    assert.ok(received.every((body) => !body.includes("event: workspace-changed")), "initial LISTEN does not announce a recovery");

    const listener = await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND query = 'LISTEN pm_workspace_events'",
      [applicationName],
    );
    assert.equal(listener.rows.length, 1, "only this test's uniquely named listener is terminated");
    await observer.query("SELECT pg_terminate_backend($1)", [listener.rows[0].pid]);
    await observer.query("SELECT pg_notify($1, $2)", ["pm_workspace_events", JSON.stringify({
      projectId: projectIds[0], type: "item-updated", data: { itemId: "lost-during-disconnect" }, sourceId: "external-writer",
    })]);
    await waitUntil(() => received.every((body) => body.includes('"source":"realtime-reconnect"')), "recovery refresh reaches both still-open project streams");
    assert.ok(received.every((body) => !body.includes("lost-during-disconnect")), "NOTIFY sent in the disconnected interval was actually lost");
    for (const body of received) assert.equal(body.match(/event: workspace-changed/g)?.length, 1, "one recovery refresh per active project");
    assert.ok(notifications.every((payload) => !payload.includes("realtime-reconnect")), "recovery stays local instead of echoing across replicas");

    await observer.query("SELECT pg_notify($1, $2)", ["pm_workspace_events", JSON.stringify({
      projectId: projectIds[0], type: "item-updated", data: { itemId: "after-reconnect" }, sourceId: "external-writer",
    })]);
    await waitUntil(() => received[0].includes("after-reconnect"), "new remote mutations reach the recovered listener");
    assert.ok(!received[1].includes("after-reconnect"), "another project's stream receives no item identifiers");
    await stop();
    stop = undefined;
    await observer.query("SELECT pg_notify($1, $2)", ["pm_workspace_events", JSON.stringify({
      projectId: projectIds[0], type: "item-updated", data: { itemId: "after-stop" }, sourceId: "external-writer",
    })]);
    await delay(50);
    assert.ok(received.every((body) => !body.includes("after-stop")), "stopping the bus removes its subscription");
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(streams);
    await stop?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await observer.end();
    await database.end();
  }
});

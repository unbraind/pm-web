/** Real SQL authorization and HTTP replay must reject forged and revoked private-project viewers. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { pool } from "../src/db.ts";
import { broadcastProjectEvent, closeAllSSEClients } from "../src/services/sse.ts";
import { projectEventViewers } from "../src/services/sse-access.ts";
import { addGroupMember, authedFetch, ensureSchema, seedGroup, seedGroupShare, seedProject, seedUser, seedUserShare, startApp } from "./helpers/pg-harness.ts";
import { connectLiveSSE } from "./helpers/live-sse.ts";

test("private frames and replay never reach strangers, cross-project cursor holders, or revoked direct/group viewers", async (t) => {
  await ensureSchema();
  const owner = await seedUser(), direct = await seedUser(), member = await seedUser(), stranger = await seedUser();
  const project = await seedProject(owner.id), other = await seedProject(stranger.id);
  const group = await seedGroup(owner.id);
  await addGroupMember(group.id, member.id);
  const share = await seedUserShare(project.id, direct.id, "view");
  await seedGroupShare(project.id, group.id, "view");
  t.after(async () => { closeAllSSEClients(); await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner.id, direct.id, member.id, stranger.id]]); });
  const server = await startApp();
  t.after(() => server.close());
  const ownerStream = await connectLiveSSE(server, owner, project.id);
  const directStream = await connectLiveSSE(server, direct, project.id);
  const groupStream = await connectLiveSSE(server, member, project.id);
  const otherStream = await connectLiveSSE(server, stranger, other.id);
  t.after(async () => { await Promise.all([ownerStream, directStream, groupStream, otherStream].map((stream) => stream.close().catch(() => {}))); });
  assert.deepEqual(await projectEventViewers(project.id), new Set([owner.id, direct.id, member.id]));
  broadcastProjectEvent(project.id, { id: "private-1", type: "item-updated", data: { itemId: "private-one" } });
  for (const stream of [ownerStream, directStream, groupStream]) await stream.waitFor((events) => events.some((event) => event.data.itemId === "private-one"));
  const cursor = directStream.events.find((event) => event.data.itemId === "private-one")!.id!;
  assert.ok(cursor);
  for (const [user, target] of [[stranger, project], [stranger, other]] as const) {
    const denied = await authedFetch(server, user, `/api/projects/${target.id}/pm/events`, { headers: { "Last-Event-ID": cursor } });
    assert.equal(denied.status, target === project ? 404 : 409);
    assert.equal((await denied.text()).includes("private-one"), false);
  }
  assert.equal(otherStream.events.some((event) => event.data.itemId === "private-one"), false);
  await directStream.close();
  for (const index of [2, 3, 4]) broadcastProjectEvent(project.id, { id: `private-${index}`, type: "item-updated", data: { itemId: `private-${index}` } });
  const resumed = await connectLiveSSE(server, direct, project.id, cursor);
  t.after(() => resumed.close().catch(() => {}));
  await resumed.waitFor((events) => events.filter((event) => event.type === "item-updated").length === 3);
  assert.deepEqual(resumed.events.filter((event) => event.type === "item-updated").map((event) => event.data.itemId), ["private-2", "private-3", "private-4"]);
  await pool.query("DELETE FROM pm_project_shares WHERE id = $1", [share]);
  await pool.query("DELETE FROM pm_group_members WHERE group_id = $1 AND user_id = $2", [group.id, member.id]);
  broadcastProjectEvent(project.id, { id: "private-revoked", type: "item-updated", data: { itemId: "never-to-revoked" } });
  await ownerStream.waitFor((events) => events.some((event) => event.data.itemId === "never-to-revoked"));
  await delay(20);
  for (const stream of [resumed, groupStream, otherStream]) assert.equal(stream.events.some((event) => event.data.itemId === "never-to-revoked"), false);
  const revoked = await authedFetch(server, direct, `/api/projects/${project.id}/pm/events`, { headers: { "Last-Event-ID": cursor } });
  assert.equal(revoked.status, 404);
  await revoked.text();
});

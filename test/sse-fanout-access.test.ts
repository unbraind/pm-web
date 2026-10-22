/** Real SQL authorization and HTTP replay must reject forged and revoked private-project viewers. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { pool } from "../src/db.ts";
import { broadcastProjectEvent, closeAllSSEClients, getProjectPresence } from "../src/services/sse.ts";
import { projectEventViewers } from "../src/services/sse-access.ts";
import { addGroupMember, authedFetch, ensureSchema, seedGroup, seedGroupShare, seedProject, seedUser, seedUserShare, startApp } from "./helpers/pg-harness.ts";
import { connectLiveSSE } from "./helpers/live-sse.ts";

/** Real project grants shared by SQL-bound, route-budget and revocation regressions. */
async function accessFixture(t: TestContext) {
  await ensureSchema();
  const owner = await seedUser(), direct = await seedUser(), member = await seedUser(), stranger = await seedUser();
  const project = await seedProject(owner.id), other = await seedProject(stranger.id);
  const group = await seedGroup(owner.id);
  await addGroupMember(group.id, member.id);
  const share = await seedUserShare(project.id, direct.id, "view");
  await seedGroupShare(project.id, group.id, "view");
  t.after(async () => { closeAllSSEClients(); await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner.id, direct.id, member.id, stranger.id]]); });
  return { owner, direct, member, stranger, project, other, group, share };
}

test("private frames and replay never reach strangers, cross-project cursor holders, or revoked direct/group viewers", async (t) => {
  const { owner, direct, member, stranger, project, other, group, share } = await accessFixture(t);
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

test("slice authorization returns only requested owner/direct/group principals and observes committed revocation", async (t) => {
  const { owner, direct, member, stranger, project, other, group } = await accessFixture(t);
  assert.deepEqual(await projectEventViewers(project.id, []), new Set());
  assert.deepEqual(await projectEventViewers(project.id, [owner.id, member.id, member.id, stranger.id]), new Set([owner.id, member.id]), "other project members must not be materialized for this slice");
  assert.deepEqual(await projectEventViewers(project.id, [direct.id]), new Set([direct.id]));
  assert.deepEqual(await projectEventViewers(other.id, [owner.id, direct.id, member.id]), new Set());
  await pool.query("DELETE FROM pm_group_members WHERE group_id = $1 AND user_id = $2", [group.id, member.id]);
  assert.deepEqual(await projectEventViewers(project.id, [owner.id, member.id]), new Set([owner.id]));
  await pool.query("DELETE FROM pm_project_shares WHERE project_id = $1 AND shared_with_user_id = $2", [project.id, direct.id]);
  assert.deepEqual(await projectEventViewers(project.id, [direct.id]), new Set());
});


test("each owner/direct/group join uses one fresh SQL round trip for access and normalized profile", async (t) => {
  const { owner, direct, member, stranger, project, group, share } = await accessFixture(t);
  await pool.query("UPDATE pm_users SET display_name = '  Slice member  ' WHERE id = $1", [member.id]);
  await pool.query("UPDATE pm_users SET display_name = NULL WHERE id = $1", [owner.id]);
  const server = await startApp();
  t.after(() => server.close());
  const query = pool.query.bind(pool);
  let reads = 0;
  // Count actual SQL without replacing any result or database behavior.
  t.mock.method(pool, "query", async (sql: string, values?: unknown[]) => {
    if ((values?.[0] === project.id && typeof values[1] === "string") || (values?.length === 1 && [owner.id, direct.id, member.id, stranger.id].includes(String(values[0])))) reads++;
    return query(sql, values);
  });
  for (const user of [owner, direct, member]) {
    reads = 0;
    const stream = await connectLiveSSE(server, user, project.id);
    try {
      assert.equal(reads, 1, "each subscriber needs one statement, even for shared access");
      if (user === owner || user === member) assert.equal(getProjectPresence(project.id).find((entry) => entry.userId === user.id)?.displayName, user === owner ? "Project member" : "Slice member");
    } finally { await stream.close(); }
  }
  for (const user of [stranger, direct, member]) {
    if (user === direct) await pool.query("DELETE FROM pm_project_shares WHERE id = $1", [share]);
    if (user === member) await pool.query("DELETE FROM pm_group_members WHERE group_id = $1 AND user_id = $2", [group.id, member.id]);
    reads = 0;
    const denied = await authedFetch(server, user, `/api/projects/${project.id}/pm/events`);
    assert.equal(denied.status, 404);
    assert.equal(reads, 1);
    await denied.text();
  }
});

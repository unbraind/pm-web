/**
 * Real-Postgres coverage for `src/routes/groups.ts`.
 *
 * Exercises group create, list, get, update, delete, and member add/remove
 * against the live app and database. Ownership is enforced on both allow and
 * deny paths: a non-owner cannot mutate someone else's group.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  authedFetch,
  ensureSchema,
  seedGroup,
  seedUser,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

test("groups: create, list, get, update, and delete as owner", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));

  // Create a group.
  const created = await authedFetch(server, owner, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "My Group", description: "initial" }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json() as { group: { id: string; name: string; description: string; role: string; member_count: string } });
  assert.equal(createdBody.group.name, "My Group");
  assert.equal(createdBody.group.description, "initial", "the submitted description must be persisted");
  assert.equal(createdBody.group.role, "owner");
  assert.equal(createdBody.group.member_count, "1");
  const groupId = createdBody.group.id;

  // List groups I own or belong to.
  const list = await authedFetch(server, owner, "/api/groups");
  assert.equal(list.status, 200);
  const groups = (await list.json() as { groups: Array<{ id: string; name: string; role: string }> }).groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, groupId);
  assert.equal(groups[0].role, "owner");

  // Get group details with members.
  const detail = await authedFetch(server, owner, `/api/groups/${groupId}`);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json() as { group: { id: string; name: string; members: Array<{ role: string; email: string }> } });
  assert.equal(detailBody.group.members.length, 1);
  assert.equal(detailBody.group.members[0].role, "owner");

  // Update the group name and description.
  const updated = await authedFetch(server, owner, `/api/groups/${groupId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed", description: "updated" }),
  });
  assert.equal(updated.status, 200);
  const updatedGroup = (await updated.json() as { group: { name: string; description: string } }).group;
  assert.equal(updatedGroup.name, "Renamed");
  assert.equal(updatedGroup.description, "updated", "the submitted description must be persisted");

  // Delete the group.
  const deleted = await authedFetch(server, owner, `/api/groups/${groupId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);

  // Listing now reflects zero groups.
  const listAfter = await authedFetch(server, owner, "/api/groups");
  assert.deepEqual((await listAfter.json() as { groups: unknown[] }).groups, []);
});

test("groups: creating without a name is 400", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const res = await authedFetch(server, owner, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("groups: a non-owner cannot update or delete someone else's group", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const stranger = await seedUser(uniqueEmail("stranger"));
  const group = await seedGroup(owner.id);

  // The stranger is not the owner and not a member, so update returns 404.
  const patch = await authedFetch(server, stranger, `/api/groups/${group.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Hijacked" }),
  });
  assert.equal(patch.status, 404, "a non-owner must not rename a group");

  const del = await authedFetch(server, stranger, `/api/groups/${group.id}`, { method: "DELETE" });
  assert.equal(del.status, 404, "a non-owner must not delete a group");
});

test("groups: a non-member cannot fetch group details (404)", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const stranger = await seedUser(uniqueEmail("stranger"));
  const group = await seedGroup(owner.id);

  const res = await authedFetch(server, stranger, `/api/groups/${group.id}`);
  assert.equal(res.status, 404);
});

test("groups: owner invites a member by email, and a non-owner cannot invite", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const invitee = await seedUser(uniqueEmail("invitee"));
  const stranger = await seedUser(uniqueEmail("stranger"));
  const group = await seedGroup(owner.id);

  // Owner invites a member.
  const invited = await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: invitee.email, role: "member" }),
  });
  assert.equal(invited.status, 201);
  const member = (await invited.json() as { member: { email: string; role: string } }).member;
  assert.equal(member.email, invitee.email);
  assert.equal(member.role, "member");

  // The invitee is now a member and can fetch the group.
  const inviteeDetail = await authedFetch(server, invitee, `/api/groups/${group.id}`);
  assert.equal(inviteeDetail.status, 200);

  // A stranger (not the owner) cannot invite anyone.
  const denied = await authedFetch(server, stranger, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: stranger.email }),
  });
  assert.equal(denied.status, 403, "only the group owner may invite members");
});

test("groups: inviting without an email is 400, and inviting a non-user is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const group = await seedGroup(owner.id);

  const noEmail = await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noEmail.status, 400);

  const unknown = await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ghost@nowhere.test" }),
  });
  assert.equal(unknown.status, 404);
});

test("groups: owner removes a member, and removing a missing member is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const member = await seedUser(uniqueEmail("member"));
  const group = await seedGroup(owner.id);

  // Add the member first via the API so the relationship exists.
  await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: member.email }),
  });

  const removed = await authedFetch(server, owner, `/api/groups/${group.id}/members/${member.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);

  // Removing again is 404 — the member row is gone.
  const again = await authedFetch(server, owner, `/api/groups/${group.id}/members/${member.id}`, {
    method: "DELETE",
  });
  assert.equal(again.status, 404);
});

test("groups: a non-owner member can remove themselves, but the owner cannot leave", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const member = await seedUser(uniqueEmail("member"));
  const group = await seedGroup(owner.id);

  await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: member.email }),
  });

  // A member removing themselves is allowed even though they are not the owner.
  const self = await authedFetch(server, member, `/api/groups/${group.id}/members/${member.id}`, {
    method: "DELETE",
  });
  assert.equal(self.status, 200);

  // The owner trying to leave their own group is rejected — they must delete it.
  const ownerLeave = await authedFetch(server, owner, `/api/groups/${group.id}/members/${owner.id}`, {
    method: "DELETE",
  });
  assert.equal(ownerLeave.status, 400);
});

test("groups: a non-owner cannot remove another member", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const memberA = await seedUser(uniqueEmail("memberA"));
  const memberB = await seedUser(uniqueEmail("memberB"));
  const group = await seedGroup(owner.id);

  // Owner adds both members.
  for (const m of [memberA, memberB]) {
    await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: m.email }),
    });
  }

  // memberA tries to remove memberB — not the owner, not self, so 403.
  const res = await authedFetch(server, memberA, `/api/groups/${group.id}/members/${memberB.id}`, {
    method: "DELETE",
  });
  assert.equal(res.status, 403);
});

test("groups: create without a description defaults to empty", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const created = await authedFetch(server, owner, "/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "NoDesc" }),
  });
  assert.equal(created.status, 201);
  // Fetching the detail confirms the description defaulted to empty.
  const gid = (await created.json() as { group: { id: string } }).group.id;
  const detail = await authedFetch(server, owner, `/api/groups/${gid}`);
  assert.equal((await detail.json() as { group: { description: string } }).group.description, "");
});

test("groups: patch with only a name leaves the description untouched", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // Seed a non-empty description: with an empty one the assertion below could
  // not distinguish "preserved" from "wiped".
  const group = await seedGroup(owner.id, undefined, "keep me");
  const res = await authedFetch(server, owner, `/api/groups/${group.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "OnlyName" }),
  });
  assert.equal(res.status, 200);
  const patched = (await res.json() as { group: { name: string; description: string } }).group;
  assert.equal(patched.name, "OnlyName");
  assert.equal(patched.description, "keep me", "a name-only PATCH must not clear the description");
});

test("groups: inviting with role 'owner' stores the owner role", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const invitee = await seedUser(uniqueEmail("invitee"));
  const group = await seedGroup(owner.id);
  const res = await authedFetch(server, owner, `/api/groups/${group.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: invitee.email, role: "owner" }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json() as { member: { role: string } }).member.role, "owner");
});

test("groups: a malformed group identifier is rejected with 400 before reaching SQL", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // A non-UUID id makes the membership-check query throw a syntax error, which
  // the uuidParamGuard rejects first, so the client gets an accurate 400 and the
  // group's state is never consulted.
  const res = await authedFetch(server, owner, "/api/groups/not-a-uuid");
  assert.equal(res.status, 400);
});

test("groups: a malformed identifier is rejected with 400 on mutating routes", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const patch = await authedFetch(server, owner, "/api/groups/not-a-uuid", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });
  assert.equal(patch.status, 400);

  const del = await authedFetch(server, owner, "/api/groups/not-a-uuid", { method: "DELETE" });
  assert.equal(del.status, 400);
});

test("groups: a malformed identifier is rejected with 400 on member routes", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const invite = await authedFetch(server, owner, "/api/groups/not-a-uuid/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x@y.test" }),
  });
  assert.equal(invite.status, 400);

  const remove = await authedFetch(server, owner, "/api/groups/not-a-uuid/members/not-a-uuid-either", {
    method: "DELETE",
  });
  assert.equal(remove.status, 400);
});

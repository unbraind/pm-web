/**
 * Real-Postgres coverage for `src/routes/sharing.ts`.
 *
 * Exercises every share route — list, create (by email and by group), remove,
 * and the `shared-with-me` listing — against the live Express app and a live
 * PostgreSQL database. Each ownership and permission branch is asserted on
 * both its allow and its deny path: the deny path is the one that regressed
 * before, when a wrong JOIN let a non-owner through.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  addGroupMember,
  authedFetch,
  ensureSchema,
  seedGroup,
  seedProject,
  seedUser,
  seedUserShare,
  seedGroupShare,
  setupOwnerProjectTest,
  startApp,
  uniqueEmail,
  type AppServer,
  type SeedUser,
} from "./helpers/pg-harness.ts";

/** POST a share-create request and return the response. */
async function createShare(
  server: AppServer,
  user: SeedUser,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return authedFetch(server, user, `/api/projects/${projectId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE a share and return the response. */
async function deleteShare(
  server: AppServer,
  user: SeedUser,
  projectId: string,
  shareId: string,
): Promise<Response> {
  return authedFetch(server, user, `/api/projects/${projectId}/shares/${shareId}`, {
    method: "DELETE",
  });
}

/** Setup for share-removal tests: create an owner with a project, a
 * collaborator, and a view-permission share row. */
async function setupShareTest(t: test.TestContext): Promise<{
  server: AppServer; owner: SeedUser; project: { id: string }; collaborator: SeedUser; shareId: string;
}> {
  const { server, owner, project } = await setupOwnerProjectTest(t);
  const collaborator = await seedUser(uniqueEmail("collab"));
  const shareId = await seedUserShare(project.id, collaborator.id, "view");
  return { server, owner, project, collaborator, shareId };
}


test("sharing: owner lists shares, non-owner is denied 404", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);
  const stranger = await seedUser(uniqueEmail("stranger"));

  const ok = await authedFetch(server, owner, `/api/projects/${project.id}/shares`);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json() as { shares: unknown[] }).shares, []);

  const denied = await authedFetch(server, stranger, `/api/projects/${project.id}/shares`);
  assert.equal(denied.status, 404, "non-owner must not read the share list");
});

test("sharing: share by email, permission coerces to view for non-edit", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);
  const collaborator = await seedUser(uniqueEmail("collab"));

  // "admin" is not a recognized permission; the route coerces anything but
  // "edit" to "view", so the stored share must read "view".
  const created = await createShare(server, owner, project.id, { email: collaborator.email, permission: "admin" });
  assert.equal(created.status, 201);
  const share = (await created.json() as { share: { permission: string; user_email: string } }).share;
  assert.equal(share.permission, "view");
  assert.equal(share.user_email, collaborator.email);

  // The owner's listing now reflects the share.
  const list = await authedFetch(server, owner, `/api/projects/${project.id}/shares`);
  const listed = (await list.json() as { shares: Array<{ user_email: string; permission: string }> }).shares;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].user_email, collaborator.email);
  assert.equal(listed[0].permission, "view");
});

test("sharing: explicit edit permission is preserved", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const editor = await seedUser(uniqueEmail("editor"));
  const project = await seedProject(owner.id);

  const created = await createShare(server, owner, project.id, { email: editor.email, permission: "edit" });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { share: { permission: string } }).share.permission, "edit");
});

test("sharing: both email and groupId supplied is 400", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const other = await seedUser(uniqueEmail("other"));
  const project = await seedProject(owner.id);
  const group = await seedGroup(owner.id);

  const res = await createShare(server, owner, project.id, { email: other.email, groupId: group.id });
  assert.equal(res.status, 400);
});

test("sharing: neither email nor groupId supplied is 400", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);

  const res = await createShare(server, owner, project.id, {});
  assert.equal(res.status, 400);
});

test("sharing: non-owner cannot create a share (404)", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);
  const stranger = await seedUser(uniqueEmail("stranger"));
  const target = await seedUser(uniqueEmail("target"));

  const res = await createShare(server, stranger, project.id, { email: target.email });
  assert.equal(res.status, 404, "a non-owner must not be told the project exists");
});

test("sharing: sharing with a non-existent user is 404", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);

  const res = await createShare(server, owner, project.id, { email: "nobody@nowhere.test" });
  assert.equal(res.status, 404);
});

test("sharing: cannot share a project with yourself (400)", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);

  const res = await createShare(server, owner, project.id, { email: owner.email });
  assert.equal(res.status, 400);
});

test("sharing: share by group, and non-member group is 404", async (t) => {
  const { server, owner, project } = await setupOwnerProjectTest(t);
  const group = await seedGroup(owner.id);

  // Owner is a member of their own group (seeded), so sharing succeeds.
  const created = await createShare(server, owner, project.id, { groupId: group.id, permission: "edit" });
  assert.equal(created.status, 201);
  const share = (await created.json() as { share: { group_id: string; group_name: string; permission: string } }).share;
  assert.equal(share.group_id, group.id);
  assert.equal(share.permission, "edit");

  // A stranger who is not a member of the group cannot reference it.
  const stranger = await seedUser(uniqueEmail("stranger"));
  const strangerProject = await seedProject(stranger.id);
  const denied = await createShare(server, stranger, strangerProject.id, { groupId: group.id });
  assert.equal(denied.status, 404, "a non-member must not share through someone else's group");
});

test("sharing: owner removes a share, and removing a missing share is 404", async (t) => {
  const { server, owner, project, shareId } = await setupShareTest(t);

  const removed = await deleteShare(server, owner, project.id, shareId);
  assert.equal(removed.status, 200);

  // Removing again is now a 404 — the share is gone.
  const again = await deleteShare(server, owner, project.id, shareId);
  assert.equal(again.status, 404);
});

test("sharing: a non-owner cannot remove a share (404)", async (t) => {
  const { server, project, collaborator, shareId } = await setupShareTest(t);

  const res = await deleteShare(server, collaborator, project.id, shareId);
  assert.equal(res.status, 404, "only the project owner may remove a share");
});

test("sharing: shared-with-me lists user and group shares, excludes the unshared", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const viewer = await seedUser(uniqueEmail("viewer"));
  const groupOwner = await seedUser(uniqueEmail("groupowner"));
  const groupMate = await seedUser(uniqueEmail("groupmate"));
  const outsider = await seedUser(uniqueEmail("outsider"));

  const userShared = await seedProject(owner.id, undefined, { name: "UserShared" });
  await seedUserShare(userShared.id, viewer.id, "view");

  // The group is owned by a third user so the project owner is NOT a member;
  // only `groupMate` is. This isolates the group-share path from ownership.
  const groupShared = await seedProject(owner.id, undefined, { name: "GroupShared" });
  const group = await seedGroup(groupOwner.id);
  await addGroupMember(group.id, groupMate.id);
  await seedGroupShare(groupShared.id, group.id, "edit");

  const unshared = await seedProject(owner.id, undefined, { name: "Unshared" });

  // The viewer sees the directly-shared project.
  const viewerList = await authedFetch(server, viewer, "/api/shared");
  assert.equal(viewerList.status, 200);
  const viewerProjects = (await viewerList.json() as { projects: Array<{ name: string; permission: string }> }).projects;
  assert.equal(viewerProjects.length, 1);
  assert.equal(viewerProjects[0].name, "UserShared");
  assert.equal(viewerProjects[0].permission, "view");

  // The group member sees the group-shared project.
  const mateList = await authedFetch(server, groupMate, "/api/shared");
  const mateProjects = (await mateList.json() as { projects: Array<{ name: string; permission: string }> }).projects;
  assert.equal(mateProjects.length, 1);
  assert.equal(mateProjects[0].name, "GroupShared");
  assert.equal(mateProjects[0].permission, "edit");

  // The outsider sees nothing.
  const outsiderList = await authedFetch(server, outsider, "/api/shared");
  assert.deepEqual((await outsiderList.json() as { projects: unknown[] }).projects, []);

  // The owner is not a member of the group, so they see nothing under
  // "shared with me" either — they own everything, nothing is shared *to* them.
  const ownerList = await authedFetch(server, owner, "/api/shared");
  assert.deepEqual((await ownerList.json() as { projects: unknown[] }).projects, []);

  // `unshared` must never appear in any listing, which the assertions above
  // already prove; touch it so the binding is not flagged unused.
  assert.ok(unshared.id);
});

test("sharing: a malformed project identifier is rejected with 400 before reaching SQL", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // A non-UUID id makes the ownership-check query throw a syntax error; the
  // requireUuidParams rejects the mount-path id first, so the client gets an
  // accurate 400 and the project's existence is never consulted.
  const res = await authedFetch(server, owner, "/api/projects/not-a-uuid/shares");
  assert.equal(res.status, 400);
});

test("sharing: a malformed identifier is rejected with 400 on mutating routes", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const post = await createShare(server, owner, "not-a-uuid", { email: "x@y.test" });
  assert.equal(post.status, 400);

  const del = await deleteShare(server, owner, "not-a-uuid", "some-id");
  assert.equal(del.status, 400);

  // The mount-path project id is validated first, so :shareId is only genuinely
  // exercised behind a valid project id. Asserting the error body proves it is
  // the shareId guard answering and not the project guard again.
  const project = await seedProject(owner.id);
  const badShare = await deleteShare(server, owner, project.id, "not-a-uuid");
  assert.equal(badShare.status, 400);
  assert.equal(((await badShare.json()) as { error: string }).error, "Invalid shareId");
});

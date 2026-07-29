/**
 * Real-Postgres coverage for `src/routes/projects.ts`.
 *
 * Exercises create/list/get/update/delete, slug uniqueness per user, and that
 * another user's project is invisible (404, matching the existing deny style).
 * The create route spawns the pm CLI to initialize on-disk storage, so this
 * file points `PROJECTS_ROOT` at a throwaway directory and `PM_CLI_BIN` at a
 * trivial stub that exits successfully — the access-control surface is what is
 * under test, not the pm CLI itself.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addGroupMember,
  authedFetch,
  ensureSchema,
  seedGroup,
  seedGroupShare,
  seedProject,
  seedUser,
  seedUserShare,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

/**
 * Wires `PROJECTS_ROOT` and `PM_CLI_BIN` at a throwaway directory and a stub
 * pm binary that records invocations and always exits 0. Returns a restore
 * function plus the log path so a test can assert no spawn happened for a
 * denied request. Mirrors the pattern established by `extensions-routes.test.ts`.
 */
async function setupFsHarness(): Promise<{ restore: () => Promise<void>; logPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-projects-"));
  const fakePm = path.join(root, "fake-pm");
  const logPath = path.join(root, "commands.log");
  await writeFile(
    fakePm,
    `#!/usr/bin/env node\nconst fs=require("node:fs");const log=process.env.FAKE_PM_LOG;if(log)fs.appendFileSync(log,process.argv.slice(2).join(" ")+"\\n");process.stdout.write(JSON.stringify({ok:true,details:{extensions:[]}}));\n`,
  );
  await chmod(fakePm, 0o755);
  // The project create route spawns pm with cwd PROJECTS_ROOT/<userId>/<slug>;
  // it must exist or the spawn throws before the fake pm runs. We cannot know
  // the slug ahead of time, so create the owner dir and let pm init make the
  // nested slug dir. The fake pm does not create it, so pre-create a known slug
  // for the create test and let the dynamic slug for the uniqueness test use a
  // pre-created parent only. In practice the create route calls initProject
  // which mkdirs the slug dir itself before spawning, so no pre-creation is
  // needed beyond PROJECTS_ROOT existing.
  await mkdir(root, { recursive: true });
  const prevRoot = process.env.PROJECTS_ROOT;
  const prevBin = process.env.PM_CLI_BIN;
  process.env.PROJECTS_ROOT = root;
  process.env.PM_CLI_BIN = fakePm;
  process.env.FAKE_PM_LOG = logPath;
  return {
    logPath,
    restore: async () => {
      if (prevRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = prevRoot;
      if (prevBin === undefined) delete process.env.PM_CLI_BIN;
      else process.env.PM_CLI_BIN = prevBin;
      delete process.env.FAKE_PM_LOG;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("projects: create, list, get, update, and delete as owner", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));

  // Create a project.
  const created = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "My Project", prefix: "mp" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json() as { project: { id: string; name: string; slug: string; prefix: string } }).project;
  assert.equal(project.name, "My Project");
  assert.equal(project.prefix, "mp");
  assert.ok(project.slug);

  // List own projects.
  const list = await authedFetch(server, owner, "/api/projects");
  assert.equal(list.status, 200);
  const projects = (await list.json() as { projects: Array<{ id: string; is_owner: boolean; permission: string }> }).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, project.id);
  assert.equal(projects[0].is_owner, true);
  assert.equal(projects[0].permission, "edit");

  // Get the project.
  const got = await authedFetch(server, owner, `/api/projects/${project.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json() as { project: { id: string } }).project.id, project.id);

  // Update name and description.
  const updated = await authedFetch(server, owner, `/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed", description: "desc" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = (await updated.json() as { project: { name: string; description: string } });
  assert.equal(updatedBody.project.name, "Renamed");
  assert.equal(updatedBody.project.description, "desc");

  // Delete the project.
  const deleted = await authedFetch(server, owner, `/api/projects/${project.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);

  // It is gone from the listing.
  const listAfter = await authedFetch(server, owner, "/api/projects");
  assert.deepEqual((await listAfter.json() as { projects: unknown[] }).projects, []);
});

test("projects: create validates name and prefix shape", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));

  const noName = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix: "p" }),
  });
  assert.equal(noName.status, 400);

  const noPrefix = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });
  assert.equal(noPrefix.status, 400);

  const badPrefix = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X", prefix: "UPPER" }),
  });
  assert.equal(badPrefix.status, 400);
});

test("projects: slug uniqueness per user (409), and another user's project is 404", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const other = await seedUser(uniqueEmail("other"));

  // Create one project as owner.
  const first = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Same Name", prefix: "sn" }),
  });
  assert.equal(first.status, 201);
  const firstProject = (await first.json() as { project: { id: string; slug: string } }).project;

  // Creating a project with a name that slugifies to the same slug is 409.
  // The slug is derived from the name, so re-using "Same Name" reproduces it.
  const dup = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Same Name", prefix: "sn2" }),
  });
  assert.equal(dup.status, 409, "a duplicate slug for the same user must be rejected");

  // Another user cannot read the owner's project — 404, not 403, matching the
  // existing deny style so the project's existence is not leaked.
  const denied = await authedFetch(server, other, `/api/projects/${firstProject.id}`);
  assert.equal(denied.status, 404);

  // Another user cannot update or delete it either.
  const patchDenied = await authedFetch(server, other, `/api/projects/${firstProject.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Hijacked" }),
  });
  assert.equal(patchDenied.status, 404);

  const deleteDenied = await authedFetch(server, other, `/api/projects/${firstProject.id}`, { method: "DELETE" });
  assert.equal(deleteDenied.status, 404);
});

test("projects: a shared collaborator sees the project in their list and can read it", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const viewer = await seedUser(uniqueEmail("viewer"));
  const project = await seedProject(owner.id);

  // Share directly with the viewer.
  await seedUserShare(project.id, viewer.id, "view");

  // The viewer's project list includes the shared project with view permission.
  const list = await authedFetch(server, viewer, "/api/projects");
  const projects = (await list.json() as { projects: Array<{ id: string; is_owner: boolean; permission: string }> }).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, project.id);
  assert.equal(projects[0].is_owner, false);
  assert.equal(projects[0].permission, "view");

  // The viewer can GET the shared project.
  const got = await authedFetch(server, viewer, `/api/projects/${project.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json() as { project: { id: string; permission: string } }).project.permission, "view");

  // The viewer cannot PATCH it (only the owner's user_id matches).
  const patch = await authedFetch(server, viewer, `/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Nope" }),
  });
  assert.equal(patch.status, 404);

  // The viewer cannot DELETE it.
  const del = await authedFetch(server, viewer, `/api/projects/${project.id}`, { method: "DELETE" });
  assert.equal(del.status, 404);
});

test("projects: a group-shared collaborator sees the project in their list", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const groupOwner = await seedUser(uniqueEmail("groupowner"));
  const member = await seedUser(uniqueEmail("member"));
  const project = await seedProject(owner.id);
  const group = await seedGroup(groupOwner.id);
  await addGroupMember(group.id, member.id);
  // Share the project with the group; the member (a group member) gains view.
  await seedGroupShare(project.id, group.id, "view");

  const list = await authedFetch(server, member, "/api/projects");
  const projects = (await list.json() as { projects: Array<{ id: string; permission: string }> }).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, project.id);
  assert.equal(projects[0].permission, "view");
});

test("projects: create without a description defaults to empty", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const created = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "NoDesc", prefix: "nd" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json() as { project: { id: string } }).project;
  const got = await authedFetch(server, owner, `/api/projects/${project.id}`);
  assert.equal((await got.json() as { project: { description: string } }).project.description, "");
});

test("projects: patch with only a name leaves the description untouched", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // Seed a non-empty description: with an empty one the assertion below could
  // not distinguish "preserved" from "wiped".
  const project = await seedProject(owner.id, undefined, { description: "keep me" });
  const res = await authedFetch(server, owner, `/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "OnlyName" }),
  });
  assert.equal(res.status, 200);
  const patched = (await res.json() as { project: { name: string; description: string } }).project;
  assert.equal(patched.name, "OnlyName");
  assert.equal(patched.description, "keep me", "a name-only PATCH must not clear the description");
});

test("projects: patching only the description preserves the name (partial update)", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // Seed a non-empty name: with the default ("P") the assertion could not tell
  // "preserved" from "reset to default".
  const project = await seedProject(owner.id, undefined, { name: "OriginalName", description: "old" });
  const res = await authedFetch(server, owner, `/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // A description-only PATCH must omit name, so the route's
  // `name?.trim() || null` resolves to null and COALESCE keeps the existing
  // name — the partial-update contract clients rely on.
    body: JSON.stringify({ description: "refreshed" }),
  });
  assert.equal(res.status, 200);
  const patched = (await res.json() as { project: { name: string; description: string } }).project;
  assert.equal(patched.description, "refreshed");
  assert.equal(patched.name, "OriginalName", "omitting name must leave it untouched");
});

test("projects: a malformed project identifier is rejected with 400 before reaching SQL", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  // A non-UUID id makes verifyProjectAccess's ownership query throw, which the
  // The uuidParamGuard rejects first, so the client gets an accurate 400 and the
  // project's state is never consulted.
  const res = await authedFetch(server, owner, "/api/projects/not-a-uuid");
  assert.equal(res.status, 400);
});

test("projects: create with a description preserves it", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const created = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "WithDesc", prefix: "wd", description: "a description" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json() as { project: { id: string } }).project;
  const got = await authedFetch(server, owner, `/api/projects/${project.id}`);
  assert.equal((await got.json() as { project: { description: string } }).project.description, "a description");
});

test("projects: a malformed identifier is rejected with 400 on mutating routes", async (t) => {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());

  const owner = await seedUser(uniqueEmail("owner"));
  const patch = await authedFetch(server, owner, "/api/projects/not-a-uuid", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });
  assert.equal(patch.status, 400);

  const del = await authedFetch(server, owner, "/api/projects/not-a-uuid", { method: "DELETE" });
  assert.equal(del.status, 400);
});

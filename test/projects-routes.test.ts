import { failedFixtureSetup } from './helpers/fixture-resources.ts';
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
import fs from "node:fs";
import { deferred } from "./helpers/deferred.ts";
import { getPmClient, getProjectDir, runSerialized } from "../src/services/pm-runner.ts";
import { pool } from '../src/db.ts';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { createPlainContractTracker } from "./helpers/plain-contract-tracker.ts";
import { chmod, mkdir, mkdtemp, lstat, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addGroupMember,
  assertMalformedUuidMutating,
  authedFetch,
  ensureSchema,
  seedGroup,
  seedGroupShare,
  seedProject,
  seedUser,
  seedUserShare,
  setupOwnerProjectTest,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

/** Setup for project tests: ensure schema, set up the fs harness (PROJECTS_ROOT
 * and a fake pm binary), start the app, and create an owner. Does NOT seed a
 * project — tests that need one call `seedProject` or `createProject`. */
async function setupProjectsTest(t: test.TestContext): Promise<{ server: Awaited<ReturnType<typeof startApp>>; owner: Awaited<ReturnType<typeof seedUser>> }> {
  await ensureSchema();
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const server = await startApp();
  t.after(() => server.close());
  const owner = await seedUser(uniqueEmail("owner"));
  return { server, owner };
}

/** Create a project via POST and return the created project body. */
async function createProject(server: Awaited<ReturnType<typeof startApp>>, owner: Awaited<ReturnType<typeof seedUser>>, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await authedFetch(server, owner, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  return (await res.json() as { project: { id: string } }).project;
}

/** GET a project and return its body. */
async function getProject(server: Awaited<ReturnType<typeof startApp>>, user: Awaited<ReturnType<typeof seedUser>>, id: string): Promise<{ description: string; name: string }> {
  const got = await authedFetch(server, user, `/api/projects/${id}`);
  return (await got.json() as { project: { description: string; name: string } }).project;
}
/** Fetch the project list for a user and assert it contains exactly one
 * project with the expected id, ownership, and permission. */
async function assertProjectList(
  server: Awaited<ReturnType<typeof startApp>>,
  user: Awaited<ReturnType<typeof seedUser>>,
  projectId: string,
  isOwner: boolean,
  permission: string,
): Promise<void> {
  const list = await authedFetch(server, user, "/api/projects");
  const projects = (await list.json() as { projects: Array<{ id: string; is_owner: boolean; permission: string }> }).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, projectId);
  assert.equal(projects[0].is_owner, isOwner);
  assert.equal(projects[0].permission, permission);
}
/** PATCH a project and return the patched project body. */
async function patchProject(
  server: Awaited<ReturnType<typeof startApp>>,
  owner: Awaited<ReturnType<typeof seedUser>>,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ name: string; description: string }> {
  const res = await authedFetch(server, owner, `/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json() as { project: { name: string; description: string } }).project;
}





/**
 * Wires `PROJECTS_ROOT` and `PM_CLI_BIN` at a throwaway directory and a stub
 * pm binary that records invocations and always exits 0. Returns a restore
 * function plus the log path so a test can assert no spawn happened for a
 * denied request. Mirrors the pattern established by `extensions-routes.test.ts`.
 */
async function setupFsHarness(): Promise<{ restore: () => Promise<void>; logPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-projects-"));
  try {
  const fakePm = path.join(root, "fake-pm.cjs");
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
  } catch (error) {
    return failedFixtureSetup(root, error);
  }
}

test("projects: create, list, get, update, and delete as owner", async (t) => {
  const { server, owner } = await setupProjectsTest(t);

  // Create a project.
  const created = await authedFetch(server, owner, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "My Project", prefix: "mp" }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json() as { project: { id: string; name: string; slug: string; prefix: string; permission: string } }).project;
  assert.equal(project.permission, "edit", "the creation response must let the owner edit immediately, before reloading projects");
  assert.equal(project.name, "My Project");
  assert.equal(project.prefix, "mp");
  assert.ok(project.slug);

  // List own projects.
  await assertProjectList(server, owner, project.id, true, "edit");

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
  const { server, owner } = await setupProjectsTest(t);

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
  const { server, owner } = await setupProjectsTest(t);
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
  const { server, owner } = await setupOwnerProjectTest(t);
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  const viewer = await seedUser(uniqueEmail("viewer"));
  const project = await seedProject(owner.id);

  // Share directly with the viewer.
  await seedUserShare(project.id, viewer.id, "view");

  // The viewer's project list includes the shared project with view permission.
  await assertProjectList(server, viewer, project.id, false, "view");

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
  const { server, owner } = await setupOwnerProjectTest(t);
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
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
  const { server, owner } = await setupProjectsTest(t);
  const project = await createProject(server, owner, { name: "NoDesc", prefix: "nd" });
  assert.equal((await getProject(server, owner, project.id)).description, "");
});

test("projects: patch with only a name leaves the description untouched", async (t) => {
  const { server, owner } = await setupProjectsTest(t);
  // Seed a non-empty description: with an empty one the assertion below could
  // not distinguish "preserved" from "wiped".
  const project = await seedProject(owner.id, undefined, { description: "keep me" });
  const patched = await patchProject(server, owner, project.id, { name: "OnlyName" });
  assert.equal(patched.name, "OnlyName");
  assert.equal(patched.description, "keep me", "a name-only PATCH must not clear the description");
});

test("projects: patching only the description preserves the name (partial update)", async (t) => {
  const { server, owner } = await setupProjectsTest(t);
  // Seed a non-empty name: with the default ("P") the assertion could not tell
  // "preserved" from "reset to default".
  const project = await seedProject(owner.id, undefined, { name: "OriginalName", description: "old" });
  const patched = await patchProject(server, owner, project.id, { description: "refreshed" });
  assert.equal(patched.description, "refreshed");
  assert.equal(patched.name, "OriginalName", "omitting name must leave it untouched");
});

test("projects: a malformed project identifier is rejected with 400 before reaching SQL", async (t) => {
  const { server, owner } = await setupOwnerProjectTest(t);
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  // A non-UUID id makes verifyProjectAccess's ownership query throw, which the
  // The uuidParamGuard rejects first, so the client gets an accurate 400 and the
  // project's state is never consulted.
  const res = await authedFetch(server, owner, "/api/projects/not-a-uuid");
  assert.equal(res.status, 400);
});

test("projects: create with a description preserves it", async (t) => {
  const { server, owner } = await setupProjectsTest(t);
  const project = await createProject(server, owner, { name: "WithDesc", prefix: "wd", description: "a description" });
  assert.equal((await getProject(server, owner, project.id)).description, "a description");
});

test("projects: a malformed identifier is rejected with 400 on mutating routes", async (t) => {
  const { server, owner } = await setupOwnerProjectTest(t);
  const fs = await setupFsHarness();
  t.after(() => fs.restore());
  await assertMalformedUuidMutating(server, owner, "projects");
});


/** Corrupt tracker identities must not interrupt storage cleanup or the subsequent row removal. */
test('projects: deletion removes workspaces with tracker and ancestor symlink loops', async t => {
  const { server, owner } = await setupProjectsTest(t);
  for (const kind of ['tracker', 'ancestor', 'workspace']) {
    const project = await seedProject(owner.id);
    const cwd = getProjectDir(owner.id, project.slug);
    const { pmRoot } = await createPlainContractTracker(cwd);
    const cached = (await getPmClient(pmRoot));
    const link = kind === 'tracker' ? pmRoot : kind === 'ancestor' ? path.dirname(pmRoot) : cwd;
    await rm(link, { recursive: true });
    await symlink(link, link, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200, `${kind}: ${await response.text()}`);
    await assert.rejects(stat(cwd), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal((await authedFetch(server, owner, `/api/projects/${project.id}`)).status, 404);
    assert.notEqual((await getPmClient(pmRoot)), cached, 'deletion also evicts the old SDK client');
  }
});

/** Delete a project through the route and prove its row and the named storage are gone. */
async function assertDeletionRemoves(server: Parameters<typeof authedFetch>[0], owner: Parameters<typeof authedFetch>[1], projectId: string, removed: string): Promise<void> {
  const response = await authedFetch(server, owner, `/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [projectId])).rowCount, 0);
  await assert.rejects(stat(removed), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
}

/** A deletion that waited on one physical queue must not remove the storage an ancestor retarget now names. */
test('projects: deletion refuses when an ancestor symlink is retargeted while it waits', async t => {
  const { server, owner } = await setupProjectsTest(t);
  const project = await seedProject(owner.id), cwd = getProjectDir(owner.id, project.slug);
  const parent = path.dirname(cwd), parentA = `${parent}-a`, parentB = `${parent}-b`;
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  const original = fs.promises.realpath;
  const trackerA = await createPlainContractTracker(cwd);
  const { item: itemA } = await trackerA.client.create({ type: 'Task', title: 'Admitted storage', body: 'Synthetic deletion fixture' });
  await rename(parent, parentA);
  await symlink(parentA, parent, link);
  const trackerB = await createPlainContractTracker(path.join(parentB, project.slug));
  const { item: itemB } = await trackerB.client.create({ type: 'Task', title: 'Retargeted storage', body: 'must survive the old deletion' });
  const hold = deferred<void>(), holding = deferred<void>(), discovery = deferred<void>(), queued = deferred<void>();
  let watch = false;
  const requests: Promise<unknown>[] = [];
  try {
    const held = runSerialized(cwd, () => hold.promise, holding.resolve); requests.push(held);
    await holding.promise;
    Reflect.set(fs.promises, 'realpath', new Proxy(original, { apply(target, receiver, args) {
      if (watch && String(args[0]) === cwd) discovery.resolve();
      return Reflect.apply(target, receiver, args);
    } }));
    watch = true;
    const deletion = authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' }); requests.push(deletion);
    await discovery.promise;
    watch = false;
    // Admissions are ordered, so this one is pinned only after the deletion joined the admitted queue.
    const after = runSerialized(cwd, async () => undefined, queued.resolve); requests.push(after);
    await queued.promise;
    await rm(parent);
    await symlink(parentB, parent, link);
    hold.resolve();
    const response = await deletion;
    assert.equal(response.status, 409, await response.text());
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1 AND user_id=$2', [project.id, owner.id])).rowCount, 1, 'a refused deletion keeps the project row');
    assert.equal((await trackerB.client.get(itemB.id)).item.title, 'Retargeted storage', 'the retargeted storage must survive');
    // Read the admitted storage through its physical path; the logical path now names the retargeted storage.
    const admittedClient = new PmClient({ pmRoot: path.join(parentA, project.slug, '.agents', 'pm'), cwd: path.join(parentA, project.slug), noExtensions: true });
    assert.equal((await admittedClient.get(itemA.id)).item.title, 'Admitted storage', 'nothing is removed on refusal');
    // Must allow: once the binding names the storage again, deletion admits and removes it.
    await rm(parent);
    await symlink(parentA, parent, link);
    await assertDeletionRemoves(server, owner, project.id, path.join(parentA, project.slug));
  } finally {
    watch = false;
    hold.resolve();
    Reflect.set(fs.promises, 'realpath', original);
    await Promise.allSettled(requests);
    await rm(parent, { force: true });
    await rename(parentA, parent);
    await rm(parentB, { recursive: true, force: true });
  }
});

/** A real ENOTDIR failure keeps the project discoverable and its original tracker available for retry. */
test('projects: failed filesystem removal preserves the row and data, then retry succeeds', async t => {
  const { server, owner } = await setupProjectsTest(t);
  const project = await seedProject(owner.id), cwd = getProjectDir(owner.id, project.slug);
  const { client, pmRoot } = await createPlainContractTracker(cwd);
  const { item } = await client.create({ type: 'Task', title: 'Retained after refusal', body: 'Synthetic deletion fixture' });
  const parent = path.dirname(cwd), saved = `${parent}-saved`;
  await rename(parent, saved);
  await writeFile(parent, 'synthetic ancestor obstruction');
  try {
    await assert.rejects(rm(cwd, { recursive: true, force: true }), (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR');
    const response = await authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(response.status, 500);
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1 AND user_id=$2', [project.id, owner.id])).rowCount, 1, 'failed storage cleanup must retain the project row');
    assert.equal((await authedFetch(server, owner, `/api/projects/${project.id}`)).status, 200, 'retry must remain discoverable');
    assert.equal(await readFile(parent, 'utf8'), 'synthetic ancestor obstruction');
  } finally { await rm(parent); await rename(saved, parent); }
  assert.equal((await client.get(item.id)).item.title, 'Retained after refusal');
  await assertDeletionRemoves(server, owner, project.id, pmRoot);
});

/** Both present and already absent real workspaces permit row cleanup after successful removal. */
test('projects: successful filesystem cleanup permits deletion of present and absent workspaces', async t => {
  const { server, owner } = await setupProjectsTest(t);
  for (const present of [true, false]) {
    const project = await seedProject(owner.id), cwd = getProjectDir(owner.id, project.slug);
    const { client } = await createPlainContractTracker(cwd);
    await client.create({ type: 'Task', title: 'Synthetic removable record' });
    if (!present) await rm(cwd, { recursive: true });
    const response = await authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200, await response.text());
    await assert.rejects(stat(cwd), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [project.id])).rowCount, 0);
    assert.equal((await authedFetch(server, owner, `/api/projects/${project.id}`)).status, 404);
  }
});

/** Failed initialization must also keep its row when a real cleanup obstruction prevents rollback. */
test('projects: initialization rollback retains its row when filesystem cleanup fails', async t => {
  const { server, owner } = await setupProjectsTest(t);
  const parent = path.join(process.env.PROJECTS_ROOT!, owner.id), saved = `${parent}-saved`;
  const fakePm = process.env.PM_CLI_BIN!;
  await writeFile(fakePm, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const cwd = process.cwd(), parent = path.dirname(cwd);
fs.writeFileSync(path.join(cwd, "partial-data"), "synthetic retained data");
fs.renameSync(parent, parent + "-saved");
fs.writeFileSync(parent, "synthetic ancestor obstruction");
process.exit(1);
`);
  try {
    const response = await authedFetch(server, owner, '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Retained partial project', prefix: 'partial' }) });
    assert.equal(response.status, 500);
    const rows = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM pm_projects WHERE user_id=$1', [owner.id]);
    assert.equal(rows.rowCount, 1, 'failed initialization cleanup must retain the owning row');
    const project = rows.rows[0]!;
    await assert.rejects(rm(getProjectDir(owner.id, project.slug), { recursive: true, force: true }), (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR');
    await rm(parent); await rename(saved, parent);
    assert.equal(await readFile(path.join(getProjectDir(owner.id, project.slug), 'partial-data'), 'utf8'), 'synthetic retained data');
    const retried = await authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(retried.status, 200);
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [project.id])).rowCount, 0);
  } finally {
    if (await stat(saved).then(() => true, () => false)) { await rm(parent, { force: true }); await rename(saved, parent); }
  }
});

/** Observe real PostgreSQL blocking instead of relying on a scheduling delay. */
async function blockedBy(pid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  do {
    const result = await pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND datname=current_database()', [pid]);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise<void>(resolve => { setImmediate(resolve); });
  } while (Date.now() < deadline);
  throw new Error('The expected project-row lock was not observed');
}

/** SQL and physical queue ownership last through commit; unrelated rows and trackers remain available. */
test('projects: deletion owns its row and queue through commit while unrelated projects proceed', async t => {
  const { server, owner } = await setupProjectsTest(t);
  const name = 'Serialized deletion', slug = 'serialized-deletion';
  const project = await seedProject(owner.id, slug, { name, prefix: 'serial' });
  const other = await seedProject(owner.id), cwd = getProjectDir(owner.id, slug);
  const { client } = await createPlainContractTracker(cwd);
  await client.create({ type: 'Task', title: 'Old project data' });
  await createPlainContractTracker(getProjectDir(owner.id, other.slug));
  const controller = await pool.connect();
  const controllerPid = (await controller.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const trigger = 'project_delete_gate_' + project.id.replaceAll('-', '');
  const original = fs.promises.realpath;
  const earlyLookup = deferred<void>(), queued = deferred<void>();
  let watchSecond = false, queuedWork = false;
  const requests: Promise<unknown>[] = [];
  await controller.query('SELECT pg_advisory_lock($1)', [controllerPid]);
  try {
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN
      IF OLD.id='${project.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${controllerPid}); END IF;
      RETURN OLD; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON pm_projects FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    Reflect.set(fs.promises, 'realpath', new Proxy(original, { apply(target, receiver, args) {
      if (watchSecond && String(args[0]) === cwd) earlyLookup.resolve();
      return Reflect.apply(target, receiver, args);
    } }));
    const first = authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' }); requests.push(first);
    await blockedBy(controllerPid);
    await assert.rejects(stat(cwd), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    watchSecond = true;
    const second = authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' }); requests.push(second);
    await earlyLookup.promise; // Metadata discovery may precede the lock; cleanup still waits for the tracker queue.
    watchSecond = false;
    const admission = runSerialized(cwd, async () => {
      queuedWork = true;
      return (await pool.query('SELECT id FROM pm_projects WHERE id=$1', [project.id])).rowCount;
    }, queued.resolve); requests.push(admission);
    await queued.promise;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(queuedWork, false, 'physical admissions must wait through the project-row commit');
    const independent = await authedFetch(server, owner, `/api/projects/${other.id}`, { method: 'DELETE' });
    assert.equal(independent.status, 200, 'an unrelated project must proceed while this deletion is held');
    await controller.query('SELECT pg_advisory_unlock($1)', [controllerPid]);
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 404, 'the waiting delete must refuse the old project after commit');
    assert.equal(await admission, 0, 'queued work must only observe the committed row removal');
    const replacement = await authedFetch(server, owner, '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, prefix: 'serial' }) });
    assert.equal(replacement.status, 201);
    const newProject = (await replacement.json() as { project: { id: string } }).project;
    await createPlainContractTracker(cwd);
    await Promise.all(requests);
    assert.equal((await stat(cwd)).isDirectory(), true, 'the replacement workspace must survive the old delete');
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [newProject.id])).rowCount, 1);
  } finally {
    watchSecond = false;
    await controller.query('SELECT pg_advisory_unlock($1)', [controllerPid]);
    await Promise.allSettled(requests);
    Reflect.set(fs.promises, 'realpath', original);
    try { await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON pm_projects`); await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`); }
    finally { controller.release(); }
  }
});

/** Record exact file bytes and filesystem identities without following any symlink. */
async function storageSnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  /** Include empty directories, leaf links and tracker payloads in the same synthetic corpus. */
  async function visit(directory: string): Promise<void> {
    const info = await lstat(directory, { bigint: true });
    const key = path.relative(root, directory) || '.';
    const stamp = `${info.dev}:${info.ino}`;
    if (info.isSymbolicLink()) result[key] = `link:${stamp}:${await readlink(directory)}`;
    else if (info.isDirectory()) {
      result[key] = `directory:${stamp}`;
      for (const name of (await readdir(directory)).sort()) await visit(path.join(directory, name));
    } else result[key] = `file:${stamp}:${(await readFile(directory)).toString('hex')}`;
  }
  await visit(root);
  return result;
}

/** Share the owned server, row and logical directory for adversarial deletion cases. */
async function deletionStorageTest(t: Parameters<typeof setupProjectsTest>[0]) {
  const context = await setupProjectsTest(t);
  const project = await seedProject(context.owner.id);
  return { ...context, project, cwd: getProjectDir(context.owner.id, project.slug) };
}

/** Pause eviction's third leaf read after admission and the route check, delegating to real lstat. */
function holdEvictionLeaf(leaf: string) {
  const original = fs.promises.lstat, entered = deferred<void>(), released = deferred<void>();
  let reads = 0;
  Reflect.set(fs.promises, 'lstat', new Proxy(original, { async apply(target, receiver, args) {
    if (String(args[0]) === leaf && ++reads === 3) { entered.resolve(); await released.promise; }
    return Reflect.apply(target, receiver, args);
  } }));
  return { entered: entered.promise, release: released.resolve, restore: () => Reflect.set(fs.promises, 'lstat', original) };
}

/** Retarget only after queue/check capture, while eviction's real lstat is awaiting completion. */
test('projects: ancestor retarget during eviction refuses without changing either storage tree and permits retry', async t => {
  const { server, owner, project, cwd } = await deletionStorageTest(t);
  const parent = path.dirname(cwd), originalParent = `${parent}-original`, otherParent = `${parent}-other`;
  await createPlainContractTracker(cwd);
  await rename(parent, originalParent);
  await symlink(originalParent, parent, process.platform === 'win32' ? 'junction' : 'dir');
  const originalDirectory = path.join(originalParent, project.slug), otherDirectory = path.join(otherParent, project.slug);
  const other = await createPlainContractTracker(otherDirectory);
  await other.client.create({ type: 'Task', title: 'Other project must remain byte-identical', body: 'Synthetic eviction retarget proof' });
  const beforeOriginal = await storageSnapshot(originalDirectory), beforeOther = await storageSnapshot(otherDirectory);
  const eviction = holdEvictionLeaf(originalDirectory);
  let deletion: Promise<Response> | undefined;
  try {
    deletion = authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    await eviction.entered;
    await rm(parent); await symlink(otherParent, parent, process.platform === 'win32' ? 'junction' : 'dir');
    eviction.release();
    const response = await deletion;
    assert.deepEqual(await storageSnapshot(otherDirectory), beforeOther, 'the other project and its tracker must remain byte for byte');
    assert.deepEqual(await storageSnapshot(originalDirectory), beforeOriginal, 'refusal must not remove the admitted project either');
    assert.equal(response.status, 409, await response.text());
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [project.id])).rowCount, 1);
    eviction.restore();
    await rm(parent); await symlink(originalParent, parent, process.platform === 'win32' ? 'junction' : 'dir');
    await assertDeletionRemoves(server, owner, project.id, originalDirectory);
    assert.deepEqual(await storageSnapshot(otherDirectory), beforeOther, 'retry must also leave the other tracker unchanged');
  } finally {
    eviction.release(); await deletion;
    eviction.restore();
    await rm(parent, { force: true }); await rename(originalParent, parent);
    await rm(otherParent, { recursive: true, force: true });
  }
});

/** A same-path replacement must not inherit deletion authority from an older leaf inode. */
test('projects: leaf replacement during eviction refuses the new inode and preserves both trackers', async t => {
  const { server, owner, project, cwd } = await deletionStorageTest(t);
  const saved = `${cwd}-saved`;
  await createPlainContractTracker(cwd);
  const eviction = holdEvictionLeaf(cwd);
  let moved = false;
  let deletion: Promise<Response> | undefined;
  try {
    deletion = authedFetch(server, owner, `/api/projects/${project.id}`, { method: 'DELETE' });
    await eviction.entered;
    await rename(cwd, saved); moved = true;
    const replacement = await createPlainContractTracker(cwd);
    await replacement.client.create({ type: 'Task', title: 'Replacement inode must survive' });
    const oldBytes = await storageSnapshot(saved), newBytes = await storageSnapshot(cwd);
    eviction.release();
    const response = await deletion;
    assert.deepEqual(await storageSnapshot(cwd), newBytes);
    assert.deepEqual(await storageSnapshot(saved), oldBytes);
    assert.equal(response.status, 409, await response.text());
    assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [project.id])).rowCount, 1);
  } finally {
    eviction.release(); await deletion;
    eviction.restore();
    if (moved) { await rm(cwd, { recursive: true, force: true }); await rename(saved, cwd); }
  }
});

/** A project entry that is a symlink owns only that link, never the target's files. */
test('projects: deleting a leaf symlink unlinks only the leaf and preserves its target', async t => {
  const { server, owner } = await setupProjectsTest(t);
  const project = await seedProject(owner.id), other = await seedProject(owner.id);
  const target = getProjectDir(owner.id, other.slug), leaf = getProjectDir(owner.id, project.slug);
  const tracker = await createPlainContractTracker(target);
  await tracker.client.create({ type: 'Task', title: 'Symlink target remains unchanged' });
  await symlink(target, leaf, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await storageSnapshot(target);
  await assertDeletionRemoves(server, owner, project.id, leaf);
  assert.deepEqual(await storageSnapshot(target), before);
  assert.equal((await pool.query('SELECT id FROM pm_projects WHERE id=$1', [other.id])).rowCount, 1);
});

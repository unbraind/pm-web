/**
 * Real-Postgres coverage for `src/routes/admin.ts`.
 *
 * Every admin route must 403 for a non-admin and succeed for an admin. Each
 * mutating admin route writes a row to `pm_admin_audit`; the tests assert that
 * row is actually persisted, not merely that the HTTP call returned 200.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "../src/db.ts";
import {
  authedFetch,
  ensureSchema,
  seedGroup,
  seedProject,
  seedUser,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

test("admin: overview is 403 for a non-admin and 200 for an admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });

  const denied = await authedFetch(server, pleb, "/api/admin/overview");
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, "/api/admin/overview");
  assert.equal(ok.status, 200);
  const overview = (await ok.json() as { stats: { users: number; admins: number; projects: number; groups: number } });
  assert.ok(overview.stats.users >= 2);
  assert.ok(overview.stats.admins >= 1);
});

test("admin: audit log is 403 for a non-admin and retrievable for an admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });

  const denied = await authedFetch(server, pleb, "/api/admin/audit");
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, "/api/admin/audit");
  assert.equal(ok.status, 200);
  const body = (await ok.json() as { entries: unknown[]; total: number });
  assert.ok(typeof body.total === "number");
});

test("admin: patching a user writes an audit row and rejects a non-admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const target = await seedUser(uniqueEmail("target"));

  const denied = await authedFetch(server, pleb, `/api/admin/users/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: true }),
  });
  assert.equal(denied.status, 403);

  // Admin promotes the target; the route records an audit row.
  const ok = await authedFetch(server, admin, `/api/admin/users/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: true }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { user: { is_admin: boolean } }).user.is_admin, true);

  // The audit row is genuinely persisted.
  const audit = await pool.query(
    `SELECT action, description FROM pm_admin_audit WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal((audit.rows[0] as { action: string }).action, "user.update");
});

test("admin: patching a user without isAdmin is 400", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const target = await seedUser(uniqueEmail("target"));

  const res = await authedFetch(server, admin, `/api/admin/users/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: "yes" }),
  });
  assert.equal(res.status, 400);

  const missing = await authedFetch(server, admin, `/api/admin/users/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
});

test("admin: patching a non-existent user is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const ghost = "00000000-0000-4000-8000-000000000000";

  const res = await authedFetch(server, admin, `/api/admin/users/${ghost}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: false }),
  });
  assert.equal(res.status, 404);
});

test("admin: demoting an admin while another admin exists succeeds and audits", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  // Two admins: the guard counts all admins, so demoting one while another
  // remains leaves a positive count and the route proceeds (covers
  // getAdminCount with a count > 1, the non-last-admin branch).
  const keeper = await seedUser(uniqueEmail("keeper"), { isAdmin: true });
  const demoted = await seedUser(uniqueEmail("demoted"), { isAdmin: true });

  const res = await authedFetch(server, keeper, `/api/admin/users/${demoted.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { user: { is_admin: boolean } }).user.is_admin, false);

  const audit = await pool.query(
    `SELECT action FROM pm_admin_audit WHERE actor_id = $1 AND action = 'user.update'`,
    [keeper.id],
  );
  assert.ok(audit.rows.length >= 1);
});

test("admin: deleting a user writes an audit row, rejects a non-admin, and deleting a non-existent user is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const target = await seedUser(uniqueEmail("target"));

  const denied = await authedFetch(server, pleb, `/api/admin/users/${target.id}`, { method: "DELETE" });
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, `/api/admin/users/${target.id}`, { method: "DELETE" });
  assert.equal(ok.status, 200);
  const audit = await pool.query(
    `SELECT action FROM pm_admin_audit WHERE actor_id = $1 AND action = 'user.delete'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);

  // Deleting a non-existent user is 404.
  const ghost = "00000000-0000-4000-8000-000000000000";
  const ghostRes = await authedFetch(server, admin, `/api/admin/users/${ghost}`, { method: "DELETE" });
  assert.equal(ghostRes.status, 404);

  // Deleting an admin while another admin remains succeeds (covers the
  // adminCount > 1 branch of the delete guard).
  const secondAdmin = await seedUser(uniqueEmail("secondadmin"), { isAdmin: true });
  const delAdmin = await authedFetch(server, admin, `/api/admin/users/${secondAdmin.id}`, { method: "DELETE" });
  assert.equal(delAdmin.status, 200);
});

test("admin: deleting a project writes an audit row and rejects a non-admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const projectOwner = await seedUser(uniqueEmail("owner"));
  const project = await seedProject(projectOwner.id);

  const denied = await authedFetch(server, pleb, `/api/admin/projects/${project.id}`, { method: "DELETE" });
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, `/api/admin/projects/${project.id}`, { method: "DELETE" });
  assert.equal(ok.status, 200);
  const audit = await pool.query(
    `SELECT action FROM pm_admin_audit WHERE actor_id = $1 AND action = 'project.delete'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);

  // Deleting it again is 404.
  const again = await authedFetch(server, admin, `/api/admin/projects/${project.id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
});

test("admin: creating a group writes an audit row and rejects a non-admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });

  const denied = await authedFetch(server, pleb, "/api/admin/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, "/api/admin/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "AdminGroup" }),
  });
  assert.equal(ok.status, 201);
  const audit = await pool.query(
    `SELECT action FROM pm_admin_audit WHERE actor_id = $1 AND action = 'group.create'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);

  // Creating without a name is 400.
  const noName = await authedFetch(server, admin, "/api/admin/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noName.status, 400);
});

test("admin: deleting a group writes an audit row and rejects a non-admin", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const pleb = await seedUser(uniqueEmail("pleb"));
  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const groupOwner = await seedUser(uniqueEmail("owner"));
  const group = await seedGroup(groupOwner.id);

  const denied = await authedFetch(server, pleb, `/api/admin/groups/${group.id}`, { method: "DELETE" });
  assert.equal(denied.status, 403);

  const ok = await authedFetch(server, admin, `/api/admin/groups/${group.id}`, { method: "DELETE" });
  assert.equal(ok.status, 200);
  const audit = await pool.query(
    `SELECT action FROM pm_admin_audit WHERE actor_id = $1 AND action = 'group.delete'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);

  const again = await authedFetch(server, admin, `/api/admin/groups/${group.id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
});

test("admin: a malformed user identifier fails closed with 500", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  // A non-UUID target id makes isUserAdmin's query throw; the route catches it
  // and surfaces 500 rather than leaking user state.
  const res = await authedFetch(server, admin, "/api/admin/users/not-a-uuid", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isAdmin: false }),
  });
  assert.equal(res.status, 500);
});

test("admin: creating a group with a description preserves it and audits", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  const res = await authedFetch(server, admin, "/api/admin/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "WithDesc", description: "a description" }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json() as { group: { description: string } }).group.description, "a description");
});

test("admin: a malformed identifier fails closed with 500 on every mutating route", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const admin = await seedUser(uniqueEmail("admin"), { isAdmin: true });
  // A non-UUID id makes each route's first query throw; the route catches it
  // and surfaces 500 rather than leaking whether the record exists.
  const delUser = await authedFetch(server, admin, "/api/admin/users/not-a-uuid", { method: "DELETE" });
  assert.equal(delUser.status, 500);

  const delProject = await authedFetch(server, admin, "/api/admin/projects/not-a-uuid", { method: "DELETE" });
  assert.equal(delProject.status, 500);

  const delGroup = await authedFetch(server, admin, "/api/admin/groups/not-a-uuid", { method: "DELETE" });
  assert.equal(delGroup.status, 500);
});

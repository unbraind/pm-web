/**
 * Real-Postgres coverage for `src/routes/auth.ts`.
 *
 * Exercises register, duplicate-email rejection, login success, wrong
 * password, unknown email, `/me`, logout, the profile/password/github-token
 * mutations, and asserts the `pm_token` session cookie is `HttpOnly`. Passwords
 * are hashed through the real `bcryptjs` path so the login comparisons exercise
 * production code rather than a sentinel.
 */

import assert from "node:assert/strict";
import test from "node:test";

import bcrypt from "bcryptjs";

import { pool } from "../src/db.ts";
import {
  authCookie,
  authHeaders,
  ensureSchema,
  seedUser,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

/**
 * The raw password used by the login tests. Seeded users store a real bcrypt
 * hash of this value so `bcrypt.compare` in the login route runs against a
 * genuine hash, not the `"x"` sentinel used by the access-control seeders.
 */
const PASSWORD = "correct-horse-9";

test("auth: register sets an HttpOnly pm_token cookie and returns the user", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const email = uniqueEmail("newuser");
  const res = await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, displayName: "New User" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json() as { token: string; user: { email: string; is_admin: boolean } });
  assert.equal(body.user.email, email.toLowerCase());
  assert.ok(body.token, "register must return a bearer token");

  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /pm_token=/, "the session cookie must be named pm_token");
  assert.match(setCookie, /HttpOnly/i, "the pm_token cookie must be HttpOnly");
});

test("auth: register rejects a duplicate email with 409", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const email = uniqueEmail("dup");
  await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  const again = await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(again.status, 409);
});

test("auth: register validates email and password shape", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const missing = await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x@y.z" }),
  });
  assert.equal(missing.status, 400);

  const short = await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "short@e.test", password: "1234567" }),
  });
  assert.equal(short.status, 400);

  const badEmail = await fetch(server.url("/api/auth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: PASSWORD }),
  });
  assert.equal(badEmail.status, 400);
});

test("auth: login succeeds, wrong password is 401, unknown email is 401", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  // Seed a user with a real bcrypt hash so the login route's bcrypt.compare
  // runs against genuine material.
  const email = uniqueEmail("login");
  const hash = await bcrypt.hash(PASSWORD, 12);
  await pool.query(
    `INSERT INTO pm_users (email, password_hash) VALUES ($1, $2)`,
    [email.toLowerCase(), hash],
  );

  const ok = await fetch(server.url("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json() as { token: string; user: { email: string } });
  assert.equal(okBody.user.email, email.toLowerCase());
  assert.ok(okBody.token);
  assert.match(ok.headers.get("set-cookie") ?? "", /HttpOnly/i);

  const wrong = await fetch(server.url("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-password-1" }),
  });
  assert.equal(wrong.status, 401);

  const unknown = await fetch(server.url("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nope@nowhere.test", password: PASSWORD }),
  });
  assert.equal(unknown.status, 401);

  const missing = await fetch(server.url("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(missing.status, 400);
});

test("auth: /me returns the authenticated user, and 401 without a token", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const user = await seedUser(uniqueEmail("me"), { displayName: "Me" });

  // No cookie → 401.
  const unauthed = await fetch(server.url("/api/auth/me"));
  assert.equal(unauthed.status, 401);

  const ok = await fetch(server.url("/api/auth/me"), {
    headers: { cookie: authCookie(user) },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { user: { email: string } }).user.email, user.email);
});

test("auth: /me for a user absent from the database is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  // A valid JWT whose subject is no longer in pm_users exercises the not-found
  // arm of /me (the user record was deleted out from under the session).
  const ghost = await seedUser(uniqueEmail("ghost"));
  await pool.query(`DELETE FROM pm_users WHERE id = $1`, [ghost.id]);
  const res = await fetch(server.url("/api/auth/me"), {
    headers: { cookie: authCookie(ghost) },
  });
  assert.equal(res.status, 404);
});

test("auth: change-password for a user absent from the database is 404", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const ghost = await seedUser(uniqueEmail("ghostchpw"));
  await pool.query(`DELETE FROM pm_users WHERE id = $1`, [ghost.id]);
  const res = await fetch(server.url("/api/auth/change-password"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(ghost) },
    body: JSON.stringify({ currentPassword: "x", newPassword: "new-password-9" }),
  });
  assert.equal(res.status, 404);
});


test("auth: logout requires authentication and clears the pm_token cookie", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const unauthenticated = await fetch(server.url("/api/auth/logout"), { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.doesNotMatch(
    unauthenticated.headers.get("set-cookie") ?? "",
    /pm_token=/,
    "an unauthenticated cross-site request cannot clear the target-origin session",
  );

  const user = await seedUser(uniqueEmail("logout"));
  const res = await fetch(server.url("/api/auth/logout"), {
    method: "POST",
    headers: authHeaders(user),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /pm_token=/);
  // clearCookie emits an expiry in the past or Max-Age=0.
  assert.match(setCookie, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
});

test("auth: PATCH /profile updates display name", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const user = await seedUser(uniqueEmail("profile"));
  const res = await fetch(server.url("/api/auth/profile"), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(user) },
    body: JSON.stringify({ displayName: "Updated Name" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { user: { display_name: string } }).user.display_name, "Updated Name");
});

test("auth: PATCH /profile with an empty display name clears it", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  // Seed a non-empty name so the assertion can distinguish "cleared" from
  // "already null".
  const user = await seedUser(uniqueEmail("profile-clear"), { displayName: "Keepfirst" });
  const res = await fetch(server.url("/api/auth/profile"), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(user) },
    // An empty display name must resolve to null in the route (`name?.trim() || null`)
    // and clear the column, rather than storing a blank string.
    body: JSON.stringify({ displayName: "   " }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { user: { display_name: string | null } }).user.display_name, null);
});

test("auth: change-password verifies the current password and replaces it", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const email = uniqueEmail("chpw");
  const hash = await bcrypt.hash(PASSWORD, 12);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO pm_users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [email.toLowerCase(), hash],
  );
  const userId = (inserted.rows[0] as { id: string }).id;

  // Wrong current password is rejected.
  const wrong = await fetch(server.url("/api/auth/change-password"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders({ id: userId, email }) },
    body: JSON.stringify({ currentPassword: "wrong-password-1", newPassword: "new-password-9" }),
  });
  assert.equal(wrong.status, 401);

  // Missing fields is 400.
  const missing = await fetch(server.url("/api/auth/change-password"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders({ id: userId, email }) },
    body: JSON.stringify({ currentPassword: PASSWORD }),
  });
  assert.equal(missing.status, 400);

  // Too-short new password is 400.
  const short = await fetch(server.url("/api/auth/change-password"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders({ id: userId, email }) },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "1234567" }),
  });
  assert.equal(short.status, 400);

  // Correct current password succeeds and the hash is replaced.
  const ok = await fetch(server.url("/api/auth/change-password"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders({ id: userId, email }) },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "new-password-9" }),
  });
  assert.equal(ok.status, 200);

  const stored = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM pm_users WHERE id = $1`,
    [userId],
  );
  assert.notEqual((stored.rows[0] as { password_hash: string }).password_hash, hash);
  assert.equal(await bcrypt.compare("new-password-9", (stored.rows[0] as { password_hash: string }).password_hash), true);
});

test("auth: PATCH /github-token saves and clears the encrypted token", async (t) => {
  await ensureSchema();
  const server = await startApp();
  t.after(() => server.close());

  const user = await seedUser(uniqueEmail("ghtoken"));

  const save = await fetch(server.url("/api/auth/github-token"), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(user) },
    body: JSON.stringify({ token: "ghp_secret-value" }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json() as { ok: boolean; hasToken: boolean }).hasToken, true);

  const stored = await pool.query<{ github_token: string | null }>(
    `SELECT github_token FROM pm_users WHERE id = $1`,
    [user.id],
  );
  const encrypted = (stored.rows[0] as { github_token: string | null }).github_token;
  assert.ok(encrypted, "the token must be persisted");
  assert.ok(!encrypted!.includes("ghp_secret-value"), "the stored value must be encrypted, not plaintext");

  // Clearing the token.
  const clear = await fetch(server.url("/api/auth/github-token"), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(user) },
    body: JSON.stringify({ token: "" }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json() as { hasToken: boolean }).hasToken, false);
  const after = await pool.query<{ github_token: string | null }>(
    `SELECT github_token FROM pm_users WHERE id = $1`,
    [user.id],
  );
  assert.equal((after.rows[0] as { github_token: string | null }).github_token, null);
});

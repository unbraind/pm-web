/**
 * Real-Postgres test harness for the pm-web route layer.
 *
 * This module is the shared backbone for the access-control route tests. It
 * starts the real Express application built by {@link createApp} on an
 * ephemeral loopback port, seeds state directly into PostgreSQL through the
 * shipped {@link pool}, and issues authenticated HTTP requests carrying the
 * `pm_token` session cookie. It deliberately contains **no `pool.query` stub**
 * and **no `as any`**: every assertion the route tests make runs against a
 * genuine database and a genuine HTTP stack, so a wrong JOIN or a missing
 * ownership predicate fails the test instead of being masked by a hand-rolled
 * fake.
 *
 * Concurrency contract: `node --test` may run several test files concurrently
 * against the same throwaway database (each file is its own worker process).
 * Every seeded email, project slug, group name, issuer and subject is therefore
 * suffixed with a per-process {@link RUN_ID} plus a monotonic counter so that
 * two workers can never collide on a `UNIQUE` constraint. Tests within a single
 * file run sequentially, so the same counter is safe to share across them.
 */

import http from "node:http";
import type { Express } from "express";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/auth.ts";
import { initSchema, pool } from "../../src/db.ts";

/**
 * A per-process run id, mixed into every seeded identifier so that concurrent
 * test files sharing one database never collide on a unique constraint.
 *
 * `process.hrtime.bigint()` is monotonic but resets per process, so two workers
 * booting together could read the same value; folding in `Math.random()` makes
 * a collision astronomically unlikely. Base-36 keeps it short for readable
 * debug output when a test fails.
 */
export const RUN_ID =
  process.hrtime.bigint().toString(36) + Math.random().toString(36).slice(2);

/** A seeded user, carrying the fields the tests need to build requests. */
export interface SeedUser {
  /** UUID primary key of the `pm_users` row. */
  readonly id: string;
  /** Lowercased email used both for lookups and the JWT payload. */
  readonly email: string;
}

/** A seeded project, carrying the fields the tests need to build paths. */
export interface SeedProject {
  /** UUID primary key of the `pm_projects` row. */
  readonly id: string;
  /** Project slug, unique per owning user. */
  readonly slug: string;
}

/** A seeded group, carrying the fields the tests need to build paths. */
export interface SeedGroup {
  /** UUID primary key of the `pm_groups` row. */
  readonly id: string;
}

/**
 * A handle to the running app server, exposing the resolved port and a
 * `close()` that tears the listener down.
 */
export interface AppServer {
  /** The ephemeral TCP port the server is listening on. */
  readonly port: number;
  /**
   * Builds an absolute loopback URL for a relative path, used as the fetch
   * target so tests never hardcode a port.
   */
  url(path: string): string;
  /** Stops the underlying `http.Server` listener. */
  close(): Promise<void>;
}

/** Row shape returned by a `pm_users` insert/select used by the seeders. */
interface UserRow {
  id: string;
  email: string;
}

/** Row shape returned by a `pm_projects` insert used by the seeders. */
interface ProjectRow {
  id: string;
  slug: string;
}

/** Row shape returned by a `pm_groups` insert used by the seeders. */
interface GroupRow {
  id: string;
}

let counter = 0;

/**
 * Returns a process-unique token appended to seeded identifiers, advancing a
 * monotonic counter so every call within a file yields a distinct value.
 */
function next(): string {
  counter += 1;
  return `${RUN_ID}-${counter.toString(36)}`;
}

/**
 * Builds a globally-unique lowercased email from a human-readable local part,
 * e.g. `uniqueEmail("owner")` → `owner-<run>-<n>@e.test`.
 */
export function uniqueEmail(localPart: string): string {
  return `${localPart}-${next()}@e.test`;
}

/**
 * Builds a globally-unique project slug from a human-readable stem, lowercased
 * and hyphen-joined to satisfy the `pm_projects.slug` format.
 */
export function uniqueSlug(stem: string): string {
  return `${stem}-${next()}`;
}

/**
 * Arbitrary but fixed key identifying the schema-creation advisory lock.
 *
 * Any constant works as long as every worker agrees on it; it only has to avoid
 * colliding with another advisory lock in the same database, and this test
 * database has no other users.
 */
const SCHEMA_LOCK_KEY = 0x706d7765;

/**
 * Whether the parent test wrapper completed schema initialization before this
 * worker was spawned. The local transition also prevents repeated DDL within a
 * directly-invoked test process that does not use the wrapper.
 */
let schemaReady = process.env.PM_WEB_TEST_SCHEMA_READY === "true";

/**
 * Ensures the full pm-web schema exists, serialising concurrent creators.
 *
 * `initSchema` is idempotent in the single-writer sense — it is built from
 * `CREATE TABLE IF NOT EXISTS` and friends — but that is **not** the same as
 * being safe under concurrency. `CREATE TABLE IF NOT EXISTS` is not atomic
 * against a concurrent identical CREATE: two `node --test` worker processes can
 * both pass the existence check and then collide inside PostgreSQL's own
 * catalog, failing with `duplicate key value violates unique constraint
 * "pg_class_relname_nsp_index"` (or `pg_type_typname_nsp_index`). The same race
 * applies to `CREATE INDEX IF NOT EXISTS`.
 *
 * This is easy to miss because it is timing-dependent: it passed locally and on
 * one CI Node version while failing on another, purely on scheduling. A session
 * advisory lock makes the whole create-or-skip sequence mutually exclusive, so
 * exactly one worker performs the DDL and the rest wait and then find the tables
 * already present.
 *
 * The lock is taken on a dedicated client rather than through `pool.query`,
 * because advisory locks are scoped to a *session*: issued through the pool, the
 * lock and its release could land on two different connections, releasing
 * nothing and holding a lock forever. `initSchema` itself still runs against the
 * pool, which is correct — mutual exclusion comes from every worker having to
 * hold this lock before it may call `initSchema` at all.
 */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
    try {
      await initSchema();
      schemaReady = true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Starts the real Express app from {@link createApp} on an ephemeral
 * loopback port and returns a handle for issuing requests. The caller is
 * responsible for closing the server (typically via `t.after`).
 *
 * `createApp` starts no watchers and holds no event-loop handles, so closing
 * the `http.Server` returned here is all the cleanup a test needs. The pool
 * itself is never ended from a test — each file is its own process and exits
 * naturally once its tests finish.
 */
export async function startApp(): Promise<AppServer> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Inserts a `pm_users` row and returns its id and email. The password hash is
 * a constant sentinel (`"x"`); access-control tests never authenticate by
 * password against a seeded user (the login tests hash a real password
 * separately), so a non-verifiable sentinel is both sufficient and fast.
 *
 * @param email  Lowercased email to insert. Omit to get a globally-unique one.
 * @param flags  Optional `is_admin` / `display_name` overrides.
 */
export async function seedUser(
  email?: string,
  flags?: { isAdmin?: boolean; displayName?: string },
): Promise<SeedUser> {
  const resolvedEmail = (email ?? uniqueEmail("user")).toLowerCase();
  const result = await pool.query<UserRow>(
    `INSERT INTO pm_users (email, password_hash, display_name, is_admin)
     VALUES ($1, 'x', $2, $3) RETURNING id, email`,
    [resolvedEmail, flags?.displayName ?? null, flags?.isAdmin ?? false],
  );
  const row = result.rows[0] as UserRow;
  return { id: row.id, email: row.email };
}

/**
 * Inserts a `pm_projects` row owned by `ownerId` and returns its id and slug.
 *
 * @param ownerId  UUID of the owning `pm_users` row.
 * @param slug     Project slug. Omit to get a globally-unique one.
 * @param fields   Optional `name` / `prefix` / `description` overrides.
 */
export async function seedProject(
  ownerId: string,
  slug?: string,
  fields?: { name?: string; prefix?: string; description?: string },
): Promise<SeedProject> {
  const resolvedSlug = slug ?? uniqueSlug("slug");
  const result = await pool.query<ProjectRow>(
    `INSERT INTO pm_projects (user_id, name, slug, description, prefix)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, slug`,
    [
      ownerId,
      fields?.name ?? "P",
      resolvedSlug,
      fields?.description ?? "",
      fields?.prefix ?? "p",
    ],
  );
  const row = result.rows[0] as ProjectRow;
  return { id: row.id, slug: row.slug };
}

/**
 * Inserts a `pm_groups` row owned by `ownerId` and adds the owner as a member
 * with role `'owner'`, mirroring the production create-group route so the
 * owner appears in their own member list.
 *
 * @param ownerId  UUID of the owning `pm_users` row.
 * @param name     Group name. Omit to get a globally-unique one.
 */
export async function seedGroup(
  ownerId: string,
  name?: string,
  description = "",
): Promise<SeedGroup> {
  const resolvedName = name ?? uniqueSlug("group");
  const groupResult = await pool.query<GroupRow>(
    `INSERT INTO pm_groups (owner_id, name, description)
     VALUES ($1, $2, $3) RETURNING id`,
    [ownerId, resolvedName, description],
  );
  const row = groupResult.rows[0] as GroupRow;
  await pool.query(
    `INSERT INTO pm_group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [row.id, ownerId],
  );
  return { id: row.id };
}

/**
 * Adds a user to a group, defaulting to the `'member'` role. Idempotent per
 * (group, user) via `ON CONFLICT` so re-adding simply updates the role.
 */
export async function addGroupMember(
  groupId: string,
  userId: string,
  role?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO pm_group_members (group_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [groupId, userId, role ?? "member"],
  );
}

/**
 * Shares a project with an individual user at a given permission, returning
 * the share id. Idempotent via `ON CONFLICT` so re-sharing updates permission.
 */
export async function seedUserShare(
  projectId: string,
  userId: string,
  permission: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pm_project_shares (project_id, shared_with_user_id, permission)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, shared_with_user_id) DO UPDATE SET permission = EXCLUDED.permission
     RETURNING id`,
    [projectId, userId, permission],
  );
  return (result.rows[0] as { id: string }).id;
}

/**
 * Shares a project with a group at a given permission, returning the share
 * id. Idempotent via `ON CONFLICT` so re-sharing updates permission.
 */
export async function seedGroupShare(
  projectId: string,
  groupId: string,
  permission: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pm_project_shares (project_id, shared_with_group_id, permission)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, shared_with_group_id) DO UPDATE SET permission = EXCLUDED.permission
     RETURNING id`,
    [projectId, groupId, permission],
  );
  return (result.rows[0] as { id: string }).id;
}

/**
 * Builds the `pm_token` cookie value used to authenticate a request as `user`.
 * The cookie is signed with the test-runner-supplied `JWT_SECRET`, the same
 * secret the app uses to verify tokens, so the resulting request authenticates
 * through the real `requireAuth` middleware.
 */
export function authCookie(user: SeedUser): string {
  return `pm_token=${signToken({ userId: user.id, email: user.email })}; csrf_token=pm-web-test-csrf`;
}

/**
 * Build the complete cookie-authenticated header pair used by mutating route
 * tests. The CSRF value appears in both the readable cookie and request header,
 * matching the browser client's double-submit contract.
 */
export function authHeaders(user: SeedUser): Record<string, string> {
  return {
    cookie: authCookie(user),
    "x-csrf-token": "pm-web-test-csrf",
  };
}

/**
 * Issues an authenticated `fetch` against the running server as `user`,
 * attaching the `pm_token` cookie and forwarding any caller-supplied init
 * (method, body, headers). Callers may override the cookie header via `init`
 * to model an unauthenticated or cross-user request.
 */
export async function authedFetch(
  server: AppServer,
  user: SeedUser,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  // Only supply the session cookie when the caller has not set one. Overwriting
  // unconditionally would silently discard a deliberate override, making the
  // documented unauthenticated and alternate-session cases impossible to express
  // and quietly turning such a test into another authenticated request.
  if (!headers.has("cookie")) headers.set("cookie", authCookie(user));
  if (!headers.has("x-csrf-token")) headers.set("x-csrf-token", "pm-web-test-csrf");
  return fetch(server.url(path), { ...init, headers });
}

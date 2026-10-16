/** Real HTTP authorization and integrity checks for the PM command router. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pool } from "../src/db.ts";
import { connectLiveSSE } from "./helpers/live-sse.ts";
import {
  addGroupMember, authCookie, authedFetch, ensureSchema, seedGroup,
  seedGroupShare, seedProject, seedUser, seedUserShare, startApp,
  type SeedUser,
} from "./helpers/pg-harness.ts";

const execFileAsync = promisify(execFile);

/** Build an owned tracker and accounts whose access exists only in PostgreSQL. */
async function commandFixture(t: test.TestContext) {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-command-access-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const owner = await seedUser();
  const collaborator = await seedUser();
  const stranger = await seedUser();
  const project = await seedProject(owner.id, undefined, { prefix: "ac" });
  const server = await startApp();
  t.after(async () => {
    await server.close();
    await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner.id, collaborator.id, stranger.id]]);
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });
  const pmRoot = path.join(root, owner.id, project.slug, ".agents", "pm");
  await mkdir(path.dirname(pmRoot), { recursive: true });
  await execFileAsync(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "ac", "--pm-path", pmRoot]);
  const base = `/api/projects/${project.id}/pm`;
  /** Send a JSON command using the real authentication and CSRF middleware. */
  const request = (user: SeedUser, route: string, method = "GET", body?: object) => authedFetch(server, user, `${base}/${route}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await request(owner, "create", "POST", { title: "Protected command item", type: "Task" });
  assert.equal(created.status, 201, await created.clone().text());
  const id = (await created.json() as { id: string }).id;
  assert.ok(id);
  return { root, pmRoot, owner, collaborator, stranger, project, server, base, request, id };
}

/** Read the persisted item through the owner's authenticated HTTP route. */
async function persistedItem(f: Awaited<ReturnType<typeof commandFixture>>): Promise<{ title: string; description: string }> {
  const response = await f.request(f.owner, `get/${f.id}`);
  assert.equal(response.status, 200);
  return (await response.json() as { item: { title: string; description: string } }).item;
}

/** Snapshot durable tracker documents so refused commands cannot silently write. */
async function trackerDocuments(pmRoot: string): Promise<Record<string, string>> {
  const documents: Record<string, string> = {};
  for (const entry of await readdir(pmRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(toon|jsonl|json)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    documents[path.relative(pmRoot, file)] = await readFile(file, "utf8");
  }
  return documents;
}

/** Commands span item, plan, schema, graph, collection and package mutations. */
function mutations(id: string): ReadonlyArray<readonly [string, string, object]> {
  return [
    ["POST", "create", { title: "Unauthorized item" }],
    ["PATCH", `update/${id}`, { title: "Unauthorized title" }],
    ["POST", `close/${id}`, { reason: "Unauthorized close" }],
    ["DELETE", `delete/${id}`, {}],
    ...["comments", "notes", "append", "learnings"].map((route) => ["POST", `${route}/${id}`, { text: "Unauthorized text" }] as const),
    ...["claim", "release", "start-task", "pause-task"].map((route) => ["POST", `${route}/${id}`, {}] as const),
    ["POST", `close-task/${id}`, { reason: "Unauthorized transition" }],
    ["POST", `restore/${id}`, { target: "1" }],
    ["POST", `files/${id}`, { path: "README.md" }],
    ["POST", `docs/${id}`, { path: "README.md" }],
    ["POST", `tests/${id}`, { command: "node --version" }],
    ["POST", `deps/${id}`, { targetId: id }], ["DELETE", `deps/${id}`, { targetId: id }],
    ["POST", "rel", { from: id, to: id }], ["DELETE", "rel", { from: id, to: id }],
    ["POST", "schema/add-type", { name: "Unauthorized", folder: "unauthorized" }],
    ["POST", `items/${id}/history-repair`, { dryRun: true }],
    ["POST", "plan", { title: "Unauthorized plan" }],
    ["PATCH", `plan/${id}`, { title: "Unauthorized plan edit" }], ["DELETE", `plan/${id}`, {}],
    ["POST", `plan/${id}/steps`, { title: "Unauthorized step" }],
    ["PATCH", `plan/${id}/steps/1`, { title: "Unauthorized step edit" }],
    ["DELETE", `plan/${id}/steps/1`, {}],
    ...["complete", "block", "reorder"].map((action) => ["POST", `plan/${id}/steps/1/${action}`, { reason: "Unauthorized", position: 1 }] as const),
    ...["approve", "materialize", "link"].map((action) => ["POST", `plan/${id}/${action}`, { step: "1", itemId: id }] as const),
    ["DELETE", `plan/${id}/link`, { step: "1", itemId: id }],
    ["PATCH", "config/definition-of-done", { value: "Unauthorized policy" }],
    ...["graph/provision", "graph/sync", "graph/query", "reindex", "normalize", "test-all", "gc", "upgrade"].map((route) => ["POST", route, {}] as const),
    ["POST", "import", { data: "[]", format: "json" }],
    ["POST", "update-many", { status: "closed" }], ["POST", "close-many", { reason: "Unauthorized bulk close" }],
  ];
}

test("every mutation family refuses view-only and foreign users without changing tracker or grants", async (t) => {
  const f = await commandFixture(t);
  await seedUserShare(f.project.id, f.collaborator.id, "view");
  const documents = await trackerDocuments(f.pmRoot);
  const grants = await pool.query("SELECT * FROM pm_project_shares WHERE project_id = $1", [f.project.id]);
  for (const [headers, error] of [
    [{}, "Authentication required"],
    [{ authorization: "Bearer synthetic-invalid-token" }, "Invalid or expired token"],
  ] as const) {
    const unauthorized = await fetch(f.server.url(`${f.base}/get/${f.id}`), { headers });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error });
  }
  for (const [user, status, error] of [
    [f.collaborator, 403, "This project is shared as view-only."],
    [f.stranger, 404, "Project not found"],
  ] as const) {
    for (const [method, route, body] of mutations(f.id)) {
      const response = await f.request(user, route, method, body);
      assert.equal(response.status, status, `${method} ${route}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), { error });
    }
  }
  assert.deepEqual(await trackerDocuments(f.pmRoot), documents);
  assert.deepEqual((await pool.query("SELECT * FROM pm_project_shares WHERE project_id = $1", [f.project.id])).rows, grants.rows);
  const project = await pool.query<{ user_id: string }>("SELECT user_id FROM pm_projects WHERE id = $1", [f.project.id]);
  assert.equal(project.rows[0].user_id, f.owner.id);
  for (const route of [`get/${f.id}`, "schema", "board", "list", "list-all", "search?q=protected", "calendar", "calendar.ics", "stats", "context", "events", "presence", "config", "templates", "guide", "graph"]) {
    const denied = await f.request(f.stranger, route);
    assert.equal(denied.status, 404, route);
    assert.deepEqual(await denied.json(), { error: "Project not found" });
  }
});

test("cookie-authenticated commands reject missing, mismatched and cross-origin CSRF before writing", async (t) => {
  const f = await commandFixture(t);
  const before = await trackerDocuments(f.pmRoot);
  for (const [method, route, body] of mutations(f.id)) {
    const blocked = await fetch(f.server.url(`${f.base}/${route}`), {
      method, headers: { cookie: authCookie(f.owner), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(blocked.status, 403, route);
    assert.deepEqual(await blocked.json(), { error: "Cross-origin request blocked" });
  }
  const csrfHeaders: Record<string, string>[] = [
    { "x-csrf-token": "wrong" },
    { "x-csrf-token": "pm-web-test-csrf", origin: "https://foreign.example", "sec-fetch-site": "same-site" },
    { "x-csrf-token": "pm-web-test-csrf", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of csrfHeaders) {
    const blocked = await fetch(f.server.url(`${f.base}/update/${f.id}`), {
      method: "PATCH", headers: { cookie: authCookie(f.owner), "content-type": "application/json", ...headers },
      body: JSON.stringify({ title: "CSRF title" }),
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: "Cross-origin request blocked" });
  }
  assert.deepEqual(await trackerDocuments(f.pmRoot), before);
  const keys = await pool.query("SELECT id FROM pm_idempotency_keys WHERE user_id = $1", [f.owner.id]);
  assert.deepEqual(keys.rows, []);
  assert.equal((await f.request(f.owner, `get/${f.id}`)).status, 200);
});

for (const directPermission of ["view", "edit"]) {
  test(`a direct ${directPermission} grant and group ${directPermission === "edit" ? "view" : "edit"} grant retain effective edit access`, async (t) => {
    const f = await commandFixture(t);
    const group = await seedGroup(f.owner.id);
    await addGroupMember(group.id, f.collaborator.id);
    await seedGroupShare(f.project.id, group.id, directPermission === "edit" ? "view" : "edit");
    await seedUserShare(f.project.id, f.collaborator.id, directPermission);
    const listed = await authedFetch(f.server, f.collaborator, "/api/projects");
    assert.equal(listed.status, 200);
    const projects = (await listed.json() as { projects: Array<{ id: string; permission: string }> }).projects;
    assert.equal(projects.find((project) => project.id === f.project.id)?.permission, "edit");
    const updated = await f.request(f.collaborator, `update/${f.id}`, "PATCH", { title: "Authorized through strongest grant" });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await persistedItem(f)).title, "Authorized through strongest grant");
    const permissions = await pool.query<{ permission: string }>("SELECT permission FROM pm_project_shares WHERE project_id = $1", [f.project.id]);
    assert.deepEqual(permissions.rows.map((row) => row.permission).sort(), ["edit", "view"]);
  });
}

test("group membership grants view and edit access and its removal revokes command access", async (t) => {
  const f = await commandFixture(t);
  const group = await seedGroup(f.owner.id);
  await seedGroupShare(f.project.id, group.id, "view");
  assert.equal((await f.request(f.collaborator, `get/${f.id}`)).status, 404);
  await addGroupMember(group.id, f.collaborator.id);
  assert.equal((await f.request(f.collaborator, `get/${f.id}`)).status, 200);
  assert.equal((await f.request(f.collaborator, `update/${f.id}`, "PATCH", { title: "Blocked group edit" })).status, 403);
  await seedGroupShare(f.project.id, group.id, "edit");
  assert.equal((await f.request(f.collaborator, `update/${f.id}`, "PATCH", { title: "Allowed group edit" })).status, 200);
  await pool.query("DELETE FROM pm_group_members WHERE group_id = $1 AND user_id = $2", [group.id, f.collaborator.id]);
  for (const [method, route, body] of [["GET", `get/${f.id}`, undefined], ["PATCH", `update/${f.id}`, { title: "Revoked edit" }]] as const) {
    const denied = await f.request(f.collaborator, route, method, body);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "Project not found" });
  }
  assert.deepEqual((await pool.query("SELECT user_id FROM pm_group_members WHERE group_id = $1 ORDER BY user_id", [group.id])).rows, [{ user_id: f.owner.id }]);
  assert.equal((await persistedItem(f)).title, "Allowed group edit");
});

test("concurrent users commit distinct fields, ledger outcomes and matching SSE updates", async (t) => {
  const f = await commandFixture(t);
  await seedUserShare(f.project.id, f.collaborator.id, "edit");
  const stream = await connectLiveSSE(f.server, f.collaborator, f.project.id);
  try {
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all([f.owner, f.collaborator].map((user, index) => authedFetch(f.server, user, `${f.base}/update/${f.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": keys[index] },
      body: JSON.stringify(index === 0 ? { title: "Owner concurrent title", message: "owner write" } : { description: "Collaborator concurrent description", message: "collaborator write" }),
    })));
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    await stream.waitFor((events) => events.filter((event) => event.type === "item-updated").length === 2);
    assert.deepEqual(new Set(stream.events.filter((event) => event.type === "item-updated").map((event) => event.data.userId)), new Set([f.owner.id, f.collaborator.id]));
    const item = await persistedItem(f);
    assert.equal(item.title, "Owner concurrent title");
    assert.equal(item.description, "Collaborator concurrent description");
    const ledger = await pool.query<{ user_id: string; status_code: number; outcome_state: string }>(
      "SELECT user_id, status_code, outcome_state FROM pm_idempotency_keys WHERE idempotency_key = ANY($1::text[])", [keys],
    );
    assert.equal(ledger.rows.length, 2);
    assert.deepEqual(new Set(ledger.rows.map((row) => row.user_id)), new Set([f.owner.id, f.collaborator.id]));
    assert.ok(ledger.rows.every((row) => row.status_code === 200 && row.outcome_state === "completed"), JSON.stringify(ledger.rows));
    const history = await readFile(path.join(f.pmRoot, "history", `${f.id}.jsonl`), "utf8");
    assert.match(history, /owner write/);
    assert.match(history, /collaborator write/);
    for (const line of history.trim().split("\n")) assert.ok(JSON.parse(line));
    const verified = await execFileAsync(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
      "history", f.id, "--pm-path", f.pmRoot, "--verify", "--strict-exit", "--full", "--json"]);
    assert.equal((JSON.parse(verified.stdout) as { verification: { ok: boolean } }).verification.ok, true);
  } finally {
    await stream.close();
  }
});

test("restore positionals reconstruct the requested version and command failures keep a JSON error envelope", async (t) => {
  const f = await commandFixture(t);
  const updated = await f.request(f.owner, `update/${f.id}`, "PATCH", { title: "Later version", message: "prepare restore" });
  assert.equal(updated.status, 200);
  const restored = await f.request(f.owner, `restore/${f.id}`, "POST", { target: "1" });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal((await persistedItem(f)).title, "Protected command item");
  const before = await trackerDocuments(f.pmRoot);
  for (const [route, method, body, status] of [
    [`update/${f.id}`, "PATCH", { status: "invented-status" }, 400],
    ["update/ac-absent", "PATCH", { title: "Missing record" }, 404],
    ["comments/ac-absent", "POST", { text: "Missing record comment" }, 404],
    [`restore/${f.id}`, "POST", { target: "not-a-version" }, 400],
  ] as const) {
    const failed = await f.request(f.owner, route, method, body);
    assert.equal(failed.status, status, await failed.clone().text());
    assert.match(failed.headers.get("content-type") ?? "", /application\/json/);
    const payload = await failed.json() as { error: string };
    assert.equal(typeof payload.error, "string");
    assert.ok(payload.error.length > 0);
  }
  assert.deepEqual(await trackerDocuments(f.pmRoot), before);
  assert.equal((await pool.query("SELECT user_id FROM pm_projects WHERE id = $1", [f.project.id])).rows[0].user_id, f.owner.id);
});

test("maintenance and static command routes operate on the real workspace and return concrete results", async (t) => {
  const f = await commandFixture(t);
  for (const route of ["validate", "dedupe-audit", "test-runs?status=passed&limit=2", "templates", "config", "config/definition-of-done"]) {
    const response = await f.request(f.owner, route);
    assert.equal(response.status, 200, route);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(!("error" in body), `${route}: ${JSON.stringify(body)}`);
    assert.ok(Object.keys(body).length > 0, route);
  }
  const missingTopic = await f.request(f.owner, "guide/absent-command-topic");
  assert.equal(missingTopic.status, 404);
  assert.equal(typeof (await missingTopic.json() as { error: string }).error, "string");
  for (const [route, body] of [["gc", {}], ["test-all", { status: "open", limit: "2", timeout: "5" }]] as const) {
    const response = await f.request(f.owner, route, "POST", body);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    const payload = await response.json() as Record<string, unknown>;
    assert.ok(!("error" in payload), `${route}: ${JSON.stringify(payload)}`);
    assert.ok(Object.keys(payload).length > 0);
  }
  for (const [route, method, body, status, provider] of [
    ["comments-audit", "GET", undefined, 200, "pm-governance-audit"],
    ["normalize", "POST", {}, 200, "pm-governance-audit"],
    ["reindex", "POST", { mode: "keyword" }, 400, "pm-search-advanced"],
  ] as const) {
    const unavailable = await f.request(f.owner, route, method, body);
    assert.equal(unavailable.status, status);
    const refusal = await unavailable.json() as { error: string };
    assert.match(refusal.error, /Unknown command/);
    assert.ok(refusal.error.includes(provider));
  }
  const listed = await f.request(f.owner, "list-all");
  assert.deepEqual((await listed.json() as { items: Array<{ id: string }> }).items.map((item) => item.id), [f.id]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM pm_projects WHERE id = $1", [f.project.id])).rows[0].count, 1);
});

test("keyword POST search applies bounded tuning and rejects malformed cursors without changing items", async (t) => {
  const f = await commandFixture(t);
  for (const body of [{}, { query: 123 }, { query: " " }]) {
    const empty = await f.request(f.owner, "search", "POST", body);
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "Search query is required" });
  }
  const malformed = await f.request(f.owner, "search", "POST", { query: "Protected", mode: "keyword", after: "invalid+cursor" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Pagination cursor must be a valid base64url token.", results: [] });
  const result = await f.request(f.owner, "search", "POST", {
    query: "Protected", mode: "keyword", limit: 50.5, minScore: -10, semanticWeight: 4,
  });
  assert.equal(result.status, 200, await result.clone().text());
  const payload = await result.json() as { items?: Array<{ id: string }>; results?: Array<{ id: string }> };
  assert.deepEqual((payload.items ?? payload.results)?.map((item) => item.id), [f.id]);
  assert.equal((await persistedItem(f)).title, "Protected command item");
  const validateDocs = await f.request(f.owner, `docs/${f.id}`, "POST", { validatePaths: "true" });
  assert.equal(validateDocs.status, 200, await validateDocs.clone().text());
  assert.ok(!("error" in (await validateDocs.json() as object)));
  const missingTemplate = await f.request(f.owner, "templates/synthetic-absent-template");
  assert.equal(missingTemplate.status, 200);
  assert.equal(typeof (await missingTemplate.json() as { error: string }).error, "string");
  const ownerRow = await pool.query<{ user_id: string }>("SELECT user_id FROM pm_projects WHERE id = $1", [f.project.id]);
  assert.equal(ownerRow.rows[0].user_id, f.owner.id);
});

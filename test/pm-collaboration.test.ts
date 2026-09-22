/**
 * End-to-end collaboration coverage for pm-web's shared pm command surface.
 *
 * Every request crosses a real loopback HTTP server, real PostgreSQL access
 * checks, and a real temporary pm workspace. The scenarios pin the service's
 * central guarantees: one collaborator sees another's mutation over SSE, and
 * concurrent edits to one item are serialized without losing either change.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authHeaders,
  authedFetch,
  ensureSchema,
  seedProject,
  seedUser,
  seedUserShare,
  startApp,
  uniqueEmail,
  uniqueSlug,
  type AppServer,
  type SeedUser,
} from "./helpers/pg-harness.ts";

interface CollaborationHarness {
  readonly root: string;
  readonly pmRoot: string;
  readonly owner: SeedUser;
  readonly editor: SeedUser;
  readonly projectId: string;
}

/** Provision a database project and its matching real pm workspace. */
async function createCollaborationHarness(): Promise<CollaborationHarness> {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-"));
  const owner = await seedUser(uniqueEmail("collab-owner"), { displayName: "Owner" });
  const editor = await seedUser(uniqueEmail("collab-editor"), { displayName: "Editor" });
  const project = await seedProject(owner.id, uniqueSlug("collab"), { prefix: "co" });
  await seedUserShare(project.id, editor.id, "edit");
  const pmRoot = path.join(root, owner.id, project.slug, ".agents", "pm");
  await mkdir(path.dirname(pmRoot), { recursive: true });
  execFileSync("pm", ["init", "--pm-path", pmRoot], { stdio: "ignore" });
  process.env.PROJECTS_ROOT = root;
  return { root, pmRoot, owner, editor, projectId: project.id };
}

/** Decode a successful create response and require the real item id. */
async function createdItemId(response: Response): Promise<string> {
  assert.equal(response.status, 201, await response.clone().text());
  const payload = await response.json() as { id?: string; item?: { id?: string } };
  const id = payload.item?.id ?? payload.id;
  assert.ok(id, `create response did not contain an item id: ${JSON.stringify(payload)}`);
  return id;
}

/** Read an SSE response until an event name appears, with a bounded timeout. */
async function waitForEvent(response: Response, eventName: string): Promise<string> {
  assert.equal(response.status, 200);
  assert.ok(response.body, "SSE response must expose a readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => void reader.cancel("SSE assertion timed out"), 5_000);
  let received = "";
  try {
    while (!received.includes(`event: ${eventName}`)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, `SSE closed before ${eventName}: ${received}`);
      received += decoder.decode(chunk.value, { stream: true });
    }
    return received;
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
}

/** Create an item through the production HTTP route. */
async function createItem(server: AppServer, user: SeedUser, projectId: string, title: string): Promise<string> {
  const response = await authedFetch(server, user, `/api/projects/${projectId}/pm/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, type: "Task", description: "Collaboration fixture" }),
  });
  return createdItemId(response);
}


/** Common setup for collaboration tests: save PROJECTS_ROOT, create harness,
 * start app, register cleanup that closes the server and restores env. */
async function setupCollabTest(t: test.TestContext): Promise<{
  harness: Awaited<ReturnType<typeof createCollaborationHarness>>;
  server: AppServer;
}> {
  const previousRoot = process.env.PROJECTS_ROOT;
  const harness = await createCollaborationHarness();
  // Teardown is registered before startApp() so a rejected start still removes the root and restores env.
  const startedServer: { current?: AppServer } = {};
  t.after(async () => {
    if (startedServer.current) await startedServer.current.close();
    await rm(harness.root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
  });
  const server = await startApp();
  startedServer.current = server;
  return { harness, server };
}

test("client B receives client A's item mutation over the real SSE route", async (t) => {
  const previousRoot = process.env.PROJECTS_ROOT;
  const harness = await createCollaborationHarness();
  const startedServer: { current?: AppServer } = {};
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    if (startedServer.current) await startedServer.current.close();
    await rm(harness.root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
  });
  const server = await startApp();
  startedServer.current = server;
  const stream = await fetch(server.url(`/api/projects/${harness.projectId}/pm/events?view=items`), {
    headers: authHeaders(harness.editor),
    signal: controller.signal,
  });
  const [received, itemId] = await Promise.all([
    waitForEvent(stream, "item-created"),
    createItem(server, harness.owner, harness.projectId, "SSE shared mutation"),
  ]);
  controller.abort();
  assert.match(received, new RegExp(itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(received, new RegExp(harness.owner.id));
});

test("concurrent collaborators update one item without a lost write or malformed history", async (t) => {
  const { harness, server } = await setupCollabTest(t);

  const itemId = await createItem(server, harness.owner, harness.projectId, "Concurrent original");
  const [titleUpdate, descriptionUpdate] = await Promise.all([
    authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/update/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Owner title", message: "owner concurrent edit" }),
    }),
    authedFetch(server, harness.editor, `/api/projects/${harness.projectId}/pm/update/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Editor description", message: "editor concurrent edit" }),
    }),
  ]);
  assert.equal(titleUpdate.status, 200, await titleUpdate.clone().text());
  assert.equal(descriptionUpdate.status, 200, await descriptionUpdate.clone().text());

  const current = await authedFetch(server, harness.editor, `/api/projects/${harness.projectId}/pm/get/${itemId}`);
  assert.equal(current.status, 200);
  const payload = await current.json() as {
    item?: { title?: string; description?: string };
    title?: string;
    description?: string;
  };
  const item = payload.item ?? payload;
  assert.equal(item.title, "Owner title");
  assert.equal(item.description, "Editor description");

  const historyText = await readFile(path.join(harness.pmRoot, "history", `${itemId}.jsonl`), "utf8");
  const history = historyText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(history.length >= 3, `create plus both updates must be recorded: ${historyText}`);
  assert.ok(history.every((entry) => typeof entry === "object" && entry !== null));
  assert.match(historyText, /owner concurrent edit/);
  assert.match(historyText, /editor concurrent edit/);
});

test("the real HTTP command surface preserves an item's lifecycle and related records", async (t) => {
  const { harness, server } = await setupCollabTest(t);

  const base = `/api/projects/${harness.projectId}/pm`;
  const schema = await authedFetch(server, harness.owner, `${base}/schema`);
  assert.equal(schema.status, 200);
  const schemaBody = await schema.json() as { types?: unknown[]; statuses?: unknown[] };
  assert.ok(Array.isArray(schemaBody.types));
  assert.ok(Array.isArray(schemaBody.statuses));

  const missingTitle = await authedFetch(server, harness.owner, `${base}/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "no title" }),
  });
  assert.equal(missingTitle.status, 400);

  const parentId = await createItem(server, harness.owner, harness.projectId, "Lifecycle parent");
  const childId = await createItem(server, harness.owner, harness.projectId, "Lifecycle child");
  const richCreate = await authedFetch(server, harness.owner, `${base}/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Rich lifecycle issue",
      type: "Issue",
      priority: "1",
      description: "Every supported create field",
      tags: "coverage,route",
      parent: parentId,
      deadline: "2026-12-31",
      assignee: "route-owner",
      sprint: "sprint-1",
      release: "release-1",
      estimate: "30",
      body: "Detailed issue body",
      acceptanceCriteria: "All fields persist",
      reporter: "route-reporter",
      component: "http",
      severity: "medium",
      risk: "medium",
      goal: "goal-1",
      objective: "objective-1",
      environment: "test",
      "blocked-by": parentId,
      "blocked-reason": "fixture dependency",
      "repro-steps": "Run the route test",
      "expected-result": "Fields persist",
      "actual-result": "Pending assertion",
      reviewer: "route-reviewer",
      confidence: "high",
      "why-now": "Coverage mandate",
      value: "Regression protection",
      impact: "Safer collaboration",
      outcome: "Observable lifecycle",
      "definition-of-ready": "Fixture prepared",
    }),
  });
  const richId = await createdItemId(richCreate);
  const richGet = await authedFetch(server, harness.owner, `${base}/get/${richId}`);
  assert.equal(richGet.status, 200);
  assert.match(await richGet.text(), /Every supported create field/);

  const invalidCursor = await authedFetch(server, harness.owner, `${base}/list?after=not%2Ba%2Bcursor`);
  assert.equal(invalidCursor.status, 400);
  assert.deepEqual(await invalidCursor.json(), {
    error: "Pagination cursor must be a valid base64url token.",
    items: [],
  });
  const oversizedCursor = await authedFetch(
    server,
    harness.owner,
    `${base}/list-all?after=${"x".repeat(2_049)}`,
  );
  assert.equal(oversizedCursor.status, 400);

  const listed = await authedFetch(
    server,
    harness.owner,
    `${base}/list?status=open&type=Task&limit=10&priority=2&sprint=s1&release=r1&assignee=nobody`,
  );
  assert.equal(listed.status, 200);
  const unfiltered = await authedFetch(server, harness.owner, `${base}/list`);
  assert.equal(unfiltered.status, 200);
  const all = await authedFetch(server, harness.owner, `${base}/list-all?type=Task&limit=1`);
  assert.equal(all.status, 200);
  const allBody = await all.json() as { items?: Array<{ id: string }>; next_cursor?: string };
  assert.equal(allBody.items?.length, 1);
  assert.ok(allBody.next_cursor, "two visible Task items with limit=1 must page");
  const nextPage = await authedFetch(
    server,
    harness.owner,
    `${base}/list-all?type=Task&limit=1&after=${encodeURIComponent(allBody.next_cursor)}`,
  );
  assert.equal(nextPage.status, 200, `${allBody.next_cursor}: ${await nextPage.clone().text()}`);
  const nextBody = await nextPage.json() as { items?: Array<{ id: string }> };
  assert.equal(nextBody.items?.length, 1);
  assert.notEqual(nextBody.items?.[0]?.id, allBody.items?.[0]?.id);
  const unfilteredAll = await authedFetch(server, harness.owner, `${base}/list-all`);
  assert.equal(unfilteredAll.status, 200);
  const searched = await authedFetch(server, harness.owner, `${base}/search?q=Lifecycle`);
  assert.equal(searched.status, 200);
  assert.equal((await searched.json() as { count?: number }).count, 3);

  const updated = await authedFetch(server, harness.editor, `${base}/update/${childId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Lifecycle updated",
      description: "Updated through HTTP",
      priority: "1",
      tags: "coverage,collaboration",
      body: "Lifecycle body",
      author: "route-test",
      message: "exercise update flags",
    }),
  });
  assert.equal(updated.status, 200, await updated.clone().text());

  const fetched = await authedFetch(server, harness.owner, `${base}/get/${childId}`);
  assert.equal(fetched.status, 200);
  assert.match(await fetched.text(), /Lifecycle updated/);
  const missingGet = await authedFetch(server, harness.owner, `${base}/get/co-does-not-exist`);
  assert.equal(missingGet.status, 404);

  const comment = await authedFetch(server, harness.owner, `${base}/comments/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Observable comment" }),
  });
  assert.equal(comment.status, 201, await comment.clone().text());
  const comments = await authedFetch(server, harness.editor, `${base}/comments/${childId}`);
  assert.equal(comments.status, 200);
  assert.match(await comments.text(), /Observable comment/);

  const note = await authedFetch(server, harness.owner, `${base}/notes/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Observable note" }),
  });
  assert.equal(note.status, 201, await note.clone().text());
  const notes = await authedFetch(server, harness.editor, `${base}/notes/${childId}`);
  assert.equal(notes.status, 200);
  assert.match(await notes.text(), /Observable note/);

  const append = await authedFetch(server, harness.owner, `${base}/append/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Appended body text" }),
  });
  assert.equal(append.status, 200, await append.clone().text());
  const history = await authedFetch(server, harness.editor, `${base}/history/${childId}`);
  assert.equal(history.status, 200);
  assert.match(await history.text(), /exercise update flags/);

  const addDependency = await authedFetch(server, harness.owner, `${base}/deps/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: parentId, rel: "depends-on" }),
  });
  assert.equal(addDependency.status, 201, await addDependency.clone().text());
  const dependencies = await authedFetch(server, harness.editor, `${base}/deps/${childId}`);
  assert.equal(dependencies.status, 200);
  assert.match(await dependencies.text(), new RegExp(parentId));
  const removeDependency = await authedFetch(server, harness.owner, `${base}/deps/${childId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: parentId, rel: "depends-on" }),
  });
  assert.equal(removeDependency.status, 200, await removeDependency.clone().text());

  const addRelation = await authedFetch(server, harness.owner, `${base}/rel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: childId, to: parentId, type: "related-to" }),
  });
  assert.equal(addRelation.status, 201, await addRelation.clone().text());
  const removeRelation = await authedFetch(server, harness.owner, `${base}/rel`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: childId, to: parentId, type: "related-to" }),
  });
  assert.equal(removeRelation.status, 200, await removeRelation.clone().text());

  for (const route of [
    "context?depth=brief",
    "context?depth=unsupported",
    "activity?limit=5",
    "activity",
    "stats",
    "aggregate",
    "calendar",
    "health",
  ]) {
    const response = await authedFetch(server, harness.editor, `${base}/${route}`);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
  }

  const missingReason = await authedFetch(server, harness.owner, `${base}/close/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingReason.status, 400);
  const closed = await authedFetch(server, harness.owner, `${base}/close/${childId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Lifecycle complete" }),
  });
  assert.equal(closed.status, 200, await closed.clone().text());
  const deleted = await authedFetch(server, harness.owner, `${base}/delete/${parentId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.clone().text());

  const absentBase = "/api/projects/00000000-0000-4000-8000-000000000000/pm";
  const absentRoutes: ReadonlyArray<{ method: string; path: string; body?: Record<string, unknown> }> = [
    { method: "GET", path: "schema" },
    { method: "GET", path: "list" },
    { method: "GET", path: "list-all" },
    { method: "GET", path: "board" },
    { method: "GET", path: "search?q=x" },
    { method: "POST", path: "create", body: { title: "x" } },
    { method: "GET", path: `get/${childId}` },
    { method: "PATCH", path: `update/${childId}`, body: { title: "x" } },
    { method: "POST", path: `close/${childId}`, body: { reason: "x" } },
    { method: "DELETE", path: `delete/${childId}` },
    { method: "POST", path: `comments/${childId}`, body: { text: "x" } },
    { method: "GET", path: `comments/${childId}` },
    { method: "POST", path: `notes/${childId}`, body: { text: "x" } },
    { method: "GET", path: `notes/${childId}` },
    { method: "GET", path: "context" },
    { method: "GET", path: "activity" },
    { method: "GET", path: "stats" },
    { method: "GET", path: "aggregate" },
    { method: "GET", path: "calendar" },
    { method: "GET", path: "calendar.ics" },
    { method: "GET", path: "health" },
    { method: "POST", path: `append/${childId}`, body: { text: "x" } },
    { method: "GET", path: `history/${childId}` },
    { method: "GET", path: `deps/${childId}` },
    { method: "POST", path: `deps/${childId}`, body: { targetId: parentId } },
    { method: "DELETE", path: `deps/${childId}`, body: { targetId: parentId } },
    { method: "POST", path: "rel", body: { from: childId, to: parentId } },
    { method: "DELETE", path: "rel", body: { from: childId, to: parentId } },
    { method: "GET", path: "presence" },
  ];
  for (const route of absentRoutes) {
    const response = await authedFetch(server, harness.owner, `${absentBase}/${route.path}`, {
      method: route.method,
      headers: route.body ? { "content-type": "application/json" } : undefined,
      body: route.body ? JSON.stringify(route.body) : undefined,
    });
    assert.equal(response.status, 404, `${route.method} ${route.path}: ${await response.clone().text()}`);
  }

  const presence = await authedFetch(server, harness.owner, `${base}/presence`);
  assert.equal(presence.status, 200);
  assert.deepEqual(await presence.json(), { users: [] });

  const missingItem = "co-does-not-exist";
  const failedMutations: ReadonlyArray<{ method: string; path: string; body?: Record<string, unknown> }> = [
    { method: "PATCH", path: `update/${missingItem}`, body: { title: "never written" } },
    { method: "POST", path: `close/${missingItem}`, body: { reason: "not found" } },
    { method: "DELETE", path: `delete/${missingItem}` },
    { method: "POST", path: `comments/${missingItem}`, body: { text: "not written" } },
    { method: "POST", path: `notes/${missingItem}`, body: { text: "not written" } },
    { method: "POST", path: `append/${missingItem}`, body: { text: "not written" } },
    { method: "POST", path: `deps/${missingItem}`, body: { targetId: parentId } },
  ];
  for (const mutation of failedMutations) {
    const response = await authedFetch(server, harness.owner, `${base}/${mutation.path}`, {
      method: mutation.method,
      headers: mutation.body ? { "content-type": "application/json" } : undefined,
      body: mutation.body ? JSON.stringify(mutation.body) : undefined,
    });
    assert.ok(response.status >= 400, `${mutation.method} ${mutation.path} must fail for a missing item`);
  }

  for (const invalid of [
    { path: `comments/${childId}`, body: { text: "" } },
    { path: `notes/${childId}`, body: { text: "" } },
    { path: `append/${childId}`, body: { text: "" } },
    { path: `deps/${childId}`, body: {} },
    { path: "rel", body: { from: childId } },
  ]) {
    const response = await authedFetch(server, harness.owner, `${base}/${invalid.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalid.body),
    });
    assert.equal(response.status, 400, `${invalid.path}: ${await response.clone().text()}`);
  }
});

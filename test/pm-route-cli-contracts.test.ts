/**
 * Regression coverage pinning pm-web's pm command routes to the exact token
 * shapes the real pm CLI accepts.
 *
 * Each historical bug fixed alongside these tests shared one shape of
 * failure: the route assembled CLI arguments that the CLI rejects or silently
 * ignores, so a UI action exited 2 or returned success while dropping the
 * user's change. Every test here drives the production HTTP route against a
 * real temporary pm workspace and then verifies the resulting record through
 * the CLI's own read commands, so reverting the route fix fails the test at
 * the assertion that names the user-visible behaviour.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  authedFetch,
  ensureSchema,
  seedProject,
  seedUser,
  startApp,
  uniqueEmail,
  uniqueSlug,
  type AppServer,
  type SeedUser,
} from "./helpers/pg-harness.ts";

/** Fixture root, seeded owner, and the workspace directory for one test. */
interface ContractsHarness {
  /** Throwaway directory holding the owner's project workspace. */
  readonly root: string;
  /** On-disk project workspace the routes' pm invocations run inside. */
  readonly workspace: string;
  /** Seeded owner whose access every request authenticates as. */
  readonly owner: SeedUser;
  /** Database id of the seeded project. */
  readonly projectId: string;
}

/** Parsed `pm plan show --json` payload shape used by the plan assertions. */
interface PlanShowResult {
  readonly plan: {
    readonly id: string;
    readonly title: string;
    readonly steps: ReadonlyArray<{
      readonly id: string;
      readonly order: number;
      readonly title: string;
      readonly status: string;
      readonly body?: string;
      readonly linked_items?: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
    }>;
  };
}

/** Parsed `pm test <id> --json` payload shape used by the linked-test assertions. */
interface ItemTestsResult {
  readonly tests: ReadonlyArray<{ readonly command: string; readonly note?: string }>;
}

/**
 * Provision a database project and its matching real pm workspace.
 *
 * Mirrors the collaboration harness: the project row locates the workspace the
 * app computes from `PROJECTS_ROOT`, and `pm init` seeds a genuine tracker there
 * so the routes' pm invocations mutate a real project.
 */
async function createContractsHarness(): Promise<ContractsHarness> {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-contracts-"));
  const owner = await seedUser(uniqueEmail("contracts-owner"));
  const project = await seedProject(owner.id, uniqueSlug("contracts"), { prefix: "ct" });
  const workspace = path.join(root, owner.id, project.slug);
  await mkdir(path.join(workspace, ".agents"), { recursive: true });
  execFileSync("pm", ["init", "--pm-path", path.join(workspace, ".agents", "pm")], { stdio: "ignore" });
  process.env.PROJECTS_ROOT = root;
  return { root, workspace, owner, projectId: project.id };
}

/**
 * Set up the harness plus a running app server with teardown registered first.
 *
 * Teardown closes the server, removes the throwaway root, and restores the
 * saved `PROJECTS_ROOT` so one test's isolation never leaks into the next.
 */
async function setupContractsTest(
  t: test.TestContext,
): Promise<{ harness: ContractsHarness; server: AppServer }> {
  const previousRoot = process.env.PROJECTS_ROOT;
  const harness = await createContractsHarness();
  const started: { server?: AppServer } = {};
  t.after(async () => {
    await started.server?.close();
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(harness.root, { recursive: true, force: true });
  });
  const server = await startApp();
  started.server = server;
  return { harness, server };
}

/** Run pm directly inside the workspace and parse its JSON output. */
function pmJson<T>(workspace: string, args: string[]): T {
  const stdout = execFileSync("pm", [...args, "--pm-path", path.join(workspace, ".agents", "pm"), "--json"], { cwd: workspace, encoding: "utf8" });
  return JSON.parse(stdout) as T;
}

/** Create an item or plan over HTTP, requiring the actual persisted record id. */
async function createRecord(
  server: AppServer,
  harness: ContractsHarness,
  action: "create" | "plan",
  title: string,
): Promise<string> {
  const response = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, type: "Task", description: "Route contract fixture" }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const payload = JSON.parse(text) as { id?: string; item?: { id?: string } };
  const id = payload.item?.id ?? payload.id;
  assert.ok(id, `create response did not contain an id: ${text}`);
  return id;
}

/** Add a step to a plan through the production HTTP route. */
async function addPlanStep(
  server: AppServer,
  owner: SeedUser,
  projectId: string,
  planId: string,
  title: string,
  description?: string,
): Promise<Response> {
  const body: Record<string, string> = { title };
  if (description !== undefined) body.description = description;
  return authedFetch(server, owner, `/api/projects/${projectId}/pm/plan/${planId}/steps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("plan step routes drive the CLI's step flags and step edits actually land", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const planId = await createRecord(server, harness, "plan", "Step contract plan");

  const add = await addPlanStep(server, harness.owner, harness.projectId, planId, "Contract step", "Contract step body");
  assert.equal(add.status, 201, await add.text());

  const patch = await authedFetch(
    server,
    harness.owner,
    `/api/projects/${harness.projectId}/pm/plan/${planId}/steps/1`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed step", description: "Replaced body" }),
    },
  );
  assert.equal(patch.status, 200, await patch.text());

  // With the historical plan-level --title/--description flags the request
  // returned 200 while the CLI silently ignored them, so the record itself —
  // not the response status — pins the fix.
  const shown = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "standard"]);
  const step = shown.plan.steps.find((candidate) => candidate.order === 1);
  assert.ok(step, `plan show did not list the added step: ${JSON.stringify(shown.plan.steps)}`);
  assert.equal(step.title, "Renamed step");
  assert.equal(step.body, "Replaced body");
});

/** Send a JSON mutation through the real project command route. */
function contractsRequest(server: AppServer, harness: ContractsHarness, route: string, body: Record<string, unknown>, method = "POST"): Promise<Response> {
  return authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/${route}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("linked files, docs, learnings, claims and settings survive real route round trips", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const itemId = await createRecord(server, harness, "create", "Linked records");
  const base = `/api/projects/${harness.projectId}/pm`;
  await writeFile(path.join(harness.workspace, "fixture.ts"), "export const fixture = true;\n");
  await writeFile(path.join(harness.workspace, "fixture.md"), "# Route fixture\n");
  for (const [route, body, status] of [
    [`files/${itemId}`, { path: "fixture.ts", scope: "project" }, 201],
    [`docs/${itemId}`, { path: "fixture.md", scope: "project", note: "Reference document" }, 200],
    [`learnings/${itemId}`, { text: "Linked records must persist" }, 201],
    [`claim/${itemId}`, {}, 200],
    [`release/${itemId}`, {}, 200],
  ] as const) {
    const result = await contractsRequest(server, harness, route, body);
    assert.equal(result.status, status, await result.clone().text());
  }
  for (const [route, field, expected] of [
    ["files", "path", "fixture.ts"], ["docs", "path", "fixture.md"], ["learnings", "text", "Linked records must persist"],
  ]) {
    const read = await authedFetch(server, harness.owner, `${base}/${route}/${itemId}`);
    assert.equal(read.status, 200);
    const payload = await read.json() as Record<string, Array<Record<string, unknown>>>;
    assert.ok(payload[route].some((record) => record[field] === expected), JSON.stringify(payload));
  }
  const removed = await contractsRequest(server, harness, `docs/${itemId}`, { remove: "fixture.md" });
  assert.equal(removed.status, 200, await removed.clone().text());
  const remaining = await authedFetch(server, harness.owner, `${base}/docs/${itemId}`);
  assert.deepEqual((await remaining.json() as { docs: unknown[] }).docs, []);
  const configured = await contractsRequest(server, harness, "config/definition-of-done", { value: "Route configuration" }, "PATCH");
  assert.equal(configured.status, 200);
  assert.ok(!("error" in (await configured.json() as Record<string, unknown>)));
  const readConfig = await authedFetch(server, harness.owner, `${base}/config/definition-of-done`);
  assert.match(await readConfig.text(), /Route configuration/);
  for (const invalid of [
    [`files/${itemId}`, {}], [`docs/${itemId}`, {}], [`learnings/${itemId}`, { text: " " }],
    [`tests/${itemId}`, {}], [`restore/${itemId}`, {}],
  ] as const) {
    const result = await contractsRequest(server, harness, invalid[0], invalid[1]);
    assert.equal(result.status, 400);
  }
});

test("import and three real export formats preserve data and filtered bulk edits leave other items alone", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const base = `/api/projects/${harness.projectId}/pm`;
  const empty = await authedFetch(server, harness.owner, `${base}/export?format=csv`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  const title = 'Quoted, "task"';
  const description = "First line\nsecond: line # details";
  const imported = await contractsRequest(server, harness, "import", { items: [
    { title, description, type: "Task", tags: "batch,fixture", priority: "1", assignee: "test-agent", sprint: "s1", release: "r1", deadline: "2026-12-31", body: "Full body" },
    { title: "Other import", type: "Task" }, { description: "Missing title" },
    { title: "Rejected type", type: "NoSuchType" },
  ] });
  assert.equal(imported.status, 200);
  const result = await imported.json() as { created: string[]; errors: string[]; total: number };
  assert.equal(result.created.length, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(result.total, 4);
  for (const format of ["json", "yaml", "csv"]) {
    const exported = await authedFetch(server, harness.owner, `${base}/export?format=${format}`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", new RegExp(`export\\.${format}`));
    const raw = await exported.text();
    if (format === "csv") {
      assert.ok(raw.startsWith("id,title,description,type,status,priority,tags"));
      assert.ok(raw.includes('"Quoted, ""task"""'));
      assert.ok(raw.includes('"First line\nsecond: line # details"'));
    } else {
      const parsed = (format === "json" ? JSON.parse(raw) : parseYaml(raw)) as { items: Array<{ id: string; title: string; description: string; tags: string[] }> };
      assert.equal(parsed.items.length, 2);
      const record = parsed.items.find((item) => item.id === result.created[0]);
      assert.ok(record);
      assert.equal(record.title, title);
      assert.equal(record.description, description);
      assert.deepEqual(record.tags, ["batch", "fixture"]);
    }
  }
  const filter = { filterTag: "batch", priority: "0", description: "Only the selected record" };
  const preview = await contractsRequest(server, harness, "update-many", { ...filter, dryRun: "true" });
  assert.equal(preview.status, 200, await preview.clone().text());
  const before = pmJson<{ item: { priority: number } }>(harness.workspace, ["get", result.created[0]]);
  assert.equal(before.item.priority, 1);
  const update = await contractsRequest(server, harness, "update-many", filter);
  assert.equal(update.status, 200, await update.clone().text());
  const selected = pmJson<{ item: { priority: number; description: string } }>(harness.workspace, ["get", result.created[0]]).item;
  assert.equal(selected.priority, 0);
  assert.equal(selected.description, filter.description);
  const other = pmJson<{ item: { priority: number; description: string } }>(harness.workspace, ["get", result.created[1]]).item;
  assert.equal(other.priority, 2);
  assert.equal(other.description, "Other import");
  for (const items of [[], Array.from({ length: 501 }, () => ({ title: "Too many" }))]) {
    const rejected = await contractsRequest(server, harness, "import", { items });
    assert.equal(rejected.status, 400);
  }
});

test("plan lifecycle routes preserve step order, blocked state, completion and materialized links", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const planId = await createRecord(server, harness, "plan", "Lifecycle plan");
  const base = `/api/projects/${harness.projectId}/pm`;
  for (const title of ["First step", "Second step", "Disposable step"]) {
    const added = await addPlanStep(server, harness.owner, harness.projectId, planId, title);
    assert.equal(added.status, 201, await added.clone().text());
  }
  const prefix = `plan/${planId}`;
  const edited = await contractsRequest(server, harness, prefix, { title: "Updated plan", description: "Plan body remains distinct" }, "PATCH");
  assert.equal(edited.status, 200, await edited.clone().text());
  const reordered = await contractsRequest(server, harness, `${prefix}/steps/3/reorder`, { reorderTo: 1 });
  assert.equal(reordered.status, 200, await reordered.clone().text());
  let plan = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "deep"]).plan;
  assert.equal(plan.title, "Updated plan");
  assert.equal(plan.steps[0].title, "Disposable step");
  const removed = await contractsRequest(server, harness, `${prefix}/steps/1`, {}, "DELETE");
  assert.equal(removed.status, 200, await removed.clone().text());
  const approved = await contractsRequest(server, harness, `${prefix}/approve`, {});
  assert.equal(approved.status, 200, await approved.clone().text());
  const materialized = await contractsRequest(server, harness, `${prefix}/materialize`, { materializeType: "Task", steps: "1" });
  assert.equal(materialized.status, 200, await materialized.clone().text());
  plan = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "deep"]).plan;
  const linkedId = plan.steps[0].linked_items?.[0]?.id;
  assert.ok(linkedId, JSON.stringify(plan));
  const linked = pmJson<{ item: { type: string; title: string } }>(harness.workspace, ["get", linkedId]).item;
  assert.equal(linked.type, "Task");
  assert.equal(linked.title, "First step");
  const blocked = await contractsRequest(server, harness, `${prefix}/steps/2/block`, { reason: "Awaiting fixture dependency" });
  assert.equal(blocked.status, 200, await blocked.clone().text());
  const completed = await contractsRequest(server, harness, `${prefix}/steps/1/complete`, {});
  assert.equal(completed.status, 200, await completed.clone().text());
  const read = await authedFetch(server, harness.owner, `${base}/${prefix}`);
  assert.equal(read.status, 200);
  plan = (await read.json() as PlanShowResult).plan;
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].status, "completed");
  assert.equal(plan.steps[1].status, "blocked");
  for (const [route, body] of [
    ["steps", {}], ["steps/1/block", {}], ["steps/1/reorder", {}],
  ] as const) {
    const invalid = await contractsRequest(server, harness, `${prefix}/${route}`, body);
    assert.equal(invalid.status, 400);
  }
  const deleted = await contractsRequest(server, harness, prefix, {}, "DELETE");
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const missing = await authedFetch(server, harness.owner, `${base}/${prefix}`);
  assert.equal(missing.status, 404);
});

test("a foreign inherited tracker cannot redirect HTTP plan mutations outside the requested workspace", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const decoy = path.join(harness.root, "decoy");
  const decoyPm = path.join(decoy, ".agents", "pm");
  await mkdir(decoy, { recursive: true });
  execFileSync("pm", ["init", "--pm-path", decoyPm], { stdio: "ignore" });
  const previousPath = process.env.PM_PATH;
  process.env.PM_PATH = decoyPm;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PM_PATH;
    else process.env.PM_PATH = previousPath;
  });
  const planId = await createRecord(server, harness, "plan", "Owned plan despite foreign environment");
  const read = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/get/${planId}`);
  assert.equal(read.status, 200, await read.clone().text());
  const added = await addPlanStep(server, harness.owner, harness.projectId, planId, "Owned step");
  assert.equal(added.status, 201, await added.clone().text());
  const owned = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "standard"]);
  assert.equal(owned.plan.steps[0].title, "Owned step");
  const foreign = pmJson<{ items: unknown[] }>(decoy, ["list-all"]);
  assert.deepEqual(foreign.items, [], "neither fallback command may mutate the decoy tracker");
});

test("task transitions, status shortcuts and required-input errors agree with persisted PM state", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const itemId = await createRecord(server, harness, "create", "Task transition record");
  const base = `/api/projects/${harness.projectId}/pm`;
  for (const [action, expected] of [["start-task", "in_progress"], ["pause-task", "open"]]) {
    const response = await contractsRequest(server, harness, `${action}/${itemId}`, {});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(pmJson<{ item: { status: string } }>(harness.workspace, ["get", itemId]).item.status, expected);
  }
  for (const route of ["list-draft", "list-open", "list-in-progress", "list-blocked", "list-closed", "list-canceled"]) {
    const response = await authedFetch(server, harness.owner, `${base}/${route}?type=Task&limit=10&offset=0`);
    assert.equal(response.status, 200);
    const listed = await response.json() as { items: Array<{ id: string }> };
    assert.deepEqual(listed.items.map((item) => item.id), route === "list-open" ? [itemId] : []);
    const invalid = await authedFetch(server, harness.owner, `${base}/${route}?after=invalid%2Bcursor`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, /base64url/);
  }
  for (const [route, error] of [
    ["plan", /Title is required/], ["graph/query", /cypher query is required/],
    ["close-many", /reason/i], [`close-task/${itemId}`, /Close reason is required/],
  ] as const) {
    const invalid = await contractsRequest(server, harness, route, {});
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, error);
  }
  const closed = await contractsRequest(server, harness, `close-task/${itemId}`, { reason: "Task lifecycle verified" });
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal(pmJson<{ item: { status: string } }>(harness.workspace, ["get", itemId]).item.status, "closed");
  const noChange = await contractsRequest(server, harness, `docs/${itemId}`, { remove: "not-linked.md" });
  assert.equal(noChange.status, 200);
  assert.equal((await noChange.json() as { changed: boolean }).changed, false);
  const failed = await contractsRequest(server, harness, "docs/pm-missing", { path: "fixture.md" });
  assert.equal(failed.status, 404, await failed.clone().text());
});

test("plan link and unlink routes pass the step positional the CLI requires", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const planId = await createRecord(server, harness, "plan", "Link contract plan");
  const add = await addPlanStep(server, harness.owner, harness.projectId, planId, "Link host step");
  assert.equal(add.status, 201, await add.text());
  const linkedId = await createRecord(server, harness, "create", "Link target item");

  const missingStep = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/plan/${planId}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: linkedId }),
  });
  assert.equal(missingStep.status, 400, await missingStep.text());

  const link = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/plan/${planId}/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: linkedId, step: "1", linkKind: "related", linkNote: "Contract link" }),
  });
  assert.equal(link.status, 201, await link.text());

  // `pm plan link` attaches the linked item to the step, which only the deep
  // plan view reports, so the record is verified through the CLI itself.
  const linked = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "deep"]);
  const linkedStep = linked.plan.steps.find((candidate) => candidate.order === 1);
  assert.ok(linkedStep, `deep plan show did not list the step: ${JSON.stringify(linked.plan.steps)}`);
  assert.ok(
    (linkedStep.linked_items ?? []).some((entry) => entry.id === linkedId),
    `step did not record the linked item: ${JSON.stringify(linkedStep.linked_items)}`,
  );

  const unlink = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/plan/${planId}/link`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: linkedId, step: "1" }),
  });
  assert.equal(unlink.status, 200, await unlink.text());

  const unlinked = pmJson<PlanShowResult>(harness.workspace, ["plan", "show", planId, "--depth", "deep"]);
  const unlinkedStep = unlinked.plan.steps.find((candidate) => candidate.order === 1);
  assert.ok(unlinkedStep, `deep plan show did not list the step: ${JSON.stringify(unlinked.plan.steps)}`);
  assert.equal(
    (unlinkedStep.linked_items ?? []).some((entry) => entry.id === linkedId),
    false,
    `unlink left the linked item attached: ${JSON.stringify(unlinkedStep.linked_items)}`,
  );
});

test("linked-test route stores the command verbatim through the CLI's JSON add", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const itemId = await createRecord(server, harness, "create", "Test link item");
  // Commas and equals signs broke the historical CSV argument shape, so the
  // command doubles as the fixture for the verbatim guarantee.
  const command = "npm run a=b,c --flag";

  const response = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/tests/${itemId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, description: "Contract note" }),
  });
  assert.equal(response.status, 201, await response.text());

  const listed = pmJson<ItemTestsResult>(harness.workspace, ["test", itemId]);
  const linked = listed.tests.find((entry) => entry.command === command);
  assert.ok(linked, `linked tests did not contain the command verbatim: ${JSON.stringify(listed.tests)}`);
  assert.equal(linked.note, "Contract note");
});

test("close-many closes only the project's open items, not terminal ones", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const openIds = await Promise.all([
    createRecord(server, harness, "create", "Open one"),
    createRecord(server, harness, "create", "Open two"),
  ]);
  const closedId = await createRecord(server, harness, "create", "Already closed");
  const close = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/close/${closedId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Closed before the bulk close" }),
  });
  assert.equal(close.status, 200, await close.text());

  const response = await authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/close-many`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Bulk close contract" }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const payload = JSON.parse(text) as {
    closed_count?: number;
    failed_count?: number;
    matched_count?: number;
    rows?: ReadonlyArray<{ id: string; status: string }>;
  };

  // With the historical `--status open` listing the dry-run matched the whole
  // project — the already-closed item included — and its `pm close` failed as
  // a conflict row, so both counts pin the filtered listing.
  assert.equal(payload.failed_count, 0, `close-many reported failures: ${JSON.stringify(payload.rows)}`);
  assert.deepEqual(
    (payload.rows ?? []).map((row) => row.id).sort(),
    [...openIds].sort(),
    `close-many touched more than the open items: ${JSON.stringify(payload.rows)}`,
  );
  // The response alone could report the right rows without persisting them, so
  // read every item back from the tracker: the selected items are closed with the
  // bulk reason and the pre-closed item keeps its original reason.
  for (const id of openIds) {
    const { item } = pmJson<{ item: { status: string; close_reason?: string } }>(harness.workspace, ["get", id]);
    assert.equal(item.status, "closed", `${id} was reported closed but not persisted`);
    assert.equal(item.close_reason, "Bulk close contract");
  }
  const { item: untouched } = pmJson<{ item: { status: string; close_reason?: string } }>(harness.workspace, ["get", closedId]);
  assert.equal(untouched.status, "closed");
  assert.equal(untouched.close_reason, "Closed before the bulk close");
});

test("close-many treats the caller's status filter as authoritative and refuses terminal statuses", async (t) => {
  const { harness, server } = await setupContractsTest(t);
  const openId = await createRecord(server, harness, "create", "Stays open");
  const activeId = await createRecord(server, harness, "create", "In progress");
  pmJson(harness.workspace, ["update", activeId, "--status", "in_progress"]);
  const closeMany = (filters: Record<string, string>): Promise<Response> =>
    authedFetch(server, harness.owner, `/api/projects/${harness.projectId}/pm/close-many`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Filtered bulk close", ...filters }),
    });

  // A terminal filter would re-select closed items; it is refused before any listing.
  for (const status of ["closed", "canceled"]) {
    const refused = await closeMany({ filterStatus: status });
    assert.equal(refused.status, 400, await refused.text());
  }

  // A non-terminal filter replaces the default `open` filter rather than being appended
  // after it, so exactly the in-progress item is closed and the open one is untouched.
  const response = await closeMany({ filterStatus: "in_progress" });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const payload = JSON.parse(text) as { failed_count?: number; rows?: ReadonlyArray<{ id: string }> };
  assert.equal(payload.failed_count, 0, text);
  assert.deepEqual((payload.rows ?? []).map((row) => row.id), [activeId]);
  assert.equal(pmJson<{ item: { status: string } }>(harness.workspace, ["get", activeId]).item.status, "closed");
  assert.equal(pmJson<{ item: { status: string } }>(harness.workspace, ["get", openId]).item.status, "open");
});

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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
  let server: AppServer | undefined;
  t.after(async () => {
    await server?.close();
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(harness.root, { recursive: true, force: true });
  });
  server = await startApp();
  return { harness, server };
}

/** Run pm directly inside the workspace and parse its JSON output. */
function pmJson<T>(workspace: string, args: string[]): T {
  const stdout = execFileSync("pm", [...args, "--json"], { cwd: workspace, encoding: "utf8" });
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
});

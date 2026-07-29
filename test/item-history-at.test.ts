import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  runPm,
  runGetItemAt,
  PmCliError,
  EXIT_CODE,
} from "../src/services/pm-runner.ts";

/**
 * End-to-end coverage for the point-in-time item read surface that backs the
 * `GET /api/projects/:projectId/pm/at/:itemId/:ref` route.
 *
 * These tests exercise the real pm CLI SDK (`getItemAt`) against throwaway pm
 * workspaces initialized through the same `runPm` runner the server uses, so
 * the projection, error envelopes, and version/timestamp resolution are all
 * verified against the live replay kernel rather than mocks.
 *
 * The route handler itself is a thin error-mapping wrapper around
 * {@link runGetItemAt}; mapping `PmCliError.exitCode` → HTTP status is covered
 * here at the SDK boundary where the semantics live.
 *
 * Concurrency note: `node:test` runs top-level `test()` calls concurrently by
 * default, and `runGetItemAt`/`runPm` resolve the workspace from
 * `process.env.PROJECTS_ROOT`. To stay race-free under concurrent execution we
 * point `PROJECTS_ROOT` at a single shared temp root ONCE (in `before`) and
 * give every test a unique `userId`/`slug` pair, so each test operates on its
 * own isolated subdirectory with no env mutation during the run.
 */

const PREFIX = "test";

let sharedRoot: string;
let previousProjectsRoot: string | undefined;
let workspaceCounter = 0;

function uniqueWorkspace(): { userId: string; slug: string; projectId: string } {
  // Monotonic counter guarantees a distinct directory per call across all
  // concurrent tests within this file's process.
  workspaceCounter += 1;
  const userId = `user-at-${process.pid}-${workspaceCounter}`;
  const slug = `ws-at-${workspaceCounter}`;
  const projectId = path.join(sharedRoot, userId, slug);
  return { userId, slug, projectId };
}

async function initWorkspace(userId: string, slug: string, projectId: string): Promise<void> {
  await mkdir(projectId, { recursive: true });
  // Initialize a tracker rooted at `<projectDir>/.agents/pm` so that:
  //   - `runPm` (which spawns pm in cwd=<projectDir>) discovers it by walking
  //     down into `.agents/pm`, exactly like the production server layout; and
  //   - `runGetItemAt` (which passes `pmRoot=<projectDir>/.agents/pm` to the
  //     SDK explicitly) resolves to the same root.
  const trackerRoot = path.join(projectId, ".agents", "pm");
  const init = await runPm({
    args: ["init", PREFIX, "--force", "--path", trackerRoot],
    userId,
    slug,
  });
  assert.ok(init.ok, `pm init failed: ${init.stderr}`);
}

before(async () => {
  sharedRoot = await mkdtemp(path.join(tmpdir(), "pm-web-item-at-"));
  previousProjectsRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = sharedRoot;
});

after(async () => {
  process.env.PROJECTS_ROOT = previousProjectsRoot;
  await rm(sharedRoot, { recursive: true, force: true });
});

async function createItem(userId: string, slug: string, title: string): Promise<string> {
  const result = await runPm({
    args: ["create", "--type", "Task", "--title", title, "--description", title, "--author", "pi-test"],
    userId,
    slug,
    jsonOutput: true,
  });
  assert.ok(result.ok && result.parsed, `pm create failed: ${result.stderr}`);
  // pm-cli 2026.7.21 returns a top-level mutation summary `{ id, status, ... }`;
  // older versions wrapped it as `{ item: { id, ... } }`. Accept both.
  const parsed = result.parsed as { id?: string; item?: { id: string } };
  const id = parsed.item?.id ?? parsed.id;
  assert.ok(id, `pm create returned no id: ${JSON.stringify(parsed)}`);
  return id;
}

async function updateItem(userId: string, slug: string, id: string, ...flags: string[]): Promise<void> {
  const result = await runPm({
    args: ["update", id, "--author", "pi-test", ...flags],
    userId,
    slug,
    jsonOutput: true,
  });
  assert.ok(result.ok, `pm update failed: ${result.stderr}`);
}

test("runGetItemAt reconstructs the item at an older one-based version", async () => {
  const { userId, slug, projectId } = uniqueWorkspace();
  await initWorkspace(userId, slug, projectId);
  const id = await createItem(userId, slug, "Original title");
  await updateItem(userId, slug, id, "--title", "Second title", "--status", "in_progress");
  await updateItem(userId, slug, id, "--priority", "4", "--tags", "hist,verify");

  const atV1 = await runGetItemAt(userId, slug, id, "1");
  assert.equal(atV1.reconstructed, true);
  assert.equal(atV1.as_of_version, 1);
  assert.equal(atV1.history_length, 3);
  assert.equal(atV1.document.metadata.title, "Original title");
  assert.equal(atV1.document.metadata.status, "open");
  assert.equal(atV1.document.metadata.priority, 2);

  const atV2 = await runGetItemAt(userId, slug, id, "2");
  assert.equal(atV2.as_of_version, 2);
  assert.equal(atV2.document.metadata.title, "Second title");
  assert.equal(atV2.document.metadata.status, "in_progress");
  // priority/tags change landed in v3, so v2 still shows the original values
  assert.equal(atV2.document.metadata.priority, 2);
  assert.deepEqual(atV2.document.metadata.tags, []);

  const atV3 = await runGetItemAt(userId, slug, id, "3");
  assert.equal(atV3.as_of_version, 3);
  assert.equal(atV3.document.metadata.priority, 4);
  assert.deepEqual(atV3.document.metadata.tags, ["hist", "verify"]);
  assert.ok(typeof atV3.as_of_timestamp === "string" && atV3.as_of_timestamp.length > 0);
});

test("runGetItemAt resolves a history entry by ISO timestamp", async () => {
  const { userId, slug, projectId } = uniqueWorkspace();
  await initWorkspace(userId, slug, projectId);
  const id = await createItem(userId, slug, "Timestamped");
  await updateItem(userId, slug, id, "--title", "After");

  // The first version's timestamp is what `as_of_timestamp` reports for v1.
  const atV1 = await runGetItemAt(userId, slug, id, "1");
  const ts = atV1.as_of_timestamp;

  const byTimestamp = await runGetItemAt(userId, slug, id, ts);
  assert.equal(byTimestamp.as_of_version, 1);
  assert.equal(byTimestamp.target.kind, "timestamp");
  assert.equal(byTimestamp.target.raw, ts);
  assert.equal(byTimestamp.document.metadata.title, "Timestamped");
});

test("runGetItemAt rejects an invalid ref with a USAGE exit code (400 mapping)", async () => {
  const { userId, slug, projectId } = uniqueWorkspace();
  await initWorkspace(userId, slug, projectId);
  const id = await createItem(userId, slug, "Bad ref");
  await assert.rejects(
    () => runGetItemAt(userId, slug, id, "not-a-version-or-timestamp"),
    (err: unknown) => {
      assert.ok(err instanceof PmCliError, "expected a PmCliError");
      assert.equal((err as PmCliError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /Invalid history target/);
      return true;
    },
  );
});

test("runGetItemAt rejects an out-of-range version with a USAGE exit code (400 mapping)", async () => {
  const { userId, slug, projectId } = uniqueWorkspace();
  await initWorkspace(userId, slug, projectId);
  const id = await createItem(userId, slug, "Out of range");
  await updateItem(userId, slug, id, "--title", "v2");

  await assert.rejects(
    () => runGetItemAt(userId, slug, id, "99"),
    (err: unknown) => {
      assert.ok(err instanceof PmCliError);
      assert.equal((err as PmCliError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /between 1 and 2/);
      return true;
    },
  );
});

test("runGetItemAt reports NOT_FOUND (404 mapping) for an unknown item", async () => {
  const { userId, slug, projectId } = uniqueWorkspace();
  await initWorkspace(userId, slug, projectId);
  await createItem(userId, slug, "Exists");
  await assert.rejects(
    () => runGetItemAt(userId, slug, "nope-zzzz", "1"),
    (err: unknown) => {
      assert.ok(err instanceof PmCliError);
      assert.equal((err as PmCliError).exitCode, EXIT_CODE.NOT_FOUND);
      assert.match((err as Error).message, /not found/i);
      return true;
    },
  );
});
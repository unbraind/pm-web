import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { signToken } from "../src/auth.ts";
import { pool } from "../src/db.ts";
import type { Pool } from "pg";

const OWNER_USER_ID = "44444444-4444-4441-8444-444444444444";
const VIEWER_USER_ID = "55555555-5555-4551-8555-555555555555";
const PROJECT_ID = "66666666-6666-4661-8666-666666666666";
const PROJECT_SLUG = "schemahist";

interface Harness {
  root: string;
  pmRoot: string;
  restore: () => Promise<void>;
}

/**
 * Stand up a real pm workspace under a temp `PROJECTS_ROOT`.
 *
 * These two routes dispatch through `runPm`, which serves `schema` and
 * `history-repair` **in-process** via the SDK's `PmClient` rather than spawning
 * the `pm` binary. A fake-binary harness therefore cannot observe them at all, so
 * these are real integration tests: a genuine `pm init` workspace, real effects
 * asserted against the workspace afterwards.
 */
async function setupHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-schema-hist-"));
  const projectDir = path.join(root, OWNER_USER_ID, PROJECT_SLUG);
  await mkdir(projectDir, { recursive: true });
  const pmRoot = path.join(projectDir, ".agents", "pm");
  execFileSync("pm", ["init", "--pm-path", pmRoot], { stdio: "ignore" });

  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;

  return {
    root,
    pmRoot,
    restore: async () => {
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Create a real item in the harness workspace and return its id. */
function createItem(pmRoot: string, title: string): string {
  const out = execFileSync(
    "pm",
    ["create", "--type", "Task", "--title", title, "--pm-path", pmRoot, "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out) as { id?: string; item?: { id?: string } };
  const id = parsed.item?.id ?? parsed.id;
  assert.ok(id, `pm create must return an id, got: ${out.slice(0, 200)}`);
  return id;
}

/**
 * Stub the pg pool so `verifyProjectAccess` resolves without a database.
 *
 * The ownership query returns an `edit` project for {@link OWNER_USER_ID}. When
 * `viewerUserId` is supplied, the shared-access fallback returns the same project
 * with `permission: "view"`, which exercises the real router-level write guard.
 */
function stubPool(viewerUserId?: string): () => void {
  const realQuery = pool.query.bind(pool) as Pool["query"];
  const ownerRow = {
    id: PROJECT_ID,
    name: "Test",
    slug: PROJECT_SLUG,
    description: "",
    prefix: "sh",
    owner_user_id: OWNER_USER_ID,
  };
  Object.defineProperty(pool, "query", {
    configurable: true,
    writable: true,
    value: async (text: string, params?: unknown[]) => {
      const sql = String(text);
      const p = Array.isArray(params) ? params : [];
      if (sql.includes("user_id = $2") && p[0] === PROJECT_ID && p[1] === OWNER_USER_ID) {
        return { rows: [ownerRow], rowCount: 1 };
      }
      if (
        viewerUserId !== undefined &&
        sql.includes("pm_project_shares") &&
        p[0] === PROJECT_ID &&
        p[1] === viewerUserId
      ) {
        return { rows: [{ ...ownerRow, permission: "view" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  return () => {
    Object.defineProperty(pool, "query", { configurable: true, writable: true, value: realQuery });
  };
}

/** Issue a request through a real ephemeral server so the whole stack runs. */
async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  urlPath: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const token = signToken({ userId, email: `${userId}@example.com` });
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = { raw: text };
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* keep raw */ }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("schema/add-type registers a real custom type with all optional fields applied", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const { status, body } = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, {
      name: "Spike",
      description: "Time-boxed investigation",
      defaultStatus: "open",
      folder: "spikes",
      aliases: ["spk", "investigation"],
    });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.registered, true);
    const type = body.type as { name?: string; folder?: string; description?: string };
    assert.equal(type.name, "Spike");
    assert.equal(type.folder, "spikes", "--folder must reach the CLI");
    assert.equal(type.description, "Time-boxed investigation", "--description must reach the CLI");

    // Verify against the workspace itself, not just the response: the new type
    // must be visible to a separate pm invocation.
    const schema = execFileSync("pm", ["schema", "list", "--pm-path", harness.pmRoot, "--json"], { encoding: "utf8" });
    assert.match(schema, /Spike/, "the registered type must be readable by a fresh pm process");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("schema/add-type omits flags for blank optional fields rather than passing empty values", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const { status, body } = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, {
      name: "Chore2",
      description: "   ",
      folder: "",
      aliases: ["", "  "],
    });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const type = body.type as { name?: string; description?: string };
    assert.equal(type.name, "Chore2");
    assert.ok(
      type.description === undefined || type.description === "",
      `a blank description must not be sent as a value, got ${JSON.stringify(type.description)}`,
    );
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("history-repair reports a real chain scan for an existing item and honours dryRun", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const itemId = createItem(harness.pmRoot, "Item under repair");

    const dry = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/${itemId}/history-repair`, OWNER_USER_ID, { dryRun: true });
    assert.equal(dry.status, 200, `expected 200, got ${dry.status}: ${JSON.stringify(dry.body)}`);
    assert.equal(dry.body.id, itemId);
    assert.equal(dry.body.dry_run, true, "dryRun:true must map onto --dry-run");
    const history = dry.body.history as { entries_scanned?: number } | undefined;
    assert.ok((history?.entries_scanned ?? 0) > 0, "a freshly created item has at least one history entry to scan");

    const wet = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/${itemId}/history-repair`, OWNER_USER_ID, { dryRun: false });
    assert.equal(wet.status, 200, `expected 200, got ${wet.status}: ${JSON.stringify(wet.body)}`);
    assert.equal(wet.body.dry_run, false, "dryRun:false must not pass --dry-run");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("history-repair surfaces a missing item as a 400 rather than a success envelope", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const { status, body } = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/sh-nope/history-repair`, OWNER_USER_ID, { dryRun: true });
    assert.equal(status, 400);
    assert.match(String(body.error ?? ""), /not found/i);
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("both routes reject flag-like input with 400 so it can never be parsed as an option", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const addType = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, { name: "--all" });
    assert.equal(addType.status, 400);

    const missingName = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, {});
    assert.equal(missingName.status, 400);

    // `pm history-repair --all` repairs EVERY stream; an item id must never
    // become that flag.
    const repair = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/${encodeURIComponent("--all")}/history-repair`, OWNER_USER_ID, {});
    assert.equal(repair.status, 400, "a '--all' item id must not become a bulk repair of every stream");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("schema/add-type refuses a traversal folder, which would otherwise write items outside the workspace", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    // The CLI honours `..` in --folder: a subsequent `pm create` of the type
    // writes the item .toon above the pm root. In this layout
    // (PROJECTS_ROOT/<ownerUserId>/<slug>/.agents/pm) that reaches other tenants.
    const traversals = [
      "../escape",
      "../../esc-target",
      "../../../../../../tmp/pm-deep-escape",
      "spikes/../../escape",
      "nested/./../..",
      "/absolute",
      "C:\\windows",
      "..\\backslash",
    ];
    for (const folder of traversals) {
      const { status, body } = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, {
        name: `T${traversals.indexOf(folder)}`,
        folder,
      });
      assert.equal(status, 400, `folder ${JSON.stringify(folder)} must be refused, got ${status}: ${JSON.stringify(body)}`);
    }

    // A plain nested folder is still allowed — the guard must not be a blanket ban.
    const ok = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, OWNER_USER_ID, {
      name: "Nested",
      folder: "custom/spikes",
    });
    assert.equal(ok.status, 200, `a plain nested folder must be accepted: ${JSON.stringify(ok.body)}`);

    // Nothing may have been written outside the pm root by the refused attempts.
    const projectDir = path.join(harness.root, OWNER_USER_ID, PROJECT_SLUG);
    for (const stray of ["escape", "esc-target"]) {
      assert.equal(
        existsSync(path.join(projectDir, stray)),
        false,
        `a refused traversal must not create ${stray} in the project dir`,
      );
    }
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("both routes are writes, so a view-only collaborator is refused with 403", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool(VIEWER_USER_ID);
  const app = createApp();
  try {
    const addType = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, VIEWER_USER_ID, { name: "Spike" });
    assert.equal(addType.status, 403, `view-only must be 403, got ${addType.status}: ${JSON.stringify(addType.body)}`);

    const repair = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/sh-a1b2/history-repair`, VIEWER_USER_ID, { dryRun: true });
    assert.equal(repair.status, 403, "a dry run writes nothing but must still stay behind the write guard");

    // The refusal must be an authorization decision, not a side effect: no
    // custom type may have been registered.
    const schema = execFileSync("pm", ["schema", "list", "--pm-path", harness.pmRoot, "--json"], { encoding: "utf8" });
    assert.doesNotMatch(schema, /Spike/, "a 403 must not have registered the type");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("both routes answer 404 for a user with no access to the project", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool();
  const app = createApp();
  try {
    const stranger = "77777777-7777-4771-8777-777777777777";
    const addType = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/schema/add-type`, stranger, { name: "Spike" });
    assert.equal(addType.status, 404);
    const repair = await request(app, "POST", `/api/projects/${PROJECT_ID}/pm/items/sh-a1b2/history-repair`, stranger, {});
    assert.equal(repair.status, 404);
  } finally {
    restorePool();
    await harness.restore();
  }
});

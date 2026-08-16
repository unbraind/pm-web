import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { signToken } from "../src/auth.ts";
import { pool } from "../src/db.ts";
import { addSSEClient, type SSEClient } from "../src/services/sse.ts";
import type { Pool } from "pg";

// Package root: test/ compiles to dist-test/, so go up one level from there.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4221-8222-222222222222";
const PROJECT_ID = "33333333-3333-4331-8333-333333333333";
const PROJECT_SLUG = "pkgtest";

interface FakeResponse {
  writes: string[];
  res: {
    write: (value: string) => boolean;
    end?: () => void;
  };
}

function fakeResponse(): FakeResponse {
  const writes: string[] = [];
  return {
    writes,
    res: {
      write: (value: string) => { writes.push(value); return true; },
      end: () => undefined,
    },
  };
}

interface Harness {
  root: string;
  fakePm: string;
  logPath: string;
  restore: () => Promise<void>;
}

/** Options selecting which fake pm behaviour the harness installs. */
interface HarnessOptions {
  /**
   * Install a fake pm that exits non-zero with a stderr message, so a mutation
   * route sees `runPm` fail and exercises its `if (!result.ok)` 400 branch.
   * Defaults to the success binary used by the happy-path tests.
   */
  fail?: boolean;
  /**
   * Install a fake pm whose `extension --json` output is a valid (empty)
   * extension list, so the GET route takes its healthy `ok` arm and omits the
   * `stateError` degradation field. Defaults to the success binary.
   */
  healthy?: boolean;
}

async function setupHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-ext-routes-"));
  const fakePm = path.join(root, "fake-pm");
  const logPath = path.join(root, "commands.log");

  // The fake pm binary records every invocation. The success variant returns
  // JSON on stdout (the happy path); the fail variant writes to stderr and
  // exits non-zero so `runPm` reports `ok: false` and the route surfaces a
  // 400; the healthy variant returns a valid extension list so the GET route's
  // healthy arm runs. Either way the log proves a spawn happened — it must
  // stay empty for the 400-before-spawn test.
  const script = opts.fail
    ? `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_PM_LOG;
if (log) fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
process.stderr.write("fake-pm: rejected");
process.exit(1);
`
    : opts.healthy
    ? `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_PM_LOG;
if (log) fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ details: { extensions: [] } }));
`
    : `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_PM_LOG;
if (log) fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ ok: true, action: process.argv[3], source: "npm" }));
`;
  await writeFile(fakePm, script);
  await chmod(fakePm, 0o755);

  // The spawn cwd is PROJECTS_ROOT/<ownerUserId>/<slug>; it must exist or the
  // spawn throws ENOENT before the fake pm runs.
  await mkdir(path.join(root, OWNER_USER_ID, PROJECT_SLUG), { recursive: true });

  const previousRoot = process.env.PROJECTS_ROOT;
  const previousBin = process.env.PM_CLI_BIN;
  process.env.PROJECTS_ROOT = root;
  process.env.PM_CLI_BIN = fakePm;
  process.env.FAKE_PM_LOG = logPath;

  return {
    root,
    fakePm,
    logPath,
    restore: async () => {
      if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
      else process.env.PROJECTS_ROOT = previousRoot;
      if (previousBin === undefined) delete process.env.PM_CLI_BIN;
      else process.env.PM_CLI_BIN = previousBin;
      delete process.env.FAKE_PM_LOG;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Stub the pg pool so verifyProjectAccess resolves without a database. The
 * ownership query (text contains `user_id = $2` with params [projectId,
 * userId]) returns the project row only for the owner; every other query
 * (including the shared-access fallback) returns empty, so a non-owner is
 * denied and the route 404s before any pm command runs.
 */
function stubPool(ownerUserId: string, projectId: string, slug: string): () => void {
  const realQuery = pool.query.bind(pool) as Pool["query"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = async (text: string, params?: unknown[]) => {
    const sql = String(text);
    if (
      sql.includes("user_id = $2") &&
      Array.isArray(params) &&
      params[1] === ownerUserId &&
      params[0] === projectId
    ) {
      return {
        rows: [{
          id: projectId,
          name: "Test",
          slug,
          description: "",
          prefix: "pkg",
          owner_user_id: ownerUserId,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = realQuery;
  };
}

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  urlPath: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  // Start a real ephemeral HTTP server with the Express app and fetch against
  // it. This exercises the full middleware + route stack (auth, mergeParams,
  // body parsing) with no test-only HTTP mocking library.
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const token = signToken({ userId, email: `${userId}@example.com` });
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: safeJson(text) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

test("catalog validation: an unknown/injected :name is rejected with 400 before any spawn", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const injected = ["pm-cli", "npm:pm-graph", "..%2Fpm-graph", "pm-graph --project", "PM-GRAPH"];
    for (const name of injected) {
      const { status, body } = await request(
        app,
        "POST",
        `/api/projects/${PROJECT_ID}/extensions/${encodeURIComponent(name)}/install`,
        OWNER_USER_ID,
      );
      assert.equal(status, 400, `unknown name ${name} must be 400, got ${status}: ${JSON.stringify(body)}`);
      assert.match(String((body as { error?: string }).error ?? ""), /Unknown package/i);
    }
    // No pm command must have been spawned for any rejected name.
    const log = await readFile(harness.logPath, "utf8").catch(() => "");
    assert.equal(log, "", "a rejected :name must never reach a pm process spawn");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("route authorization: a user cannot install into a project they do not own", async () => {
  const harness = await setupHarness();
  // The pool stub grants access only to OWNER_USER_ID; the other user is
  // denied at verifyProjectAccess and never reaches a pm command.
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const { status } = await request(
      app,
      "POST",
      `/api/projects/${PROJECT_ID}/extensions/pm-graph/install`,
      OTHER_USER_ID,
    );
    assert.equal(status, 404, "a non-owner must be denied (404), not allowed to install");
    // And no spawn happened for the denied request.
    const log = await readFile(harness.logPath, "utf8").catch(() => "");
    assert.equal(log, "", "a denied request must never spawn a pm command");
  } finally {
    restorePool();
    await harness.restore();
  }
});

/**
 * Stub the pool so `projectId` is shared with `viewerUserId` at the given
 * permission, and owned by nobody the test will authenticate as. Mirrors the
 * two-query shape of `verifyProjectAccess`: direct-ownership lookup first
 * (miss), then the share lookup (hit, carrying `permission`).
 */
function stubSharedPool(
  viewerUserId: string,
  projectId: string,
  slug: string,
  permission: string,
): () => void {
  const realQuery = pool.query.bind(pool) as Pool["query"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = async (text: string, params?: unknown[]) => {
    const sql = String(text);
    const row = {
      id: projectId,
      name: "Test",
      slug,
      description: "",
      prefix: "pkg",
      owner_user_id: OWNER_USER_ID,
      permission,
    };
    const matches = Array.isArray(params) && params[0] === projectId && params[1] === viewerUserId;
    if (sql.includes("pm_project_shares") && matches) {
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = realQuery;
  };
}

test("a view-only collaborator cannot mutate packages but can still list them", async () => {
  // Regression: installing a package changes the workspace for EVERY
  // collaborator, so it is an edit-level action. The mutating routes originally
  // only checked that access existed, not that it was writable, which let a
  // view-only share install and uninstall packages on someone else's project.
  const harness = await setupHarness();
  const restorePool = stubSharedPool(OTHER_USER_ID, PROJECT_ID, PROJECT_SLUG, "view");
  const app = createApp();
  try {
    for (const [method, url] of [
      ["POST", `/api/projects/${PROJECT_ID}/extensions/pm-graph/install`],
      ["POST", `/api/projects/${PROJECT_ID}/extensions/pm-graph/activate`],
      ["POST", `/api/projects/${PROJECT_ID}/extensions/pm-graph/deactivate`],
      ["DELETE", `/api/projects/${PROJECT_ID}/extensions/pm-graph`],
    ] as const) {
      const { status } = await request(app, method, url, OTHER_USER_ID);
      assert.equal(status, 403, `${method} ${url} must be refused for a view-only share`);
    }
    const log = await readFile(harness.logPath, "utf8").catch(() => "");
    assert.equal(log, "", "a view-only request must never spawn a pm command");

    // Reading the catalog stays allowed: a viewer may see what a project uses.
    const { status } = await request(
      app,
      "GET",
      `/api/projects/${PROJECT_ID}/extensions`,
      OTHER_USER_ID,
    );
    assert.equal(status, 200, "a view-only collaborator must still be able to list packages");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("the realtime extensions-changed event fires on a successful install mutation", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  const target = fakeResponse();
  const client: SSEClient = {
    id: "sse-test",
    projectId: PROJECT_ID,
    userId: OWNER_USER_ID,
    displayName: "Owner",
    currentView: "packages",
    res: target.res as unknown as SSEClient["res"],
    connectedAt: new Date(),
  };
  const unsubscribe = addSSEClient(client);
  try {
    const { status, body } = await request(
      app,
      "POST",
      `/api/projects/${PROJECT_ID}/extensions/pm-graph/install`,
      OWNER_USER_ID,
    );
    assert.equal(status, 201, `install must succeed (201), got ${status}: ${JSON.stringify(body)}`);
    // The fake pm binary must have been invoked with the catalog-verified
    // npm:pm-graph spec — never a raw user string.
    const log = await readFile(harness.logPath, "utf8");
    assert.match(log, /install npm:pm-graph --project/);
    // The SSE client on the project must have received an extensions-changed
    // event so collaborators see the install live.
    const events = target.writes.join("");
    assert.match(events, /event: extensions-changed/);
    assert.match(events, /"name":"pm-graph"/);
    assert.match(events, /"operation":"install"/);
  } finally {
    unsubscribe();
    restorePool();
    await harness.restore();
  }
});

test("the GET list includes the category field so the UI can group extensions vs templates", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const { status, body } = await request(
      app,
      "GET",
      `/api/projects/${PROJECT_ID}/extensions`,
      OWNER_USER_ID,
    );
    assert.equal(status, 200);
    const packages = (body as { packages?: Array<{ name: string; category: string }> }).packages ?? [];
    assert.ok(packages.length > 0, "the catalog list must not be empty");
    // Every row must carry a category field.
    for (const row of packages) {
      assert.ok(row.category === "extension" || row.category === "template",
        `row ${row.name} must have category "extension" or "template", got ${row.category}`);
    }
    // The two template entries must be present with category "template".
    const byName = new Map(packages.map((r) => [r.name, r.category]));
    assert.equal(byName.get("pm-starter"), "template",
      "pm-starter must be listed as a template");
    assert.equal(byName.get("pm-ts-starter"), "template",
      "pm-ts-starter must be listed as a template");
    // pm-graph must be an extension.
    assert.equal(byName.get("pm-graph"), "extension",
      "pm-graph must be listed as an extension");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("a request for a non-catalog package name is rejected 400 before any spawn", async () => {
  const harness = await setupHarness();
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    // Names that are valid npm package names but NOT in the catalog must be
    // rejected before any pm process is spawned.
    const nonCatalog = ["../../evil", "pm-web", "lodash"];
    for (const name of nonCatalog) {
      const { status, body } = await request(
        app,
        "POST",
        `/api/projects/${PROJECT_ID}/extensions/${encodeURIComponent(name)}/install`,
        OWNER_USER_ID,
      );
      assert.equal(status, 400,
        `non-catalog name ${name} must be 400, got ${status}: ${JSON.stringify(body)}`);
      assert.match(String((body as { error?: string }).error ?? ""), /Unknown package/i);
    }
    // No pm command must have been spawned for any rejected name.
    const log = await readFile(harness.logPath, "utf8").catch(() => "");
    assert.equal(log, "",
      "a non-catalog name must never reach a pm process spawn");
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("an install that pm rejects is surfaced as 400 carrying pm's stderr", async () => {
  // The install handler's `if (!result.ok)` branch must hand the caller a 400
  // carrying pm's own stderr, so a failed registry resolution reads as a
  // client error rather than a silent 201 or a 500. The install route sets a
  // timeout, so runPm spawns the fake pm rather than serving it in-process.
  const harness = await setupHarness({ fail: true });
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const { status, body } = await request(
      app,
      "POST",
      `/api/projects/${PROJECT_ID}/extensions/pm-graph/install`,
      OWNER_USER_ID,
    );
    assert.equal(status, 400, `a rejected install must be 400, got ${status}`);
    assert.match(
      String((body as { error?: string }).error ?? ""),
      /fake-pm: rejected/i,
      "the 400 must carry pm's stderr so the caller sees why it failed",
    );
    // The catalog-verified npm spec must still have reached pm — the rejection
    // happened inside pm, not before the spawn.
    const log = await readFile(harness.logPath, "utf8");
    assert.match(log, /install npm:pm-graph --project/);
  } finally {
    restorePool();
    await harness.restore();
  }
});

test("a healthy extension read lists packages without a stateError field", async () => {
  // When `pm extension --json` returns a valid list the GET route takes its
  // healthy `ok` arm and omits `stateError`, so a healthy project is
  // distinguishable from one whose state read failed. The degraded arm is
  // covered by the other GET tests (the success fake returns non-list JSON);
  // this one pins the healthy contract.
  const harness = await setupHarness({ healthy: true });
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const { status, body } = await request(
      app,
      "GET",
      `/api/projects/${PROJECT_ID}/extensions`,
      OWNER_USER_ID,
    );
    assert.equal(status, 200);
    const payload = body as { packages?: unknown[]; stateError?: string };
    assert.ok(Array.isArray(payload.packages) && payload.packages.length > 0,
      "the catalog list must still render");
    assert.equal(payload.stateError, undefined,
      "a healthy read must not surface a stateError");
  } finally {
    restorePool();
    await harness.restore();
  }
});
test("an unreleased package is listed but refuses install without spawning pm", async () => {
  // pm-vcs and pm-rl are catalogued so the UI can show them honestly, but they
  // have no published release. The route must refuse BEFORE spawning anything:
  // a `pm install npm:pm-vcs` would fail against the registry with a 404 the
  // user cannot act on, and would still have cost a process spawn.
  const harness = await setupHarness();
  const restorePool = stubPool(OWNER_USER_ID, PROJECT_ID, PROJECT_SLUG);
  const app = createApp();
  try {
    const listed = await request(
      app,
      "GET",
      `/api/projects/${PROJECT_ID}/extensions`,
      OWNER_USER_ID,
    );
    assert.equal(listed.status, 200);
    const rows = (listed.body as { packages: { name: string; availability?: string }[] }).packages;
    const unreleased = rows.filter((row) => row.availability === "unreleased").map((row) => row.name);
    assert.ok(
      unreleased.length > 0,
      "the catalog must surface its unreleased packages to the UI rather than hiding them",
    );

    for (const name of unreleased) {
      const { status, body } = await request(
        app,
        "POST",
        `/api/projects/${PROJECT_ID}/extensions/${encodeURIComponent(name)}/install`,
        OWNER_USER_ID,
      );
      assert.equal(
        status,
        409,
        `installing unreleased ${name} must be refused with 409, got ${status}: ${JSON.stringify(body)}`,
      );
      assert.match(
        (body as { error: string }).error,
        /not published to npm/,
        `${name}: the refusal must say why, not just fail`,
      );
    }

    // The decisive assertion: no pm process ran for any of them.
    const log = await readFile(harness.logPath, "utf8").catch(() => "");
    for (const name of unreleased) {
      assert.ok(
        !log.includes(`install npm:${name}`),
        `${name}: the route must refuse before spawning pm, but the fake binary was invoked`,
      );
    }
  } finally {
    restorePool();
    await harness.restore();
  }
});

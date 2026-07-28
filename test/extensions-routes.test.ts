import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import test from "node:test";

import { createApp } from "../dist/app.js";
import { signToken } from "../dist/auth.js";
import { pool } from "../dist/db.js";
import { addSSEClient, type SSEClient } from "../dist/services/sse.js";
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

async function setupHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-ext-routes-"));
  const fakePm = path.join(root, "fake-pm");
  const logPath = path.join(root, "commands.log");

  // The fake pm binary records every invocation and returns success JSON. If
  // the catalog gate ever lets an unknown name through, this log proves a
  // spawn happened (it must stay empty for the 400-before-spawn test).
  await writeFile(fakePm, `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_PM_LOG;
if (log) fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ ok: true, action: process.argv[3], source: "npm" }));
`);
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
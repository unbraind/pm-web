import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ensureSchema, seedUser, seedProject } from "./helpers/pg-harness.ts";
import { connectLiveSSE } from "./helpers/live-sse.ts";
import { startObservableServer, waitObservable } from "./helpers/observable-server.ts";
import { signToken } from "../src/auth.ts";
import type { RealtimeCounters } from "../src/services/realtime-observability.ts";

const execute = promisify(execFile);
/** Run a separate pinned pm process against only the disposable project tracker. */
async function externalPm(dir: string, args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "synthetic-writer" };
  delete env.PM_PATH;
  const target = args[0] === "workspace" ? [] : ["--pm-path", path.join(dir, ".agents", "pm")];
  await execute(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    ...target, "--no-extensions", ...args], { cwd: dir, env, timeout: 15_000 });
}

/** Initialize only the disposable workspace through the real pinned CLI. */
async function initializeWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await externalPm(dir, ["workspace", "init", "--workspace", dir, "--prefix", "observable", "--defaults", "--agent-guidance", "skip"]);
}

/** Fetch aggregate counters through the public health endpoint, not an in-process seam. */
async function health(url: string): Promise<RealtimeCounters> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; realtime: RealtimeCounters };
  assert.equal(body.ok, true);
  return body.realtime;
}

test("real production server delivers a separate pm write over HTTP SSE and advances live counters", { timeout: 45_000 }, async () => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-observable-"));
  const owner = await seedUser();
  const project = await seedProject(owner.id);
  const dir = path.join(root, owner.id, project.slug);
  let server: Awaited<ReturnType<typeof startObservableServer>> | undefined;
  let stream: Awaited<ReturnType<typeof connectLiveSSE>> | undefined;
  try {
    await initializeWorkspace(dir);
    await externalPm(dir, ["create", "task", "Synthetic baseline", "--id", "baseline"]);
    server = await startObservableServer(root);
    const initial = await health(server.url("/healthz"));
    assert.equal(initial.sse_clients, 0);
    stream = await connectLiveSSE(server, owner, project.id);
    await stream.waitFor((events) => events.some((event) => event.type === "connected"));
    const connected = await health(server.url("/healthz"));
    assert.equal(connected.sse_clients, 1);
    assert.equal(connected.sse_connections_total, initial.sse_connections_total + 1);
    await waitObservable(() => server!.logs.some((log) => log.event === "watcher_sweep" && Number(log.files_scanned) >= 2), "connected project's baseline is scanned before the external write");
    const before = await health(server.url("/healthz"));
    await externalPm(dir, ["create", "task", "Secret synthetic item title", "--id", "external"]);
    await stream.waitFor((events) => events.some((event) => event.type === "workspace-changed" && event.data.source === "filesystem"));
    const after = await health(server.url("/healthz"));
    assert.ok(after.broadcasts_total > before.broadcasts_total);
    assert.ok(after.watcher_changes_total > before.watcher_changes_total);
    assert.ok(after.watcher_last_sweep_at);
    assert.equal(after.watcher_errors_total, 0);
    assert.ok(server.logs.some((log) => log.event === "sse_broadcast" && log.event_type === "workspace-changed" && log.recipient_count === 1));
    await stream.close();
    stream = undefined;
    await waitObservable(() => server!.logs.some((log) => log.event === "sse_disconnect"), "socket close is observable");
    const disconnected = await health(server.url("/healthz"));
    assert.equal(disconnected.sse_clients, 0);
    assert.equal(disconnected.sse_disconnections_total, 1);
  } finally {
    await stream?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("privacy: production stdout excludes email, bearer, cookies, ids, titles and query strings", { timeout: 45_000 }, async () => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-private-log-"));
  const owner = await seedUser();
  const project = await seedProject(owner.id);
  const dir = path.join(root, owner.id, project.slug);
  await initializeWorkspace(dir);
  const title = "PRIVATE_ITEM_TITLE_SENTINEL";
  const query = "PRIVATE_QUERY_SENTINEL";
  const cookie = "PRIVATE_COOKIE_SENTINEL";
  const itemId = "observable-private-item-id-sentinel";
  await externalPm(dir, ["create", "task", title, "--id", itemId]);
  const server = await startObservableServer(root);
  const token = signToken({ userId: owner.id, email: owner.email });
  try {
    const response = await fetch(server.url(`/api/projects/${project.id}/pm/update/${itemId}?search=${query}`), {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, cookie: `private=${cookie}`, "content-type": "application/json", "x-request-id": query },
      body: JSON.stringify({ title, email: owner.email }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const invalid = await fetch(server.url(`/api/auth/login?query=${query}`), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: `{"email":"${owner.email}","title":"${title}",`,
    });
    assert.equal(invalid.status, 400);
    await invalid.text();
    await fetch(server.url(`/unknown/${itemId}?token=${token}`)).then((res) => res.text());
    await waitObservable(() => server.logs.filter((log) => log.event === "request").length === 3, "all requests are logged exactly once");
    const logs = server.stdout();
    for (const secret of [owner.email, owner.id, project.id, token, title, query, cookie, itemId]) {
      assert.equal(logs.includes(secret), false, "stdout must exclude every request sentinel");
    }
    const request = server.logs.find((log) => log.event === "request" && log.method === "PATCH");
    assert.equal(request?.route, "/api/projects/:projectId/pm/update/:itemId");
    assert.match(String(request?.user_hash), /^[a-f0-9]{64}$/);
    assert.match(String(request?.request_id), /^[a-f0-9-]{36}$/);
    assert.equal(typeof request?.duration_ms, "number");
    assert.ok(server.logs.some((log) => log.event === "unhandled_error" && typeof log.stack === "string"));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

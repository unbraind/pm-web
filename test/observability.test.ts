import { captureLogs } from "./helpers/stdout-logs.ts";
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { logEvent, logError, opaqueHash, requestLogging, logRoutePrefix, unhandledErrorLogging } from "../src/observability.ts";
import { configureWatcherHealth, recordSweep, realtimeHealth, WATCHER_STALE_INTERVALS } from "../src/services/realtime-observability.ts";
import { createProjectWatchCycle, startProjectWatcher } from "../src/services/project-watcher.ts";
import { createHealthHandler } from "../src/health.ts";
import { startEphemeralServer } from "./helpers/ephemeral-server.ts";
import { ensureSchema } from "./helpers/pg-harness.ts";
import { pool } from "../src/db.ts";

test("JSON logging enforces every severity threshold and separates hash domains", (t) => {
  const output = captureLogs(t);
  const previous = process.env.LOG_LEVEL;
  t.after(() => { if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous; });
  delete process.env.LOG_LEVEL;
  logEvent("info_default");
  logEvent("debug_hidden", {}, "debug");
  process.env.LOG_LEVEL = "warn";
  logEvent("hidden");
  logEvent("warning", { count: 2 }, "warn");
  process.env.LOG_LEVEL = "error";
  logEvent("hidden_warning", {}, "warn");
  logEvent("failure", {}, "error");
  process.env.LOG_LEVEL = "silent";
  logEvent("hidden_failure", {}, "error");
  process.env.LOG_LEVEL = "invalid";
  logEvent("fallback");
  process.env.LOG_LEVEL = "__proto__";
  logEvent("prototype_fallback");
  logEvent("prototype_debug_hidden", {}, "debug");
  process.env.LOG_LEVEL = "debug";
  logEvent("debug_visible", {}, "debug");
  assert.deepEqual(output.map((line) => (JSON.parse(line) as { event: string }).event), ["info_default", "warning", "failure", "fallback", "prototype_fallback", "debug_visible"]);
  assert.ok(output.every((line) => line.endsWith("\n") && line.split("\n").length === 2));
  assert.equal(opaqueHash("user", "synthetic-id"), opaqueHash("user", "synthetic-id"));
  assert.notEqual(opaqueHash("user", "synthetic-id"), opaqueHash("project", "synthetic-id"));
});

test("unknown errors and malicious messages, names and stacks cannot leak request text", (t) => {
  const output = captureLogs(t);
  const error = new Error("PRIVATE_MESSAGE");
  error.name = "PRIVATE_NAME";
  error.stack = "PRIVATE_MESSAGE\n    at PRIVATE_FUNCTION (PRIVATE_PATH:12:34)\nPRIVATE_STACK";
  logError("unhandled_error", error);
  logError("unhandled_error", { password: "PRIVATE_PASSWORD" });
  const plain = new TypeError("PRIVATE_TYPE_ERROR");
  plain.stack = undefined;
  logError("unhandled_error", plain);
  logError("unhandled_error", new Error("PRIVATE_MODULE_ERROR"));
  assert.equal(output.join("").includes("PRIVATE"), false);
  assert.equal((JSON.parse(output[0]) as { stack: string }).stack, "at server:12:34");
});

test("watcher freshness has a bounded startup grace, errors degrade and successful sweeps recover", () => {
  configureWatcherHealth(500, true);
  const started = Date.now();
  assert.equal(WATCHER_STALE_INTERVALS, 3);
  assert.equal(realtimeHealth(started).ok, true);
  assert.equal(realtimeHealth(started + 1501).ok, false);
  recordSweep(9, 3, 2, 1);
  const failure = realtimeHealth();
  assert.equal(failure.ok, false);
  assert.equal(failure.counters.watcher_last_sweep_ms, 9);
  assert.ok(failure.counters.watcher_changes_total >= 2);
  assert.ok(failure.counters.watcher_errors_total >= 1);
  recordSweep(4, 3, 0, 0);
  const healthy = realtimeHealth();
  assert.equal(healthy.ok, true);
  const at = Date.parse(healthy.counters.watcher_last_sweep_at!);
  assert.equal(realtimeHealth(at + 1500).ok, true);
  assert.equal(realtimeHealth(at + 1501).ok, false);
  healthy.counters.watcher_errors_total = -100;
  assert.ok(realtimeHealth().counters.watcher_errors_total >= 1, "snapshot cannot mutate internal counters");
  configureWatcherHealth(500, false);
  assert.equal(realtimeHealth().ok, false, "disabled watcher cannot claim collaboration health");
});

test("live stale watcher overrides cached successful database and mount probes", async () => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-watch-health-"));
  configureWatcherHealth(500, true);
  recordSweep(1, 0, 0, 0);
  const at = Date.parse(realtimeHealth().counters.watcher_last_sweep_at!);
  let now = at;
  const app = express();
  app.get("/healthz", createHealthHandler({ pool, projectsRoot: root, version: "synthetic", realtime: () => realtimeHealth(now) }));
  const server = await startEphemeralServer(app);
  try {
    const first = await fetch(server.url("/healthz"));
    assert.equal(first.status, 200);
    now = at + 1501;
    const stale = await fetch(server.url("/healthz"));
    assert.equal(stale.status, 503);
    const body = await stale.json() as { ok: boolean; status: string; dependencies: Record<string, { ok: boolean }>; realtime: Record<string, unknown> };
    assert.equal(body.ok, false);
    assert.equal(body.status, "degraded");
    assert.equal(body.dependencies.postgres.ok, true);
    assert.equal(body.dependencies.projects_root.ok, true);
    assert.equal(body.dependencies.project_watcher.ok, false);
    assert.equal(Object.keys(body.realtime).length, 8);
    now = at;
    assert.equal((await fetch(server.url("/healthz"))).status, 200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem sweep errors are counted and logged rather than treated as missing files", async (t) => {
  const output = captureLogs(t);
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-watch-error-"));
  try {
    await mkdir(path.join(root, ".agents", "pm"), { recursive: true });
    await writeFile(path.join(root, ".agents", "pm", "tasks"), "not a directory");
    const before = realtimeHealth().counters.watcher_errors_total;
    const stop = startProjectWatcher({ intervalMs: 500 });
    stop();
    const cycle = createProjectWatchCycle({ getActiveProjectIds: () => ["synthetic-project"], resolveProjectDir: async () => root });
    await cycle.tick();
    assert.equal(realtimeHealth().counters.watcher_errors_total, before + 1);
    const log = output.map((line) => JSON.parse(line) as { event: string; errors: number }).find((entry) => entry.event === "watcher_sweep");
    assert.equal(log?.errors, 1);
    const previous = process.env.PM_WATCH_PROJECTS;
    process.env.PM_WATCH_PROJECTS = "false";
    startProjectWatcher()();
    assert.equal(realtimeHealth().ok, false);
    if (previous === undefined) delete process.env.PM_WATCH_PROJECTS;
    else process.env.PM_WATCH_PROJECTS = previous;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health requests are suppressed and unmatched and router failures use safe templates", async (t) => {
  const output = captureLogs(t);
  const app = express();
  app.use(requestLogging());
  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  const router = express.Router();
  router.get("/:itemId", () => { throw new Error("PRIVATE_ITEM_BODY"); });
  app.use("/projects/:projectId", logRoutePrefix("/projects/:projectId"), router);
  app.use((_req, res) => { res.status(404).end(); });
  app.use(unhandledErrorLogging);
  const server = await startEphemeralServer(app);
  try {
    await fetch(server.url("/healthz"));
    await fetch(server.url("/unknown/PRIVATE_ID"));
    assert.equal((await fetch(server.url("/projects/PRIVATE_PROJECT/PRIVATE_ITEM"))).status, 500);
    const logs = output.map((line) => JSON.parse(line) as { event: string; route: string });
    assert.deepEqual(logs.filter((entry) => entry.event === "request").map((entry) => entry.route), ["/unmatched", "/projects/:projectId/:itemId"]);
    assert.equal(output.join("").includes("PRIVATE"), false);
  } finally {
    await server.close();
  }
});

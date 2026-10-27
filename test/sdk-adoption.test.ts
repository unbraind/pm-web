/** Exercise SDK adoption against real trackers outside any Git repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { acquireLock, listMutationEvents, readSettings, writeSettings, writeWorkspaceJsonWithHistory } from "@unbrained/pm-cli/sdk";
import { configureLocalOllamaSearch, projectExists } from "../src/services/pm-runner.ts";
import { workspaceInitialized } from "../src/tracker-preflight.ts";

/** Initialize a disposable tracker with the pinned CLI and fence off parent Git discovery. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-sdk-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pmRoot = path.join(root, ".agents", "pm");
  const init = spawnSync(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--pm-path", pmRoot, "init", "--prefix", "sdk", "--defaults", "--agent-guidance", "skip"],
  { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(init.status, 0, init.stderr);
  return { root, pmRoot, settingsPath: path.join(pmRoot, "settings.json") };
}

test("SDK preflight rejects incomplete and unreadable markers without revealing paths", async t => {
  const { root, pmRoot } = await fixture(t);
  assert.equal(await workspaceInitialized(pmRoot), true);
  assert.equal(await workspaceInitialized(""), false);
  assert.equal(await workspaceInitialized(path.join(root, "absent")), false);
  assert.equal(await workspaceInitialized(path.join(pmRoot, "settings.json")), false);
  await chmod(pmRoot, 0o111);
  try { assert.equal(await workspaceInitialized(pmRoot), false); }
  finally { await chmod(pmRoot, 0o755); }
  await rm(path.join(pmRoot, "settings.json"));
  await mkdir(path.join(pmRoot, "tasks"), { recursive: true });
  assert.equal(await workspaceInitialized(pmRoot), false, "tasks alone must not admit a tracker");
  const previous = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  try {
    // An enclosing initialized tracker must not stand in for the selected project.
    assert.equal(await projectExists("owner", "missing"), false);
    const child = path.join(root, "owner", "present", ".agents", "pm");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(child, "settings.json"), "{}");
    assert.equal(await projectExists("owner", "present"), true);
    await chmod(child, 0o111);
    try { assert.equal(await projectExists("owner", "present"), false); }
    finally { await chmod(child, 0o755); }
  } finally {
    if (previous === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previous;
  }
});

test("Ollama SDK writes preserve opaque keys, telemetry and verified audit history", async t => {
  const { root, pmRoot, settingsPath } = await fixture(t);
  const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  raw.opaque_future = { nested: ["keep", 42] };
  const providers = raw.providers as Record<string, unknown>;
  const ollama = providers.ollama as Record<string, unknown>;
  raw.providers = { ...providers, ollama: { ...ollama, opaque_provider: "keep" }, future_provider: { opaque: true } };
  raw.telemetry = { ...raw.telemetry as object, enabled: false, opaque_telemetry: "keep" };
  await writeWorkspaceJsonWithHistory({ pmRoot, filePath: settingsPath, raw: JSON.stringify(raw),
    op: "test.seed-opaque-settings", author: "test-writer", lockTtlSeconds: 60, lockWaitMs: 5000 });
  await configureLocalOllamaSearch(root);
  const after = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(after.opaque_future, raw.opaque_future);
  assert.deepEqual(after.telemetry, raw.telemetry);
  assert.deepEqual(after.providers, { ...raw.providers as object,
    ollama: { ...ollama, opaque_provider: "keep", base_url: process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://localhost:11434",
      model: process.env.PM_OLLAMA_MODEL || "qwen3-embedding:0.6b" } });
  const history = await readFile(path.join(pmRoot, "history", "_workspace.jsonl"), "utf8");
  assert.match(history, /web.configure-local-ollama-search/);
  const verified = spawnSync(process.execPath, [path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
    "--pm-path", pmRoot, "history", "_workspace", "--verify", "--json"], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  await rm(settingsPath);
  await configureLocalOllamaSearch(root);
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("Ollama SDK delta waits for the workspace lock and survives a disjoint stale SDK edit", async t => {
  const { root, pmRoot, settingsPath } = await fixture(t);
  const seed = await readSettings(pmRoot);
  seed.locks.wait_ms = 5000;
  await writeSettings(pmRoot, seed);
  const concurrent = await readSettings(pmRoot);
  concurrent.search.max_results = 37;
  const unlock = await acquireLock(pmRoot, "workspace-history", 60, "test-writer");
  let settled = false;
  const pending = configureLocalOllamaSearch(root).finally(() => { settled = true; });
  try {
    await delay(250);
    assert.equal(settled, false, "the settings writer must wait for the SDK workspace lock");
  } finally { await unlock(); }
  await pending;
  await writeSettings(pmRoot, concurrent);
  const after = await readSettings(pmRoot);
  assert.equal(after.search.max_results, 37);
  assert.equal(after.search.embedding_model, process.env.PM_OLLAMA_MODEL || "qwen3-embedding:0.6b");
  assert.equal(after.vector_store.lancedb.path, ".agents/pm/search/lancedb/");
  assert.ok(await readFile(settingsPath, "utf8"));
});

test("Ollama write detects history corruption after SDK caches were primed and compensates settings", async t => {
  const { root, pmRoot, settingsPath } = await fixture(t);
  await configureLocalOllamaSearch(root);
  const snapshot = await readSettings(pmRoot);
  snapshot.search.embedding_model = "synthetic-other-model";
  await writeSettings(pmRoot, snapshot);
  await listMutationEvents({ pmRoot });
  await readSettings(pmRoot);
  const historyPath = path.join(pmRoot, "history", "_workspace.jsonl");
  const history = await readFile(historyPath, "utf8");
  const entries = history.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  entries[0].after_hash = "0".repeat(64);
  const corrupt = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(historyPath, corrupt);
  const before = await readFile(settingsPath, "utf8");
  await assert.rejects(configureLocalOllamaSearch(root), /Workspace history verification failed/);
  assert.equal(await readFile(settingsPath, "utf8"), before, "no settings change survives the failed verification");
  assert.equal(await readFile(historyPath, "utf8"), corrupt, "corrupt history is preserved as evidence");
});


test("Ollama refuses invalid settings rather than persisting SDK fallback defaults", async t => {
  const { root, settingsPath } = await fixture(t);
  for (const raw of ["{", '{"search":{"max_results":"invalid"},"opaque":"keep"}']) {
    await writeFile(settingsPath, raw);
    await assert.rejects(configureLocalOllamaSearch(root), /repair invalid tracker settings first/);
    assert.equal(await readFile(settingsPath, "utf8"), raw);
  }
});

test("SDK settings and tracker admission work when PATH contains no Git", async t => {
  const { root } = await fixture(t);
  const child = spawnSync(process.execPath, [path.resolve("test/helpers/sdk-adoption-no-git.ts"), root],
    { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(child.status, 0, child.stderr);
});

test("web doctor reports marker-only and unreadable trackers as uninitialized", async t => {
  const { root, pmRoot } = await fixture(t);
  const marker = path.join(root, "marker-only");
  await mkdir(path.join(marker, "tasks"), { recursive: true });
  /** Invoke the built command and retain its public workspace readiness check. */
  const check = (tracker: string) => {
    const child = spawnSync(process.execPath, ["test/helpers/startup-command.ts", "web doctor", '{"port":"0"}'],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", TEST_PM_ROOT: tracker } });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout.trim()) as { checks: Array<{ name: string; ok: boolean }> };
    return report.checks.find(entry => entry.name === "workspace_initialized")?.ok;
  };
  assert.equal(check(pmRoot), true);
  assert.equal(check(marker), false);
  await chmod(pmRoot, 0o111);
  try { assert.equal(check(pmRoot), false); }
  finally { await chmod(pmRoot, 0o755); }
});

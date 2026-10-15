/** Real HTTP provisioning acceptance with a disposable tracker and genuine npm install. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authCookie, authedFetch, ensureSchema, seedProject, seedUser, seedUserShare, startApp } from "./helpers/pg-harness.ts";

/** Capture exact persisted extension state, including registry absence before installation. */
async function extensionState(pmRoot: string): Promise<Array<Buffer | null>> {
  return Promise.all(["settings.json", "extensions/.managed-extensions.json"].map(async (file) => {
    try {
      return await readFile(path.join(pmRoot, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
}

test("only a CSRF-protected editor POST provisions once, including concurrent retries", { timeout: 180_000 }, async (t) => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "graph-provision-"));
  const fixture: { server?: Awaited<ReturnType<typeof startApp>> } = {};
  const previous = { root: process.env.PROJECTS_ROOT, bin: process.env.PM_CLI_BIN, log: process.env.PM_WEB_PROVISION_LOG };
  const owner = await seedUser();
  const editor = await seedUser();
  const viewer = await seedUser();
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, editor.id, "edit");
  await seedUserShare(project.id, viewer.id, "view");
  const workspace = path.join(root, owner.id, project.slug);
  const pmRoot = path.join(workspace, ".agents", "pm");
  process.env.PROJECTS_ROOT = root;
  t.after(async () => {
    await fixture.server?.close();
    for (const [key, value] of Object.entries({ PROJECTS_ROOT: previous.root, PM_CLI_BIN: previous.bin, PM_WEB_PROVISION_LOG: previous.log })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspace, { recursive: true });
  execFileSync(path.resolve("node_modules/.bin/pm"), ["init", "fixture", "--path", pmRoot], { cwd: workspace, stdio: "ignore" });
  const log = path.join(root, "commands.jsonl");
  const wrapper = path.join(root, "pm-wrapper.ts");
  await writeFile(wrapper, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(process.env.PM_WEB_PROVISION_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const result = spawnSync(${JSON.stringify(path.resolve("node_modules/.bin/pm"))}, process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  process.env.PM_CLI_BIN = wrapper;
  process.env.PM_WEB_PROVISION_LOG = log;
  const running = await startApp();
  fixture.server = running;
  const url = `/api/projects/${project.id}/pm/graph`;
  const before = await extensionState(pmRoot);
  for (const user of [owner, editor, viewer]) {
    const response = await authedFetch(running, user, url);
    assert.equal(response.status, 200);
    assert.deepEqual(await extensionState(pmRoot), before, "GET must leave settings and extension registry byte-identical");
    const graph = await response.json() as { canProvision: boolean; extensionAvailable: boolean; graph: { source: string } };
    assert.equal(graph.canProvision, user !== viewer);
    assert.equal(graph.extensionAvailable, false);
    assert.equal(graph.graph.source, "pm-web");
  }
  assert.equal((await fetch(running.url(url), { headers: { cookie: authCookie(viewer).split(";")[0], origin: "https://foreign.example", "sec-fetch-site": "cross-site" } })).status, 200);
  assert.equal((await authedFetch(running, viewer, `${url}/provision`, { method: "POST" })).status, 403);
  const refusedHeaders: Record<string, string>[] = [
    { cookie: authCookie(editor) },
    { cookie: authCookie(editor), "x-csrf-token": "pm-web-test-csrf", origin: "https://foreign.example", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of refusedHeaders) {
    assert.equal((await fetch(running.url(`${url}/provision`), { method: "POST", headers })).status, 403);
  }
  assert.deepEqual(await extensionState(pmRoot), before, "GET and refused POST requests leave settings and registry byte-identical");
  assert.equal(await readFile(log, "utf8").catch(() => ""), "", "observational reads never invoke the extension CLI");

  const responses = await Promise.all([1, 2].map(() => authedFetch(running, editor, `${url}/provision`, { method: "POST" })));
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, installed: true, active: true });
  }
  const installed = await extensionState(pmRoot);
  assert.ok(installed[1], "the genuine installer persisted a managed extension registry");
  const retry = await authedFetch(running, editor, `${url}/provision`, { method: "POST" });
  assert.equal(retry.status, 200, await retry.text());
  assert.deepEqual(await extensionState(pmRoot), installed, "an editor retry is byte-idempotent");
  const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(commands.filter(([action]) => action === "install").length, 1);
  assert.ok(commands.filter(([action, verb]) => action === "extension" && verb === "activate").length <= 1);
  const activeGet = await authedFetch(running, viewer, url);
  assert.equal((await activeGet.json() as { extensionAvailable: boolean }).extensionAvailable, true);
  assert.deepEqual(await extensionState(pmRoot), installed, "reading the installed export model cannot alter extension state");

  const settings = JSON.parse((installed[0] as Buffer).toString()) as { extensions: { disabled: string[] } };
  settings.extensions.disabled = ["pm-graph"];
  await writeFile(path.join(pmRoot, "settings.json"), JSON.stringify(settings));
  const disabled = await extensionState(pmRoot);
  const disabledGet = await authedFetch(running, viewer, url);
  const fallback = await disabledGet.json() as { extensionAvailable: boolean; graph: { source: string } };
  assert.equal(fallback.extensionAvailable, false);
  assert.equal(fallback.graph.source, "pm-web");
  assert.deepEqual(await extensionState(pmRoot), disabled, "GET cannot reactivate an explicitly disabled extension");
});

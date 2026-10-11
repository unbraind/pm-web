/** Built HTTP acceptance over a real project tracker, registry install and activated extension. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../dist/app.js";
import { signToken } from "../dist/auth.js";
import { pool } from "../dist/db.js";
import type { PackageCatalogRow } from "../dist/routes/extensions.js";

after(() => pool.end());

/** All public fleet identities requested for the Packages view, including the native CLI. */
const FLEET_NAMES = "pm-ado pm-beads pm-brief pm-changelog pm-context pm-csv pm-gantt-chart pm-github pm-graph pm-jev pm-jira pm-linear pm-ops pm-presets pm-rl pm-rust pm-slack pm-slack-standup pm-starter pm-todos pm-ts-starter pm-vcs".split(" ");

test("built server lists the full fleet, installs and enables npm Presets, executes it, and refuses unpublished packages", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-install-e2e-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  const owner = randomUUID();
  const projectId = randomUUID();
  const viewer = randomUUID();
  const slug = "synthetic-catalog";
  const project = path.join(root, owner, slug);
  const pmRoot = path.join(project, ".agents", "pm");
  const cli = path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const server = http.createServer(createApp());
  try {
    process.env.PROJECTS_ROOT = root;
    await mkdir(project, { recursive: true });
    const env = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "synthetic-catalog", HOME: root };
    execFileSync(process.execPath, [cli, "workspace", "init", "--workspace", project, "--prefix", "scratch", "--defaults", "--agent-guidance", "skip"], { cwd: project, env, stdio: "pipe" });
    execFileSync(process.execPath, [cli, "create", "Synthetic catalog item", "--type", "Task"], { cwd: project, env, stdio: "pipe" });
    await pool.query("INSERT INTO pm_users (id, email, password_hash) VALUES ($1, $2, 'synthetic')", [owner, `${owner}@example.test`]);
    await pool.query("INSERT INTO pm_projects (id, user_id, name, slug, prefix) VALUES ($1, $2, 'Synthetic catalog', $3, 'scratch')", [projectId, owner, slug]);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/projects/${projectId}/extensions`;
    const headers = { authorization: `Bearer ${signToken({ userId: owner, email: `${owner}@example.test` })}`, "content-type": "application/json" };
    const initial = await fetch(base, { headers });
    assert.equal(initial.status, 200);
    const listing = await initial.json() as { packages: PackageCatalogRow[]; stateError?: string };
    assert.equal(listing.stateError, undefined);
    assert.deepEqual(listing.packages.map((row) => row.name).sort(), [...FLEET_NAMES].sort());
    for (const row of listing.packages) {
      assert.ok(row.description && row.commands.length > 0 && row.links?.docs && row.links.repository && row.links.report, `${row.name}: complete verified metadata`);
      assert.equal(row.npmName, row.category === "native" ? null : row.name);
    }
    await pool.query("INSERT INTO pm_users (id, email, password_hash) VALUES ($1, $2, 'synthetic')", [viewer, `${viewer}@example.test`]);
    await pool.query("INSERT INTO pm_project_shares (project_id, shared_with_user_id, permission) VALUES ($1, $2, 'view')", [projectId, viewer]);
    const denied = await fetch(`${base}/pm-presets/run`, { method: "POST", headers: { ...headers, authorization: `Bearer ${signToken({ userId: viewer, email: `${viewer}@example.test` })}` }, body: JSON.stringify({ command: "pm presets", args: ["--list"] }) });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /view-only/);
    const inactive = await fetch(`${base}/pm-presets/run`, { method: "POST", headers, body: JSON.stringify({ command: "pm presets list", args: [] }) });
    assert.equal(inactive.status, 409);
    assert.match(await inactive.text(), /Install and enable/);
    for (const body of [
      {}, { command: "pm presets list", args: "--json" },
      { command: "pm presets list", args: [1] },
      { command: "pm init", args: [] },
      { command: "pm presets list", args: ["--workspace=other"] },
    ]) {
      const invalid = await fetch(`${base}/pm-presets/run`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(invalid.status, 400, await invalid.text());
    }
    const nativeCommand = await fetch(`${base}/pm-rust/run`, { method: "POST", headers, body: JSON.stringify({ command: "pm-rust list", args: [] }) });
    assert.equal(nativeCommand.status, 400);
    const nativeEnable = await fetch(`${base}/pm-rust/activate`, { method: "POST", headers });
    assert.equal(nativeEnable.status, 409);
    assert.match(await nativeEnable.text(), /native CLI, not an npm extension/);
    const install = await fetch(`${base}/pm-presets/install`, { method: "POST", headers });
    assert.equal(install.status, 201, await install.text());
    const enable = await fetch(`${base}/pm-presets/activate`, { method: "POST", headers });
    assert.equal(enable.status, 200, await enable.text());
    const active = await (await fetch(base, { headers })).json() as { packages: PackageCatalogRow[]; stateError?: string };
    assert.equal(active.stateError, undefined);
    const presets = active.packages.find((row) => row.name === "pm-presets");
    assert.ok(presets?.installed && presets.active && presets.enabled && presets.runtimeActive, JSON.stringify(presets));
    assert.ok(presets.version);
    const run = await fetch(`${base}/pm-presets/run`, { method: "POST", headers, body: JSON.stringify({ command: "pm presets list", args: ["--json"] }) });
    assert.equal(run.status, 200, await run.clone().text());
    assert.match(await run.text(), /software-sprint/);
    const before = await readFile(path.join(pmRoot, "settings.json"), "utf8");
    for (const name of ["pm-ado", "pm-rust"]) {
      const refused = await fetch(`${base}/${name}/install`, { method: "POST", headers });
      assert.equal(refused.status, 409);
      assert.match(await refused.text(), name === "pm-ado" ? /not published to npm yet/ : /native CLI, not an npm extension/);
    }
    assert.equal(await readFile(path.join(pmRoot, "settings.json"), "utf8"), before);
    const trackerItems = execFileSync(process.execPath, [cli, "list", "--all", "--json", "--output-budget", "unbounded", "--output-limit", "unbounded"], { cwd: project, env, encoding: "utf8" });
    assert.match(trackerItems, /Synthetic catalog item/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner, viewer]]);
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

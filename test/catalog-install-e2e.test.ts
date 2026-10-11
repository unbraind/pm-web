/** Built HTTP acceptance over a real project tracker, registry install and activated extension. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../dist/app.js";
import { createApp as createSourceApp } from "../src/app.ts";
import { signToken } from "../dist/auth.js";
import { pool } from "../dist/db.js";
import { pool as sourcePool } from "../src/db.ts";
import type { PackageCatalogRow } from "../dist/routes/extensions.js";
import type { ExtensionDescribeResult } from "@unbrained/pm-cli/sdk";

after(() => Promise.all([pool.end(), sourcePool.end()]));

/** All public fleet identities requested for the Packages view, including the native CLI. */
const FLEET_NAMES = "pm-ado pm-beads pm-brief pm-changelog pm-context pm-csv pm-gantt-chart pm-github pm-graph pm-jev pm-jira pm-linear pm-ops pm-presets pm-rl pm-rust pm-slack pm-slack-standup pm-starter pm-todos pm-ts-starter pm-vcs".split(" ");

/** Reject a missing deactivation event promptly so the acceptance reaches cleanup. */
async function waitForDeactivation(observed: Promise<void>, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Deactivation SSE event deadline exceeded")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("missing deactivation SSE rejects before the outer deadline and runs finally cleanup", async () => {
  let cleaned = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        try {
          await waitForDeactivation(new Promise<void>(() => {}), 10);
          return "resolved";
        } catch (error) {
          assert.match(String(error), /Deactivation SSE event deadline exceeded/);
          return "rejected";
        } finally {
          cleaned = true;
        }
      })(),
      new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("unbounded"), 1_000); }),
    ]);
    assert.equal(result, "rejected");
    assert.equal(cleaned, true);
    await waitForDeactivation(Promise.resolve());
  } finally {
    clearTimeout(watchdog);
  }
});

for (const [runtime, app] of [["built", createApp], ["source", createSourceApp]] as const) {
test(`${runtime} server executes npm Presets, refuses a later local command owner collision, and lists the full fleet`, { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-install-e2e-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  const owner = randomUUID();
  const projectId = randomUUID();
  const viewer = randomUUID();
  const slug = "synthetic-catalog";
  const project = path.join(root, owner, slug);
  const pmRoot = path.join(project, ".agents", "pm");
  const cli = path.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const server = http.createServer(app());
  const eventsAbort = new AbortController();
  let collectedEvents: Promise<void> | undefined;
  try {
    process.env.PROJECTS_ROOT = root;
    await mkdir(project, { recursive: true });
    const env = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "synthetic-catalog", HOME: root, PM_GRAPH_PROJECT_KEY: `${owner}:${slug}` };
    execFileSync(process.execPath, [cli, "workspace", "init", "--workspace", project, "--prefix", "scratch", "--defaults", "--agent-guidance", "skip"], { cwd: project, env, stdio: "pipe" });
    execFileSync(process.execPath, [cli, "create", "Synthetic catalog item", "--type", "Task"], { cwd: project, env, stdio: "pipe" });
    await pool.query("INSERT INTO pm_users (id, email, password_hash) VALUES ($1, $2, 'synthetic')", [owner, `${owner}@example.test`]);
    await pool.query("INSERT INTO pm_projects (id, user_id, name, slug, prefix) VALUES ($1, $2, 'Synthetic catalog', $3, 'scratch')", [projectId, owner, slug]);
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/projects/${projectId}/extensions`;
    const headers = { authorization: `Bearer ${signToken({ userId: owner, email: `${owner}@example.test` })}`, "content-type": "application/json" };
    const events = await fetch(`http://127.0.0.1:${address.port}/api/projects/${projectId}/pm/events?view=packages`, { headers, signal: eventsAbort.signal });
    assert.equal(events.status, 200);
    assert.ok(events.body);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let eventText = "";
    let observeDeactivation: (() => void) | undefined;
    const deactivationObserved = new Promise<void>((resolve) => { observeDeactivation = resolve; });
    /** Collect real package SSE events until the acceptance closes its connection. */
    collectedEvents = (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          eventText += decoder.decode(next.value, { stream: true });
          if (eventText.includes('"operation":"deactivate"')) observeDeactivation?.();
        }
      } catch (error) {
        if (!eventsAbort.signal.aborted) throw error;
      }
    })();
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
      { command: "pm presets list", args: ["--path", "other"] },
      { command: "pm presets list", args: ["--path=other"] },
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
    // A real local install competes for the identical path. Higher priority
    // activates it after Presets, independent of install or alphabetical order.
    const shadow = path.join(project, "shadow-package");
    await mkdir(shadow);
    await writeFile(path.join(shadow, "package.json"), JSON.stringify({ name: "scratch-shadow", version: "1.0.0", type: "module", pm: { extensions: ["."] } }));
    await writeFile(path.join(shadow, "manifest.json"), JSON.stringify({
      name: "scratch-shadow", version: "1.0.0", manifest_version: 1,
      entry: "./index.ts", priority: 1000, capabilities: ["commands"],
    }));
    await writeFile(path.join(shadow, "index.ts"), `import type { ExtensionApi } from "@unbrained/pm-cli/sdk";
import { writeFileSync } from "node:fs";
/** Register a conflicting handler whose execution leaves a detectable receipt. */
export function activate(api: ExtensionApi): void {
  if (!process.env.PM_GRAPH_PROJECT_KEY) return;
  api.registerCommand({ name: "presets list", description: "Synthetic collision", run() {
    writeFileSync("collision-executed.txt", "scratch-shadow ran");
    return { ok: true, owner: "scratch-shadow" };
  } });
}
`);
    execFileSync(process.execPath, [cli, "package", "install", "./shadow-package", "--project", "--json"], { cwd: project, env, stdio: "pipe" });
    execFileSync(process.execPath, [cli, "package", "activate", "scratch-shadow", "--project", "--json"], { cwd: project, env, stdio: "pipe" });
    const described = JSON.parse(execFileSync(process.execPath, [cli, "package", "describe", "--project", "--json"], { cwd: project, env, encoding: "utf8" })) as { details: ExtensionDescribeResult };
    const ownership = described.details.command_ownership.find((row) => row.command === "presets list" && row.surface === "handler");
    assert.equal(ownership?.policy, "last_activated_wins");
    assert.equal(ownership?.collision, true);
    assert.deepEqual(ownership?.claimants.map(({ name, winner }) => ({ name, winner })), [
      { name: "pm-presets", winner: false }, { name: "scratch-shadow", winner: true },
    ]);
    // Prove this is a dispatchable duplicate, then erase only its synthetic
    // execution receipt before asking the HTTP route to refuse it.
    execFileSync(process.execPath, [cli, "presets", "list", "--json"], { cwd: project, env, stdio: "pipe" });
    const marker = path.join(project, "collision-executed.txt");
    assert.equal(await readFile(marker, "utf8"), "scratch-shadow ran");
    await rm(marker);
    const trackerBeforeCollision = await readFile(path.join(pmRoot, "settings.json"), "utf8");
    const collision = await fetch(`${base}/pm-presets/run`, { method: "POST", headers, body: JSON.stringify({ command: "pm presets list", args: ["--json"] }) });
    const collisionBody = await collision.json() as { ok: boolean; output: string; error: string };
    assert.equal(collision.status, 409, JSON.stringify(collisionBody));
    assert.equal(collisionBody.ok, false);
    assert.equal(collisionBody.output, "");
    assert.match(collisionBody.error, /presets list is owned by scratch-shadow.*not pm-presets/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(await readFile(path.join(pmRoot, "settings.json"), "utf8"), trackerBeforeCollision);
    execFileSync(process.execPath, [cli, "package", "deactivate", "scratch-shadow", "--project", "--json"], { cwd: project, env, stdio: "pipe" });
    const restored = await fetch(`${base}/pm-presets/run`, { method: "POST", headers, body: JSON.stringify({ command: "pm presets list", args: ["--json"] }) });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.match(await restored.text(), /software-sprint/);
    const deactivate = await fetch(`${base}/pm-presets/deactivate`, { method: "POST", headers });
    assert.equal(deactivate.status, 200, await deactivate.text());
    await waitForDeactivation(deactivationObserved);
    assert.match(eventText, /"operation":"install"/);
    assert.match(eventText, /"operation":"activate"/);
    assert.doesNotMatch(eventText, /"operation":"run"/, "command output must survive package-state refreshes");
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
    eventsAbort.abort();
    await collectedEvents;
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [[owner, viewer]]);
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
}

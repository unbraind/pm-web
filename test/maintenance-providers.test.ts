/** Real HTTP/PostgreSQL acceptance for optional maintenance providers. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { findCatalogEntry } from "../src/services/package-catalog.ts";
import { pool } from "../src/db.ts";
import { renderPackagesView } from "../public/src/views/packages.ts";
import { requireMaintenanceCapability } from "../public/src/views/maintenance.ts";
import { state } from "../public/src/state.js";
import type { CreateAppDeps } from "../src/app.ts";
import type { MaintenanceCapabilitiesStatus } from "../src/routes/extensions.ts";
import { captureLogs, setLogLevel } from "./helpers/stdout-logs.ts";
import { readMaintenanceCapabilities } from "../src/services/maintenance-providers.ts";
import { authedFetch, authCookie, ensureSchema, seedProject, seedUser, seedUserShare, startApp, type SeedUser } from "./helpers/pg-harness.ts";

/** Seed a real isolated project and authenticated owner, editor, viewer and stranger. */
async function fixture(t: test.TestContext, deps?: CreateAppDeps) {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-maintenance-"));
  const previousRoot = process.env.PROJECTS_ROOT;
  process.env.PROJECTS_ROOT = root;
  const users = await Promise.all(Array.from({ length: 4 }, () => seedUser()));
  const [owner, editor, viewer, stranger] = users;
  const project = await seedProject(owner.id, undefined, { prefix: "mp" });
  await Promise.all([seedUserShare(project.id, editor.id, "edit"), seedUserShare(project.id, viewer.id, "view")]);
  const workspace = path.join(root, owner.id, project.slug);
  const pmRoot = path.join(workspace, ".agents", "pm");
  await mkdir(workspace, { recursive: true });
  const client = new PmClient({ cwd: workspace, pmRoot });
  await client.init("mp");
  await client.create({ title: "Maintenance fixture", type: "Task" });
  const server = await startApp(deps);
  t.after(async () => {
    await server.close();
    await pool.query("DELETE FROM pm_users WHERE id = ANY($1::uuid[])", [users.map((user) => user.id)]);
    if (previousRoot === undefined) delete process.env.PROJECTS_ROOT;
    else process.env.PROJECTS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });
  const base = `/api/projects/${project.id}`;
  /** Send a project request through real authentication and CSRF handling. */
  const request = (user: SeedUser, route: string, method = "GET", body?: object) => authedFetch(server, user, `${base}/${route}`, {
    method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { root, owner, editor, viewer, stranger, project, pmRoot, client, server, base, request };
}

/** Capabilities and package rows consumed by the UI. */
interface Capabilities {
  canManagePackages: boolean;
  capabilities: MaintenanceCapabilitiesStatus;
  stateError?: string;
  maintenance: Awaited<ReturnType<typeof readMaintenanceCapabilities>>;
  packages: Array<{ name: string; installed: boolean; enabled: boolean; runtimeActive: boolean; availability: string; npmSpec: string }>;
}

/** Read capabilities through the same endpoint as the browser. */
async function capabilities(f: Awaited<ReturnType<typeof fixture>>, user = f.owner): Promise<Capabilities> {
  const response = await f.request(user, "extensions");
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as Capabilities;
}

const actions = [
  ["comments-audit", "GET", undefined, "pm-governance-audit"],
  ["normalize", "POST", {}, "pm-governance-audit"],
  ["reindex", "POST", { mode: "keyword" }, "pm-search-advanced"],
] as const;

test("missing providers return typed dependency failures and role-aware capabilities without provisioning", async (t) => {
  const f = await fixture(t);
  const settings = await readFile(path.join(f.pmRoot, "settings.json"), "utf8");
  for (const user of [f.owner, f.editor, f.viewer]) {
    const data = await capabilities(f, user);
    assert.equal(data.canManagePackages, user !== f.viewer);
    assert.deepEqual(data.capabilities, { status: "available" });
    for (const [action, method, body, provider] of actions) {
      const capability = data.maintenance[action];
      assert.equal(capability.available, false);
      assert.equal(capability.provider, provider);
      assert.equal(Boolean(capability.installAction), user !== f.viewer);
      const row = data.packages.find((pkg) => pkg.name === provider);
      assert.equal(row?.availability, "bundled");
      assert.equal(row.npmSpec, provider);
      assert.equal(row.installed, false);
      const response = await f.request(user, `pm/${action}`, method, body);
      if (user === f.viewer && method === "POST") {
        assert.equal(response.status, 403);
        continue;
      }
      assert.equal(response.status, 424, await response.clone().text());
      const error = await response.json() as { code: string; provider: string; hint: string; installAction?: { method: string; url: string } };
      assert.equal(error.code, "provider_unavailable");
      assert.equal(error.provider, provider);
      assert.match(error.hint, /Packages/);
      assert.equal(Boolean(error.installAction), user !== f.viewer);
      if (error.installAction) assert.deepEqual(error.installAction, { method: "POST", url: `${f.base}/extensions/${provider}/install` });
    }
  }
  for (const route of ["extensions", "pm/comments-audit"]) assert.equal((await f.request(f.stranger, route)).status, 404);
  assert.equal((await f.request(f.viewer, "extensions/pm-governance-audit/install", "POST", {})).status, 403);
  const blocked = await fetch(f.server.url(`${f.base}/extensions/pm-governance-audit/install`), { method: "POST", headers: { cookie: authCookie(f.owner) } });
  assert.equal(blocked.status, 403);
  assert.equal(await readFile(path.join(f.pmRoot, "settings.json"), "utf8"), settings);
});

test("real bundled installs immediately enable actions and package lifecycle invalidates cached availability", async (t) => {
  const f = await fixture(t);
  await capabilities(f); // Cache the missing state before installation.
  for (const provider of ["pm-governance-audit", "pm-search-advanced"]) {
    const installed = await f.request(f.editor, `extensions/${provider}/install`, "POST", {});
    assert.equal(installed.status, 201, await installed.clone().text());
    const receipt = await installed.json() as { details: { command_paths: string[]; extension: { name: string; capabilities: string[] } } };
    const entry = findCatalogEntry(provider);
    assert.ok(entry);
    assert.deepEqual(entry.commands, receipt.details.command_paths.map((command) => `pm ${command}`));
    assert.equal(entry.extensionName, receipt.details.extension.name);
    assert.deepEqual([...entry.capabilities].sort(), [...receipt.details.extension.capabilities].sort());
    const data = await capabilities(f);
    const row = data.packages.find((pkg) => pkg.name === provider);
    assert.ok(row?.installed && row.enabled && row.runtimeActive);
    for (const [action, method, body, required] of actions) {
      assert.equal(data.maintenance[action].available, required === provider || provider === "pm-search-advanced");
      if (!data.maintenance[action].available) continue;
      const response = await f.request(f.owner, `pm/${action}`, method, body);
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json() as Record<string, unknown>;
      assert.ok(!("error" in payload));
      if (action === "comments-audit") assert.equal((payload.summary as { totals: { items_scanned: number } }).totals.items_scanned, 1);
      if (action === "normalize") assert.equal(payload.dry_run, true);
      if (action === "reindex") assert.deepEqual(payload, { ok: true, mode: "keyword" });
    }
  }
  const other = await seedProject(f.owner.id);
  const otherRoot = path.join(f.root, f.owner.id, other.slug, ".agents", "pm");
  await mkdir(path.dirname(path.dirname(otherRoot)), { recursive: true });
  await new PmClient({ cwd: path.dirname(path.dirname(otherRoot)), pmRoot: otherRoot }).init("other");
  const isolated = await authedFetch(f.server, f.owner, `/api/projects/${other.id}/extensions`);
  assert.equal((await isolated.json() as Capabilities).maintenance.normalize.available, false);
  for (const operation of ["deactivate", "activate"]) {
    assert.equal((await f.request(f.owner, `extensions/pm-governance-audit/${operation}`, "POST", {})).status, 200);
    assert.equal((await capabilities(f)).maintenance.normalize.available, operation === "activate");
    const report = await f.request(f.viewer, "pm/comments-audit");
    assert.equal(report.status, operation === "activate" ? 200 : 424);
  }
  assert.equal((await f.request(f.owner, "extensions/pm-governance-audit", "DELETE")).status, 200);
  assert.equal((await capabilities(f)).maintenance.normalize.available, false);
});

test("unreadable capabilities refuse execution, retry after recovery, and expire after external installs", async (t) => {
  const f = await fixture(t);
  const workspace = path.dirname(path.dirname(f.pmRoot));
  const held = path.join(f.root, "held-project");
  await rename(workspace, held);
  const failed = await f.request(f.owner, "pm/comments-audit");
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as { code: string }).code, "capabilities_unavailable");
  await rename(held, workspace);
  assert.equal((await f.request(f.owner, "pm/comments-audit")).status, 424);
  await f.client.packageInstall("pm-governance-audit", { project: true });
  await delay(5_050);
  assert.equal((await f.request(f.viewer, "pm/comments-audit")).status, 200);
});

test("global-only bundled providers cannot advertise project maintenance availability", async (t) => {
  const f = await fixture(t);
  const isolatedHome = path.join(f.root, "isolated-home");
  await mkdir(isolatedHome);
  const script = `
    import { PmClient } from '@unbrained/pm-cli/sdk';
    import { readProjectCommandOwners } from './src/services/pm-runner.ts';
    const projectDir = process.env.SYNTHETIC_PROJECT_DIR;
    const client = new PmClient({ cwd: projectDir, pmRoot: process.env.SYNTHETIC_PM_ROOT });
    await client.packageInstall('pm-governance-audit', { global: true });
    const described = await client.packageDescribe(undefined, { project: true });
    const all = described.details.command_ownership;
    const projected = await readProjectCommandOwners(projectDir);
    console.log(JSON.stringify({
      globalProviderVisible: all.some(row => row.command === 'normalize'),
      projectProviderVisible: projected.some(row => row.command === 'normalize'),
    }));
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: isolatedHome, SYNTHETIC_PROJECT_DIR: path.dirname(path.dirname(f.pmRoot)), SYNTHETIC_PM_ROOT: f.pmRoot },
  });
  assert.deepEqual(JSON.parse(result.stdout), { globalProviderVisible: true, projectProviderVisible: false });
  assert.equal((await capabilities(f)).maintenance.normalize.available, false);
});


test("capability-read failures preserve real package inventory, owner controls and disabled maintenance", async (t) => {
  setLogLevel(t, "info");
  const logs = captureLogs(t);
  let reads = 0;
  const f = await fixture(t, {
    /** Inject a failed capability reader without replacing the SDK or inventory runner. */
    readMaintenanceCapabilities: async () => {
      reads++;
      throw new Error("SYNTHETIC_PRIVATE_CAPABILITY_FAILURE");
    },
  });
  // Retain a real installed provider to prove the inventory is still read successfully.
  await f.client.packageInstall("pm-governance-audit", { project: true });
  for (const user of [f.owner, f.viewer]) {
    const data = await capabilities(f, user);
    assert.equal(data.stateError, undefined);
    assert.equal(data.canManagePackages, user === f.owner);
    assert.equal(data.maintenance, undefined, "no maintenance availability may be advertised after a failed read");
    assert.equal(data.capabilities.status, "unavailable");
    assert.ok(data.capabilities.status === "unavailable");
    assert.equal(data.capabilities.error.code, "capabilities_unavailable");
    assert.match(data.capabilities.error.message, /Cannot check maintenance provider availability/);
    assert.ok(data.packages.find((row) => row.name === "pm-governance-audit")?.installed);
    assert.equal(data.packages.find((row) => row.name === "pm-search-advanced")?.installed, false);
  }
  assert.equal(reads, 2);

  const globals = globalThis as unknown as Record<string, unknown>;
  const browserSnapshot = { document: globals.document, project: state.currentProject };
  const nativeFetch = globalThis.fetch;
  t.after(() => {
    globals.document = browserSnapshot.document;
    state.currentProject = browserSnapshot.project;
  });
  const content = { innerHTML: "", addEventListener: () => {} };
  const packages = { innerHTML: "", querySelectorAll: () => [] };
  const maintenance = { id: "maintenance-test", innerHTML: "" };
  const elements = new Map<string, unknown>([["content-packages", content], ["packages-content", packages], [maintenance.id, maintenance]]);
  globals.document = { cookie: "", getElementById: (id: string) => elements.get(id) ?? null };
  state.currentProject = { id: f.project.id, name: "Maintenance fixture" } as NonNullable<typeof state.currentProject>;
  for (const user of [f.owner, f.viewer]) {
    // The browser API client still crosses the real HTTP/auth/PostgreSQL stack.
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", authCookie(user));
      return nativeFetch(f.server.url(String(input)), { ...init, headers });
    });
    await renderPackagesView();
    assert.match(packages.innerHTML, /pm-search-advanced/);
    assert.match(packages.innerHTML, /role="status">Maintenance actions are temporarily unavailable/);
    if (user === f.owner) {
      assert.match(packages.innerHTML, /data-pkg-action="install"/);
      assert.match(packages.innerHTML, /data-pkg-action="deactivate"/);
    } else assert.doesNotMatch(packages.innerHTML, /data-pkg-action/);
    for (const [action] of actions) {
      assert.equal(await requireMaintenanceCapability(maintenance as HTMLElement, action), false);
      assert.match(maintenance.innerHTML, /Maintenance actions are temporarily unavailable/);
      assert.doesNotMatch(maintenance.innerHTML, /onclick|data-pkg-action/);
    }
  }
  assert.ok(logs.some((line) => JSON.parse(line).event === "maintenance_capabilities_unavailable"));
  assert.ok(logs.every((line) => !line.includes("SYNTHETIC_PRIVATE_CAPABILITY_FAILURE")));
});

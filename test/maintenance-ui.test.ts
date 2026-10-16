import assert from "node:assert/strict";
import test from "node:test";
import { renderMaintenanceRequirement, requireMaintenanceCapability } from "../public/src/views/maintenance.ts";
import { renderNormalizeView } from "../public/src/views/normalize.ts";
import { renderCommentsAuditView } from "../public/src/views/comments-audit.ts";
import { renderSearchView } from "../public/src/views/search.ts";
import { renderPackageCard } from "../public/src/views/packages.ts";
import { state } from "../public/src/state.js";
import { findCatalogEntry } from "../src/services/package-catalog.ts";

test("disabled maintenance requirements escape text and expose package navigation only to editors", () => {
  const capability = { available: false, provider: "pm-governance-audit", hint: "Ask an editor <safely>" };
  const viewer = renderMaintenanceRequirement(capability);
  assert.match(viewer, /disabled>Requires pm-governance-audit/);
  assert.match(viewer, /&lt;safely&gt;/);
  assert.doesNotMatch(viewer, /showView|Install \/ enable/);
  const editor = renderMaintenanceRequirement({ ...capability, installAction: { method: "POST", url: "/api/projects/fixture/extensions/pm-governance-audit/install" } });
  assert.match(editor, /Install \/ enable in Packages/);
  assert.match(editor, /showView\('packages'\)/);
});

test("maintenance views check capabilities before running and suppress unavailable actions", async (t) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousDocument = globals.document;
  const previousFetch = globalThis.fetch;
  const previousProject = state.currentProject;
  t.after(() => {
    globals.document = previousDocument;
    globalThis.fetch = previousFetch;
    state.currentProject = previousProject;
  });
  const ids = ["content-normalize", "normalize-content", "content-comments-audit", "comments-audit-content", "content-search", "reindex-capability"];
  const elements = new Map(ids.map((id) => [id, { id, innerHTML: "" }]));
  globals.document = { cookie: "", getElementById: (id: string) => elements.get(id) ?? null };
  state.currentProject = { id: "fixture", name: "Fixture" } as NonNullable<typeof state.currentProject>;
  const requests: string[] = [];
  let available = false;
  let editable = false;
  let fail = false;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    assert.ok(String(input).endsWith("/extensions"), "no unavailable maintenance command may run");
    if (fail) return new Response(JSON.stringify({ error: "Temporary read failure" }), { status: 503 });
    const capability = { available, provider: "pm-governance-audit", hint: "Ask an editor" };
    return new Response(JSON.stringify({ canManagePackages: editable, maintenance: {
      normalize: capability, "comments-audit": capability, reindex: { ...capability, provider: "pm-search-advanced" },
    } }));
  };
  await renderNormalizeView();
  await renderCommentsAuditView();
  renderSearchView();
  await new Promise<void>((resolve) => { setTimeout(resolve, 65); });
  assert.equal(requests.length, 3);
  for (const id of ["normalize-content", "comments-audit-content", "reindex-capability"]) {
    assert.match(elements.get(id)!.innerHTML, /disabled>Requires pm-/);
    assert.doesNotMatch(elements.get(id)!.innerHTML, /Install \/ enable|reindexProject|All items are normalized/);
  }
  const target = elements.get("normalize-content")! as HTMLElement;
  available = true;
  assert.equal(await requireMaintenanceCapability(target, "normalize"), false);
  assert.match(target.innerHTML, /edit permission/);
  assert.equal(await requireMaintenanceCapability(target, "comments-audit"), true);
  editable = true;
  assert.equal(await requireMaintenanceCapability(target, "normalize"), true);
  fail = true;
  assert.equal(await requireMaintenanceCapability(target, "normalize"), false);
  assert.match(target.innerHTML, /Cannot check provider availability/);
});

test("bundled catalog cards offer install to managers and omit all package actions for viewers", () => {
  const entry = findCatalogEntry("pm-search-advanced");
  assert.ok(entry);
  const row = { ...entry, installed: false, active: false, enabled: false, runtimeActive: false,
    version: null, activationStatus: null, managed: false, sourceKind: null };
  assert.match(renderPackageCard(row), /data-pkg-action="install"/);
  assert.doesNotMatch(renderPackageCard(row), /npmjs.com|unreleasedBadge/);
  assert.doesNotMatch(renderPackageCard({ ...row, installed: true, active: true, enabled: true }, false), /data-pkg-action/);
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PACKAGE_CATALOG,
  catalogNames,
  findCatalogEntry,
  resolveNpmSpec,
} from "../dist/services/package-catalog.js";

// Package root: test/ compiles to dist-test/, so go up one level from there.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// The fleet sibling packages live alongside pm-web under the same fleet root.
// In the monorepo dev environment this is ../<pkg>/manifest.json; in a
// standalone CI checkout of pm-web the siblings are absent and the manifest
// comparison is skipped (the structural invariants still run). PM_FLEET_ROOT
// lets an operator point at a fleet root explicitly.
const FLEET_ROOT = process.env.PM_FLEET_ROOT
  ? path.resolve(process.env.PM_FLEET_ROOT)
  : path.resolve(packageRoot, "..");

interface Manifest {
  name?: string;
  description?: string;
  capabilities?: string[];
}

interface PackageJson {
  name?: string;
  description?: string;
}

function readManifest(pkg: string): Manifest | null {
  const manifestPath = path.join(FLEET_ROOT, pkg, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function readPackageJson(pkg: string): PackageJson | null {
  const pkgPath = path.join(FLEET_ROOT, pkg, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

// The exhaustive set of every published pm package the catalog must expose,
// per the product requirement that pm-web offers ALL available pm packages.
// `pm-web` itself is the host and is deliberately absent. The two starter
// packages are authoring reference templates (category "template") that sort
// last; the rest are user-facing product extensions (category "extension").
const EXPECTED_NAMES = [
  "pm-beads",
  "pm-brief",
  "pm-changelog",
  "pm-context",
  "pm-csv",
  "pm-gantt-chart",
  "pm-github",
  "pm-graph",
  "pm-jira",
  "pm-linear",
  "pm-ops",
  "pm-presets",
  "pm-slack",
  "pm-slack-standup",
  "pm-starter",
  "pm-todos",
  "pm-ts-starter",
] as const;

// The two authoring reference templates that must be in the catalog.
const TEMPLATE_NAMES = ["pm-starter", "pm-ts-starter"] as const;

test("catalog exposes exactly every published pm package, no duplicates, pm-web absent", () => {
  const names = catalogNames();
  assert.deepEqual([...names].sort(), [...EXPECTED_NAMES].sort());
  // No duplicate names.
  assert.equal(new Set(names).size, names.length);
  // pm-web is the host and must never appear in its own catalog.
  assert.ok(!names.includes("pm-web" as const),
    "pm-web (the host) must not be in the catalog");
});

test("every catalog entry has non-empty name/npmSpec/title/description/capabilities/category", () => {
  for (const entry of PACKAGE_CATALOG) {
    assert.ok(entry.name, `${entry.name}: name is required`);
    assert.equal(entry.npmSpec, `npm:${entry.name}`,
      `${entry.name}: npmSpec must be npm:<name>, never a raw user string`);
    assert.ok(entry.title, `${entry.name}: title is required`);
    assert.ok(entry.description, `${entry.name}: description is required`);
    assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length > 0,
      `${entry.name}: capabilities must be a non-empty array`);
    assert.ok(
      entry.category === "extension" || entry.category === "template",
      `${entry.name}: category must be "extension" or "template", got ${entry.category}`,
    );
    // resolveNpmSpec must round-trip the catalog name and reject others.
    assert.equal(resolveNpmSpec(entry.name), `npm:${entry.name}`);
  }
});

test("category partition: exactly 2 templates (pm-starter, pm-ts-starter), 15 extensions", () => {
  const templates = PACKAGE_CATALOG.filter((e) => e.category === "template");
  const extensions = PACKAGE_CATALOG.filter((e) => e.category === "extension");
  assert.equal(templates.length, 2, "exactly two template entries");
  assert.deepEqual(
    templates.map((e) => e.name),
    [...TEMPLATE_NAMES],
    "templates must be pm-starter and pm-ts-starter",
  );
  assert.equal(extensions.length, 15, "exactly 15 extension entries");
  // Templates sort last (display order = catalog order).
  const lastIndex = PACKAGE_CATALOG.length - 1;
  assert.equal(PACKAGE_CATALOG[lastIndex]!.name, "pm-ts-starter",
    "pm-ts-starter must be the last catalog entry");
  assert.equal(PACKAGE_CATALOG[lastIndex - 1]!.name, "pm-starter",
    "pm-starter must be the second-to-last catalog entry");
});

test("catalog validation rejects unknown and injected names before any spawn", () => {
  // A user-supplied :name must never reach an install target. The catalog
  // lookup is the security gate: every one of these must miss.
  const injected = [
    "pm-cli",
    "pm-web",
    "npm:pm-graph",
    "pm-graph --project",
    "pm-graph;rm -rf /",
    "../pm-graph",
    "..%2F..%2Fpm-graph",
    "pm_graph",
    "PM-GRAPH",
    "",
    "pm-graph ",
    "../../evil",
    "lodash",
  ];
  for (const name of injected) {
    assert.equal(findCatalogEntry(name), undefined, `unknown name must miss catalog: ${name}`);
    assert.equal(resolveNpmSpec(name), null, `unknown name must not resolve to a spec: ${name}`);
  }
});

test("catalog entries mirror each package's real manifest.json claims", () => {
  let checked = 0;
  let skipped = 0;
  for (const entry of PACKAGE_CATALOG) {
    const manifest = readManifest(entry.name);
    if (!manifest) {
      skipped++;
      continue;
    }
    checked++;
    assert.equal(manifest.name, entry.name,
      `${entry.name}: catalog name must match manifest name`);
    assert.deepEqual(
      [...(manifest.capabilities ?? [])].sort(),
      [...entry.capabilities].sort(),
      `${entry.name}: catalog capabilities must match manifest capabilities`,
    );
    // The catalog description mirrors the package's own description. For
    // product extensions the source of truth is the manifest description; for
    // authoring templates the source of truth is the package.json description
    // (the manifest carries a longer, capability-enumerating blurb that is
    // too verbose for a one-line catalog card, while package.json holds the
    // concise summary the task requires verbatim).
    const pkgJson = readPackageJson(entry.name);
    if (entry.category === "template" && pkgJson?.description) {
      assert.equal(
        pkgJson.description,
        entry.description,
        `${entry.name}: template description must match package.json description verbatim`,
      );
    } else {
      assert.equal(
        manifest.description,
        entry.description,
        `${entry.name}: catalog description must match manifest description`,
      );
    }
  }
  // When the fleet siblings are present (monorepo dev / hosted build), every
  // entry is checked. Standalone CI skips the manifest comparison but keeps
  // the structural invariants above.
  if (skipped === 0) {
    assert.equal(checked, EXPECTED_NAMES.length,
      "every catalog entry should have a resolvable fleet manifest in this environment");
  }
});

test("template entries carry all nine capability types from their manifests", () => {
  // The starters are the reference implementations covering every capability
  // kind. Verify their catalog entries match the manifests exactly.
  for (const name of TEMPLATE_NAMES) {
    const entry = findCatalogEntry(name);
    assert.ok(entry, `${name} must be in the catalog`);
    assert.equal(entry!.category, "template", `${name} must be category "template"`);
    const manifest = readManifest(name);
    if (manifest) {
      assert.deepEqual(
        [...(manifest.capabilities ?? [])].sort(),
        [...entry!.capabilities].sort(),
        `${name}: catalog capabilities must match manifest capabilities`,
      );
    }
  }
});

test("gating metadata is declared for packages that need a service or credentials", () => {
  const byName = new Map(PACKAGE_CATALOG.map((e) => [e.name, e]));
  // pm-graph's Neo4j sync is the canonical requiresService case.
  const graph = byName.get("pm-graph")!;
  assert.ok(graph.requiresService, "pm-graph must declare its Neo4j service requirement");
  assert.equal(graph.requiresService.name, "Neo4j");
  assert.equal(graph.requiresService.optional, true,
    "pm-graph's Neo4j is optional (offline export/analyze work without it)");
  // The integrations that talk to an external API must surface credentials.
  for (const name of ["pm-jira", "pm-linear", "pm-slack", "pm-slack-standup"]) {
    const entry = byName.get(name)!;
    assert.ok(entry.requiresCredentials && entry.requiresCredentials.length > 0,
      `${name} must declare required credentials so the UI does not promise a one-click install`);
  }
  // pm-github's token is optional (unauthenticated reads work).
  const gh = byName.get("pm-github")!;
  assert.ok(gh.requiresCredentials && gh.requiresCredentials![0]!.optional,
    "pm-github must mark its token optional");
  // Templates have no service or credential requirements.
  for (const name of TEMPLATE_NAMES) {
    const entry = byName.get(name)!;
    assert.equal(entry.requiresService, undefined,
      `${name} (template) must not declare a service requirement`);
    assert.equal(entry.requiresCredentials, undefined,
      `${name} (template) must not declare credential requirements`);
  }
});
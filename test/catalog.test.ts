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

function readManifest(pkg: string): Manifest | null {
  const manifestPath = path.join(FLEET_ROOT, pkg, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

// The exhaustive set of user-facing pm packages the catalog must expose, per
// the task. Authoring templates (pm-starter / pm-ts-starter) and pm-web itself
// are intentionally excluded.
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
  "pm-todos",
] as const;

test("catalog exposes exactly the user-facing pm packages, no duplicates", () => {
  const names = catalogNames();
  assert.deepEqual([...names].sort(), [...EXPECTED_NAMES].sort());
  // No duplicate names.
  assert.equal(new Set(names).size, names.length);
});

test("every catalog entry has a verified npm: spec derived from its name", () => {
  for (const entry of PACKAGE_CATALOG) {
    assert.equal(entry.npmSpec, `npm:${entry.name}`,
      `${entry.name}: npmSpec must be npm:<name>, never a raw user string`);
    assert.ok(entry.title, `${entry.name}: title is required`);
    assert.ok(entry.description, `${entry.name}: description is required`);
    assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length > 0,
      `${entry.name}: capabilities must be a non-empty array`);
    // resolveNpmSpec must round-trip the catalog name and reject others.
    assert.equal(resolveNpmSpec(entry.name), `npm:${entry.name}`);
  }
});

test("catalog validation rejects unknown and injected names before any spawn", () => {
  // A user-supplied :name must never reach an install target. The catalog
  // lookup is the security gate: every one of these must miss.
  const injected = [
    "pm-cli",
    "pm-web",
    "pm-starter",
    "pm-ts-starter",
    "npm:pm-graph",
    "pm-graph --project",
    "pm-graph;rm -rf /",
    "../pm-graph",
    "..%2F..%2Fpm-graph",
    "pm_graph",
    "PM-GRAPH",
    "",
    "pm-graph ",
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
    // The catalog description mirrors the manifest description (the manifest
    // is the source of truth). A drift here means the UI is showing a lie.
    assert.equal(
      manifest.description,
      entry.description,
      `${entry.name}: catalog description must match manifest description`,
    );
  }
  // When the fleet siblings are present (monorepo dev / hosted build), every
  // entry is checked. Standalone CI skips the manifest comparison but keeps
  // the structural invariants above.
  if (skipped === 0) {
    assert.equal(checked, EXPECTED_NAMES.length,
      "every catalog entry should have a resolvable fleet manifest in this environment");
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
});
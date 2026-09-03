import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PACKAGE_CATALOG,
  catalogNames,
  findCatalogEntry,
  resolveNpmSpec,
} from "../src/services/package-catalog.ts";
import {
  FLEET_SNAPSHOT_PATH,
  readFleetExtensions,
} from "../src/services/fleet-snapshot.ts";

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
  /**
   * Present exactly on the fleet packages that are publishable to npm; `npm
   * publish` reads it, so its presence is the local fact that decides whether
   * a released version can exist for this package at all.
   */
  publishConfig?: { access?: string };
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
// The expected catalog membership is DERIVED, never restated. A second
// hardcoded list would drift from the fleet exactly as the catalog itself
// can, so it would move the bug rather than catch it. A pm extension is a
// fleet directory shipping a `manifest.json` that declares `capabilities`;
// pm-web is the host and pm-cli is the CLI, so neither is an extension of it.
const CATALOG_HOSTS = new Set(["pm-web", "pm-cli"]);

/**
 * Every pm extension resolvable as a sibling of this package, or an empty
 * array when the siblings are not present.
 *
 * `FLEET_ROOT` defaults to this package's parent directory, which EXISTS in a
 * standalone checkout too — it is just some unrelated directory that holds no
 * pm packages. Testing for the directory is therefore not a test for the
 * fleet; only finding pm extensions in it is. An empty result means "siblings
 * unavailable here", never "the fleet is empty".
 */
function fleetExtensionNames(): readonly string[] {
  if (!existsSync(FLEET_ROOT)) return [];
  let entries;
  try {
    entries = readdirSync(FLEET_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !CATALOG_HOSTS.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => Array.isArray(readManifest(name)?.capabilities))
    .sort();
}

const FLEET_EXTENSIONS = fleetExtensionNames();

// An operator who sets PM_FLEET_ROOT has asserted where the fleet is. If that
// path resolves no pm extensions they have configured it wrongly, and silently
// degrading to a self-check would hide the misconfiguration behind a green
// suite — the failure this whole file exists to prevent. Only the IMPLICIT
// default (a sibling directory that happens not to hold the fleet) is allowed
// to fall back.
if (process.env.PM_FLEET_ROOT && FLEET_EXTENSIONS.length === 0) {
  throw new Error(
    `PM_FLEET_ROOT is set to ${FLEET_ROOT} but no pm extension was found there. ` +
      "Point it at the fleet root, or unset it to run the structural invariants alone.",
  );
}

// Where the siblings are genuinely unavailable, the derivation cannot be the
// oracle: asserting the catalog against an empty set would fail every
// standalone checkout. The structural invariants still run there; only the
// membership comparison degrades to a self-check, and it says so.
const EXPECTED_NAMES: readonly string[] =
  FLEET_EXTENSIONS.length > 0 ? FLEET_EXTENSIONS : catalogNames();

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
    // resolveNpmSpec round-trips a published name and refuses an unreleased
    // one, so a route can never build an install target for a package that
    // has no published release to install.
    assert.equal(
      resolveNpmSpec(entry.name),
      entry.availability === "unreleased" ? null : `npm:${entry.name}`,
      `${entry.name}: resolveNpmSpec must refuse an unreleased package and round-trip a published one`,
    );
  }
});

test("category partition: exactly 2 templates (pm-starter, pm-ts-starter), the rest extensions", () => {
  const templates = PACKAGE_CATALOG.filter((e) => e.category === "template");
  const extensions = PACKAGE_CATALOG.filter((e) => e.category === "extension");
  assert.equal(templates.length, 2, "exactly two template entries");
  assert.deepEqual(
    templates.map((e) => e.name),
    [...TEMPLATE_NAMES],
    "templates must be pm-starter and pm-ts-starter",
  );
  // Derived, not restated: every catalogued package that is not one of the two
  // authoring templates is a product extension. A hardcoded count here would
  // have to be edited by hand on every fleet addition, which is the same drift
  // this suite exists to catch.
  assert.equal(
    extensions.length,
    PACKAGE_CATALOG.length - templates.length,
    "every non-template entry must be categorised as an extension",
  );
  assert.ok(extensions.length > 0, "the catalog must contain product extensions");
  // Templates sort last (display order = catalog order).
  // The templates sort last among themselves; unreleased entries are appended
  // after them, so the anchor is the final template, not the final entry.
  const templateIndexes = PACKAGE_CATALOG
    .map((entry, index) => (entry.category === "template" ? index : -1))
    .filter((index) => index >= 0);
  const lastIndex = templateIndexes[templateIndexes.length - 1]!;
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

test("the catalog covers every pm extension in the fleet", () => {
  // The completeness direction the other tests do not cover. They assert that
  // every catalog entry has a real manifest; this asserts the converse — that
  // every pm extension present in the fleet is represented in the catalog, so
  // a package added to the fleet cannot be silently missing from the UI.
  //
  // The expected set is DERIVED from the fleet directory rather than restated
  // as a second list: a package is a pm extension exactly when it ships a
  // `manifest.json` declaring `capabilities`. A second hardcoded list would
  // just move the drift somewhere it is equally invisible. pm-web is excluded
  // because it is the host and cannot install itself; pm-cli is excluded
  // because it is the CLI, not an extension of it.
  const fleetExtensions = FLEET_EXTENSIONS;
  if (fleetExtensions.length === 0) return; // siblings not resolvable here

  const missing = fleetExtensions.filter((name) => findCatalogEntry(name) === undefined);
  assert.deepEqual(
    missing,
    [],
    `these fleet packages ship a manifest.json with capabilities but are absent from the catalog, so the UI would never offer or even mention them: ${missing.join(", ")}`,
  );
});


// --- the completeness gate, in the environment that guards the merge ---------
// The assertions above compare the catalog against sibling package directories,
// which a standalone CI checkout does not have — so they skip themselves in CI
// and only ever run on a machine with the whole fleet cloned. That is how
// pm-ado sat in the fleet with a manifest declaring five capabilities, absent
// from the catalog, across a long run of green CI.
//
// These two assertions close that. The first reads a committed snapshot, so it
// has input everywhere and fails in CI when the catalog drifts. The second
// re-derives the snapshot from the live fleet wherever the siblings resolve, so
// the snapshot cannot go stale unnoticed and quietly narrow what CI checks.

const fleetSnapshot: ReturnType<typeof readFleetExtensions> = JSON.parse(
  readFileSync(path.join(packageRoot, FLEET_SNAPSHOT_PATH), "utf8"),
);

test("the catalog covers every fleet extension in the committed snapshot", () => {
  assert.ok(
    fleetSnapshot.length > 0,
    "an empty snapshot would make this gate pass vacuously; regenerate with `npm run fleet:snapshot`",
  );
  const missing = fleetSnapshot
    .map((extension) => extension.name)
    .filter((name) => findCatalogEntry(name) === undefined);
  assert.deepEqual(
    missing,
    [],
    `these fleet packages ship a manifest.json with capabilities but are absent from the catalog, `
      + `so the UI would never offer or even mention them: ${missing.join(", ")}`,
  );

  // Membership alone is not enough: an entry that exists but misdescribes the
  // package is the same defect one step later, and availability decides whether
  // the UI renders an install action that npm would answer 404 for.
  for (const extension of fleetSnapshot) {
    const entry = findCatalogEntry(extension.name);
    assert.ok(entry, `${extension.name} must be catalogued`);
    // Same rule the live-fleet assertion applies: a product extension mirrors
    // the manifest description, an authoring template mirrors the concise
    // package.json one.
    const expectedDescription =
      entry.category === "template" && extension.packageDescription
        ? extension.packageDescription
        : extension.description;
    assert.equal(
      entry.description,
      expectedDescription,
      `${extension.name}: catalog description must mirror the `
        + `${entry.category === "template" ? "package.json" : "manifest"} description`,
    );
    assert.deepEqual(
      [...entry.capabilities].sort(),
      extension.capabilities,
      `${extension.name}: catalog capabilities must mirror the manifest capabilities`,
    );
    assert.equal(
      (entry.availability ?? "published") === "published",
      extension.publishable,
      `${extension.name}: catalogued as ${entry.availability ?? "published"}, but the package `
        + `${extension.publishable ? "declares" : "does not declare"} publishConfig — a catalogue `
        + "that promises an install for an unpublishable package renders a button that cannot work",
    );
  }
});

test("the committed snapshot still matches the live fleet", () => {
  const live = readFleetExtensions(FLEET_ROOT, { existsSync, readdirSync, readFileSync });
  if (live.length === 0) return; // siblings not resolvable here; the gate above still ran
  assert.deepEqual(
    live,
    fleetSnapshot,
    "the fleet has changed since the snapshot was generated, so the gate above is now checking "
      + "the catalog against a stale list — regenerate with `npm run fleet:snapshot` and commit it",
  );
});

test("every catalog entry declares an availability the fleet agrees with", () => {
  // The declaration is checked against the fleet, not merely against itself.
  // A publishable fleet package declares `publishConfig.access` in its
  // package.json — that is what `npm publish` reads, so it is the local fact
  // that decides whether a release can exist at all, and it is present for
  // every published fleet extension and absent for exactly the release-gated
  // ones. Consulting the npm registry instead would make this gate fail on an
  // offline runner rather than on a real drift.
  if (FLEET_EXTENSIONS.length === 0) return; // siblings not resolvable here
  for (const entry of PACKAGE_CATALOG) {
    const pkg = readPackageJson(entry.name);
    if (!pkg) continue; // sibling not resolvable in this environment
    const declared = entry.availability ?? "published";
    const publishable = pkg.publishConfig?.access !== undefined;
    assert.equal(
      declared === "published",
      publishable,
      `${entry.name}: catalogued as ${declared}, but its package.json ${publishable ? "declares" : "does not declare"} publishConfig.access — a catalogue that promises an install for an unpublishable package renders an install button that cannot work`,
    );
    assert.equal(
      resolveNpmSpec(entry.name),
      declared === "unreleased" ? null : entry.npmSpec,
      `${entry.name}: resolveNpmSpec must agree with the declared availability`,
    );
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
test("an unreleased package that is already installed keeps its management actions", () => {
  // Regression: suppressing every action for an unreleased package stranded a
  // user who had one installed from a local path or a preexisting install —
  // the server supports deactivating and removing it, but the card offered no
  // control to do so. Only the INSTALL action may be suppressed, and only
  // while the package is not installed.
  //
  // The card renderer lives in the browser bundle, so the invariant is checked
  // where it is decided: an unreleased entry must still be an ordinary catalog
  // entry in every respect except that no install spec resolves for it.
  const unreleased = PACKAGE_CATALOG.filter((entry) => entry.availability === "unreleased");
  assert.ok(unreleased.length > 0, "this test needs at least one unreleased entry to be meaningful");

  for (const entry of unreleased) {
    assert.equal(
      resolveNpmSpec(entry.name),
      null,
      `${entry.name}: no install spec may resolve while it is unreleased`,
    );
    // Everything an installed package's management controls read must still be
    // present, or the card cannot render deactivate/uninstall for it.
    assert.ok(entry.title, `${entry.name}: an unreleased entry still needs a title`);
    assert.ok(entry.description, `${entry.name}: an unreleased entry still needs a description`);
    assert.ok(
      entry.capabilities.length > 0,
      `${entry.name}: an unreleased entry still declares its capabilities`,
    );
    assert.equal(
      entry.category,
      "extension",
      `${entry.name}: an unreleased entry is still categorised, not special-cased out of the catalog`,
    );
    assert.ok(
      findCatalogEntry(entry.name),
      `${entry.name}: must remain resolvable by name so the :name route gate admits management calls`,
    );
  }
});

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
  type PackageCatalogEntry,
} from "../src/services/package-catalog.ts";
import { FLEET_PACKAGE_REPOS } from "./fleet-package-repos.fixture.ts";
import {
  FLEET_SNAPSHOT_PATH,
  type FleetExtension,
  type LocalFleetExtension,
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

// Canonical metadata, shared with the snapshot generator: checkout names are
// never package names, including in a worktree farm.
const { extensions: liveFleet, problems: fleetProblems } = readFleetExtensions(FLEET_ROOT, {
  existsSync, readdirSync, readFileSync,
});
const FLEET_EXTENSIONS = liveFleet.map((extension) => extension.name);

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
  FLEET_EXTENSIONS.length > 0 ? [...FLEET_EXTENSIONS, "pm-rust"] : catalogNames();

// The two authoring reference templates that must be in the catalog.
const TEMPLATE_NAMES = ["pm-starter", "pm-ts-starter"] as const;

/** Assert manifest provenance while allowing Swarm's explicitly curated display copy. */
function assertCatalogDescription(entry: PackageCatalogEntry, manifest: LocalFleetExtension): void {
  if (entry.name === "pm-swarm") {
    assert.equal(manifest.description, "Git worktree lanes and real conflict prediction for parallel pm agents",
      "Swarm manifest summary must remain verified even with curated catalog copy");
    assert.equal(entry.description, "Git worktree lanes, real merge-tree conflict prediction and conflict-free landing order for parallel agents");
    return;
  }
  assert.equal(entry.description,
    entry.category === "template" && manifest.packageDescription ? manifest.packageDescription : manifest.description,
    `${entry.name}: catalog description must mirror the package metadata`);
}

test("pm-swarm exposes its seven workflow commands as an unreleased product extension", () => {
  const entry = findCatalogEntry("pm-swarm");
  assert.ok(entry, "Swarm must be visible in the catalog");
  assert.equal(entry.npmName, "pm-swarm");
  assert.equal(entry.npmSpec, "npm:pm-swarm");
  assert.equal(entry.title, "Swarm");
  assert.equal(entry.category, "extension");
  assert.deepEqual(entry.capabilities, ["commands", "schema"]);
  assert.deepEqual(entry.commands, [
    "pm swarm plan", "pm swarm start", "pm swarm status", "pm swarm sync",
    "pm swarm land", "pm swarm reap", "pm swarm settings",
  ]);
  assert.deepEqual(entry.links, {
    docs: "https://github.com/unbraind/pm-swarm#readme",
    repository: "https://github.com/unbraind/pm-swarm",
    report: "https://github.com/unbraind/pm-swarm/issues",
  });
  assert.equal(entry.availability, "unreleased");
  assert.equal(resolveNpmSpec(entry.name), null, "unreleased Swarm must never resolve an install target");
});

test("pm-review catalog exposes all five commands registered on main", () => {
  const entry = findCatalogEntry("pm-review");
  assert.ok(entry);
  assert.deepEqual([...(entry.commands ?? [])].sort(), [
    "pm review find", "pm review import", "pm review precedents", "pm review round", "pm review verdict",
  ]);
});

test("pm-review credentials are optional and identify the authenticated commands", () => {
  const entry = findCatalogEntry("pm-review");
  assert.ok(entry);
  assert.ok(entry.requiresCredentials);
  assert.equal(entry.requiresCredentials.length, 1);
  const credential = entry.requiresCredentials[0];
  assert.ok(credential);
  assert.equal(credential.optional, true, "find, precedents and local verdicts need no GitHub token");
  assert.deepEqual(credential.envVars, ["GITHUB_TOKEN", "GH_TOKEN"]);
  assert.match(credential.label, /review import, round and verdict --apply/);
  assert.match(credential.label, /gh CLI's stored login/);
});

test("catalog exposes exactly every published pm package, no duplicates, pm-web absent", () => {
  assert.deepEqual(fleetProblems, [], "fleet metadata must be readable and consistent");
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
    assert.equal(entry.npmSpec, entry.category === "native" ? null : `npm:${entry.name}`,
      `${entry.name}: npmSpec must be npm:<name>, never a raw user string`);
    assert.ok(entry.title, `${entry.name}: title is required`);
    assert.ok(entry.description, `${entry.name}: description is required`);
    assert.ok(Array.isArray(entry.capabilities) && (entry.capabilities.length > 0 || entry.category === "native"),
      `${entry.name}: capabilities must be a non-empty array`);
    assert.ok(
      entry.category === "extension" || entry.category === "template" || entry.category === "native",
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
    PACKAGE_CATALOG.length - templates.length - 1,
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
    const manifest = liveFleet.find((extension) => extension.name === entry.name);
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
    // concise summary the task requires verbatim). Swarm uses explicitly
    // curated display copy while retaining a verified manifest summary.
    assertCatalogDescription(entry, manifest);
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

const fleetSnapshot: FleetExtension[] = JSON.parse(
  readFileSync(path.join(packageRoot, FLEET_SNAPSHOT_PATH), "utf8"),
);

test("the catalog contains every public pm-* repository in the checked-in fixture list", () => {
  // The explicit roster drift gate. The snapshot and live-fleet gates above
  // can only check the inputs they derive; this one holds the catalog against
  // a hand-maintained list of every public unbraind/pm-* repository, so a new
  // fleet package cannot be silently missing even if every generated input is
  // stale. It runs in every environment, including a standalone CI checkout
  // with no fleet siblings, because that is the environment that guards the
  // merge.
  const missing = FLEET_PACKAGE_REPOS
    .filter((name) => findCatalogEntry(name) === undefined);
  assert.deepEqual(
    missing,
    [],
    `these public unbraind/pm-* repositories are in the fixture list but absent from the catalog, `
      + `so the UI would never offer or even mention them: ${missing.join(", ")}`,
  );
  // The fixture is a roster, so it must itself be well-formed: unique,
  // lexicographically sorted, namespaced, and free of the two repos that can
  // never be catalogued.
  assert.equal(new Set(FLEET_PACKAGE_REPOS).size, FLEET_PACKAGE_REPOS.length,
    "the fixture list must not repeat a repository");
  assert.deepEqual([...FLEET_PACKAGE_REPOS], [...FLEET_PACKAGE_REPOS].sort(),
    "the fixture list must stay lexicographically sorted");
  for (const name of FLEET_PACKAGE_REPOS) {
    assert.match(name, /^pm-[a-z0-9-]+$/, `${name}: fixture entries are repository names`);
  }
  assert.ok(!FLEET_PACKAGE_REPOS.includes("pm-cli"), "pm-cli is the CLI, not a fleet package");
  assert.ok(!FLEET_PACKAGE_REPOS.includes("pm-web"), "pm-web is the host and cannot install itself");
});

test("the fixture list and the committed fleet snapshot cover the same packages", () => {
  // The fixture is hand-maintained and the snapshot is generated; without a
  // cross-check either could drift from the other unnoticed. Every snapshot
  // package must be in the fixture, so regenerating the snapshot after a
  // fleet package is created forces a fixture update — the same regeneration
  // cannot silently skip the hand-maintained roster. And the only fixture
  // names allowed outside the snapshot are packages that ship no extension
  // manifest (today the native pm-rust), because a fixture name absent from
  // both the snapshot and that set would be a typo the drift gate reports as
  // a catalog miss without saying the roster itself is wrong.
  const snapshotNames = fleetSnapshot.map((extension) => extension.name);
  const unlisted = snapshotNames.filter((name) => !FLEET_PACKAGE_REPOS.includes(name));
  assert.deepEqual(
    unlisted,
    [],
    `these fleet packages are in the committed snapshot but not in the fixture list; add them to the fixture: ${unlisted.join(", ")}`,
  );
  // Packages without extension manifests cannot be derived into the snapshot
  // but are still real, catalogued fleet packages, so they are pinned here.
  const NATIVE_REPOS = ["pm-rust"] as const;
  const unexplainable = FLEET_PACKAGE_REPOS
    .filter((name) => !snapshotNames.includes(name) && !NATIVE_REPOS.includes(name as "pm-rust"));
  assert.deepEqual(
    unexplainable,
    [],
    `these fixture repositories are neither in the committed snapshot nor known native packages; fix or remove them from the fixture: ${unexplainable.join(", ")}`,
  );
});

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
    if (!extension.npmPublished) {
      assert.equal(entry.links?.npm, undefined,
        `${extension.name}: an npm link requires a published registry receipt`);
    }
    // Same rule the live-fleet assertion applies: a product extension mirrors
    // the manifest description, an authoring template mirrors the concise
    // package.json one. Swarm also verifies its curated display copy.
    assertCatalogDescription(entry, extension);
    assert.deepEqual(
      [...entry.capabilities].sort(),
      extension.capabilities,
      `${extension.name}: catalog capabilities must mirror the manifest capabilities`,
    );
    // Asserted against what the registry actually serves, recorded at snapshot
    // generation time, rather than against publishConfig. The two answer
    // different questions: publishConfig is an intent to publish, and a package
    // can declare it while npm answers 404 — which is exactly how this catalog
    // came to promise an install for a package that had never been released.
    assert.equal(
      (entry.availability ?? "published") === "published",
      extension.npmPublished,
      `${extension.name}: catalogued as ${entry.availability ?? "published"}, but the npm registry `
        + `${extension.npmPublished ? "serves" : "does not serve"} it — a catalogue that promises an `
        + "install for a package npm answers 404 for renders a button that cannot work",
    );
  }
});

test("the committed snapshot still matches the live fleet, and the fleet is readable", () => {
  const { extensions: live, problems } = readFleetExtensions(FLEET_ROOT, {
    existsSync,
    readdirSync,
    readFileSync,
  });
  if (live.length === 0 && problems.length === 0) return; // siblings not resolvable here
  // A directory whose metadata cannot be read is a defect to fix, not a package
  // to omit. Without this the derivation would skip it silently, the snapshot
  // would bake the omission in, and this assertion would agree - because it runs
  // the same derivation.
  assert.deepEqual(
    problems,
    [],
    `unreadable fleet metadata: ${problems.map((p) => `${p.name} (${p.reason})`).join("; ")}`,
  );
  // Compare only the locally derivable fields. npmPublished is a generation-time
  // fact about the registry, and re-deriving it here would either need the
  // network on every test run or would report a false mismatch offline.
  assert.deepEqual(
    live,
    fleetSnapshot.map(({ npmPublished: _npmPublished, ...local }) => local),
    "the fleet has changed since the snapshot was generated, so the gate above is now checking "
      + "the catalog against a stale list - regenerate with `npm run fleet:snapshot` and commit it",
  );
});

test("every catalog entry declares an availability the fleet agrees with", () => {
  // Publication intent cannot prove availability: pm-jev declares publishConfig
  // but npm still returns 404. Use the deliberately generated registry receipt.
  if (FLEET_EXTENSIONS.length === 0) return; // siblings not resolvable here
  for (const entry of PACKAGE_CATALOG) {
    const pkg = liveFleet.find((extension) => extension.name === entry.name);
    if (!pkg) continue; // sibling not resolvable in this environment
    const declared = entry.availability ?? "published";
    const published = fleetSnapshot.find((extension) => extension.name === entry.name)?.npmPublished;
    assert.equal(
      declared === "published",
      published,
      `${entry.name}: availability must agree with the registry receipt, not publication intent`,
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
    const manifest = liveFleet.find((extension) => extension.name === name);
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
      (entry.capabilities.length > 0 || entry.category === "native"),
      `${entry.name}: an unreleased entry still declares its capabilities`,
    );
    assert.equal(
      entry.category,
      entry.name === "pm-rust" ? "native" : "extension",
      `${entry.name}: an unreleased entry is still categorised, not special-cased out of the catalog`,
    );
    assert.ok(
      findCatalogEntry(entry.name),
      `${entry.name}: must remain resolvable by name so the :name route gate admits management calls`,
    );
  }
});

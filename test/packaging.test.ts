import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Shape of the fields this suite asserts on. Only the dependency maps matter
 * here; the rest of the manifest is deliberately not modelled so an unrelated
 * field addition cannot fail this suite.
 */
interface DependencyManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** The published manifest, read from disk rather than imported so the assertions run against the same bytes npm publishes. */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as DependencyManifest;

/** The host CLI package whose placement in the manifest this suite governs. */
const HOST_CLI = "@unbrained/pm-cli";

/**
 * An exact version: digits and dots only, with no range operator, so npm
 * resolves one version rather than "whatever is newest and still matching".
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * This package is dual-mode, and that is what decides the CLI's placement.
 *
 * It is a pm extension — it ships a manifest, calls `defineExtension`, and the
 * host can load it — but it is ALSO a standalone server: `npm start` runs
 * `node dist/server.js`, and the Docker image installs its runtime layer with
 * `npm ci --omit=dev`. In that mode no host CLI is present to satisfy a peer
 * range, and `dist/services/pm-runner.js` both imports the SDK and executes the
 * packaged `node_modules/@unbrained/pm-cli/dist/cli.js` directly.
 *
 * So the CLI is a genuine runtime dependency here, unlike the extension-only
 * siblings (pm-beads, pm-brief, pm-slack-standup) where declaring it as a
 * dependency let npm resolve a second nested copy alongside the host's. Moving
 * it to devDependencies in this package would omit it from the production image
 * and the server would fail to start on its first SDK import.
 *
 * It must not ALSO be a peer: two separately satisfiable ranges are exactly what
 * lets npm install one copy at the tree root and a different one underneath.
 */
test("the host CLI is a runtime dependency because the server runs standalone, and is never also a peer", () => {
  assert.ok(
    manifest.dependencies?.[HOST_CLI],
    `${HOST_CLI} must stay in dependencies: the Docker runtime installs with --omit=dev and dist/server.js resolves the SDK at startup`,
  );
  assert.equal(
    manifest.peerDependencies?.[HOST_CLI],
    undefined,
    `${HOST_CLI} must not be a peer as well as a dependency: two separately satisfiable ranges let npm resolve one copy at the tree root and a different one nested under this package`,
  );
  assert.match(
    String(manifest.scripts?.start),
    /dist\/server\.js/,
    "the standalone server entry point is the reason the CLI is a runtime dependency; if this changes, revisit the placement above",
  );
});

/**
 * The pinned version is what both CI and the production image install, so it
 * decides the verdict the gates report and the code the server actually runs.
 *
 * A caret range is not a pin: it admits any later release, and three
 * consecutive CLI releases disagreed about whether the same bytes on disk are
 * fatal, a warning, or invisible. Pinning exactly keeps the gate reproducible
 * and the deployed runtime predictable.
 *
 * The assertion is on the shape rather than today's literal version: hardcoding
 * the number would turn every Dependabot bump into a test failure needing a
 * second, lockstep edit, without buying any safety.
 */
test("the host CLI is pinned to an exact version rather than a range", () => {
  const declared = manifest.dependencies?.[HOST_CLI];
  assert.ok(declared, `${HOST_CLI} must be declared for the server to resolve the SDK`);
  assert.match(
    declared,
    EXACT_VERSION,
    `${HOST_CLI} must be pinned exactly, not declared as the range "${declared}": both the gate verdict and the deployed server depend on which CLI version resolves`,
  );
});

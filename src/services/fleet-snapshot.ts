/**
 * The fleet's own account of which pm extensions exist, and how the catalog
 * completeness gate reads it in an environment without the sibling packages.
 *
 * pm-web must offer every pm package that exists, so the catalog needs a gate
 * asserting the converse of "every catalog entry is real": that every real
 * extension is catalogued. The authoritative answer lives in the sibling
 * package directories, and a standalone CI checkout of pm-web has none of them.
 * A gate that reads them directly therefore skips itself precisely where it
 * guards the merge.
 *
 * The resolution is a committed snapshot, generated from the live fleet and
 * read by the gate. The snapshot is an input, never the source of truth: a
 * companion assertion re-derives it from the siblings wherever they resolve, so
 * a snapshot that stopped matching the fleet fails loudly instead of quietly
 * narrowing what CI checks.
 */

/** Repository-relative location of the committed fleet snapshot. */
export const FLEET_SNAPSHOT_PATH = "test/fleet-extensions.snapshot.json";

/**
 * Directories under the fleet root that are not extensions of the CLI.
 *
 * `pm-web` is the host and cannot install itself; `pm-cli` is the CLI rather
 * than an extension of it.
 */
const CATALOG_HOSTS: ReadonlySet<string> = new Set(["pm-web", "pm-cli"]);

/**
 * A directory the derivation could not read as it expected.
 *
 * Returned rather than swallowed. A silent skip is the failure mode this whole
 * mechanism exists to remove: an extension omitted because its manifest failed
 * to parse looks exactly like an extension that is not there, and because the
 * generator and the freshness assertion run the *same* derivation, both would
 * agree on the same wrong answer and neither would report it.
 */
export interface FleetProblem {
  /** Directory the problem was found in. */
  name: string;
  /** What could not be read, in terms a reader can act on. */
  reason: string;
}

/**
 * What the fleet directories alone can say about one extension.
 *
 * Split from {@link FleetExtension} deliberately: every field here is derivable
 * offline from files on disk, which is what the freshness assertion can
 * re-derive and compare. Registry state cannot be, so it lives only on the
 * snapshot type.
 */
export interface LocalFleetExtension {
  /** Directory and package name, e.g. `pm-ado`. */
  name: string;
  /** The manifest's description, which a product extension's catalog entry mirrors exactly. */
  description: string;
  /**
   * The package.json description.
   *
   * An authoring template's catalog entry mirrors this rather than the manifest
   * description: the manifest carries a longer, capability-enumerating blurb
   * that is too verbose for a one-line catalog card, while package.json holds
   * the concise summary. Both are captured so the gate can apply the same rule
   * the live-fleet assertion does without knowing anything about categories.
   */
  packageDescription: string;
  /** Capability names the manifest declares, sorted for a stable comparison. */
  capabilities: string[];
  /**
   * Whether the package declares `publishConfig`.
   *
   * A local, offline signal of *intent* to publish. It is deliberately not the
   * thing the catalog's `availability` is checked against, because it answers
   * the wrong question: a package can declare `publishConfig` and be absent
   * from npm, which is exactly how this fleet came to have a catalog entry
   * promising an install for a package the registry answers 404 for.
   */
  publishable: boolean;
}

/** One fleet extension as the committed snapshot records it. */
export interface FleetExtension extends LocalFleetExtension {
  /**
   * Whether the npm registry actually serves this package.
   *
   * Recorded at generation time, when the network is available and regenerating
   * the snapshot is a deliberate act, so the offline gate can assert against a
   * fact rather than a proxy. Generation refuses to write when the registry
   * could not be reached, so this is never a guess: an unreachable registry
   * would otherwise relabel every package as unpublished the moment a runner
   * lost the network.
   */
  npmPublished: boolean;
}

/** The filesystem calls {@link readFleetExtensions} needs, injected so the
 * derivation can be exercised against a synthetic tree. */
export interface FleetFs {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string, options: { withFileTypes: true }) => { name: string; isDirectory: () => boolean }[];
  readFileSync: (p: string, encoding: "utf8") => string;
}

/**
 * Derive every pm extension present under `fleetRoot`.
 *
 * A directory is a pm extension exactly when it ships a `manifest.json`
 * declaring a non-empty `capabilities` array. That rule is the definition
 * rather than a heuristic: it is what makes a package installable into pm at
 * all, so deriving membership from it cannot drift from reality the way a
 * second hardcoded list would.
 *
 * @param fleetRoot - Directory holding the sibling package directories.
 * @param fs - Filesystem accessors to read the tree with.
 * @returns Every extension found, sorted by name; empty when the fleet root
 *          holds none, which callers must treat as "not resolvable here"
 *          rather than as "the fleet is empty".
 */
export function readFleetExtensions(
  fleetRoot: string,
  fs: FleetFs,
): { extensions: LocalFleetExtension[]; problems: FleetProblem[] } {
  if (!fs.existsSync(fleetRoot)) return { extensions: [], problems: [] };
  const found: LocalFleetExtension[] = [];
  const problems: FleetProblem[] = [];
  for (const entry of fs.readdirSync(fleetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pm-") || CATALOG_HOSTS.has(entry.name)) continue;
    const manifestPath = `${fleetRoot}/${entry.name}/manifest.json`;
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { description?: unknown; capabilities?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
    } catch {
      // A manifest that exists and does not parse is a defect in that package,
      // not evidence that it is not an extension. Reporting it is the whole
      // point: skipping silently is indistinguishable from absence.
      problems.push({ name: entry.name, reason: "manifest.json exists but is not valid JSON" });
      continue;
    }
    const capabilities = manifest.capabilities;
    if (!Array.isArray(capabilities)) {
      problems.push({ name: entry.name, reason: "manifest.json declares no capabilities array" });
      continue;
    }
    if (capabilities.length === 0) continue;
    let publishable = false;
    let packageDescription = "";
    const packageJsonPath = `${fleetRoot}/${entry.name}/package.json`;
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          publishConfig?: unknown;
          description?: unknown;
        };
        publishable = packageJson.publishConfig !== undefined;
        packageDescription =
          typeof packageJson.description === "string" ? packageJson.description : "";
      } catch {
        publishable = false;
        problems.push({ name: entry.name, reason: "package.json exists but is not valid JSON" });
      }
    }
    found.push({
      name: entry.name,
      description: typeof manifest.description === "string" ? manifest.description : "",
      packageDescription,
      capabilities: [...capabilities].map(String).sort(),
      publishable,
    });
  }
  return {
    extensions: found.sort((a, b) => a.name.localeCompare(b.name)),
    problems: problems.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

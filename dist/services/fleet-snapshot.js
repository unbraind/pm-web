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
const CATALOG_HOSTS = new Set(["pm-web", "pm-cli"]);
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
export function readFleetExtensions(fleetRoot, fs) {
    if (!fs.existsSync(fleetRoot))
        return [];
    const found = [];
    for (const entry of fs.readdirSync(fleetRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("pm-") || CATALOG_HOSTS.has(entry.name))
            continue;
        const manifestPath = `${fleetRoot}/${entry.name}/manifest.json`;
        if (!fs.existsSync(manifestPath))
            continue;
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        }
        catch {
            continue;
        }
        const capabilities = manifest.capabilities;
        if (!Array.isArray(capabilities) || capabilities.length === 0)
            continue;
        let publishable = false;
        let packageDescription = "";
        const packageJsonPath = `${fleetRoot}/${entry.name}/package.json`;
        if (fs.existsSync(packageJsonPath)) {
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
                publishable = packageJson.publishConfig !== undefined;
                packageDescription =
                    typeof packageJson.description === "string" ? packageJson.description : "";
            }
            catch {
                publishable = false;
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
    return found.sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=fleet-snapshot.js.map
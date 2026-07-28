/**
 * The set of capabilities a pm package can declare, mirrored verbatim from
 * each package's `manifest.json` `capabilities` array. The union is kept
 * open-ended as a string array (not a closed enum) because the pm extension
 * contract may add new capability kinds upstream; pinning a closed list here
 * would reject a future package that uses a capability we have not enumerated.
 */
export type PackageCapability = string;
/**
 * Honest gating metadata so the UI can tell a user what they must configure
 * before a package is useful. Both fields are OPTIONAL — most packages work
 * with no external setup.
 *
 * - `requiresService`: a backing service the package talks to (e.g. Neo4j for
 *   pm-graph's sync). When set, the UI explains that the package's
 *   service-dependent features will not work until the service is reachable.
 *   `optional: true` means the package is still useful without the service
 *   (e.g. pm-graph's offline export/analyze work without Neo4j).
 *
 * - `requiresCredentials`: human-supplied secrets the package needs for its
 *   network-mutating commands (e.g. JIRA_API_TOKEN, LINEAR_API_KEY,
 *   PM_SLACK_WEBHOOK, GITHUB_TOKEN). Each entry names the env var(s) and a
 *   short human description. The UI must not pretend these are one-click; it
 *   surfaces the variables the user must set.
 */
export interface ServiceRequirement {
    /** Display name of the backing service, e.g. "Neo4j". */
    name: string;
    /** True when the package is useful without the service (best-effort). */
    optional?: boolean;
}
export interface CredentialRequirement {
    /** Display label for what the credentials unlock, e.g. "Jira sync". */
    label: string;
    /** Environment variable(s) the package reads for the credentials. */
    envVars: string[];
    /**
     * True when the package is partially usable without the credentials (e.g.
     * `--dry-run` paths, unauthenticated reads). When false, the package is
     * inert until the credentials are configured.
     */
    optional?: boolean;
}
export interface PackageCatalogEntry {
    /** Canonical npm package name, e.g. `pm-graph`. */
    readonly name: string;
    /** The install spec passed to `pm install`, always `npm:<name>`. */
    readonly npmSpec: string;
    /** Human-friendly title, e.g. `Graph`. */
    readonly title: string;
    /** One-line description, mirrored from the package's manifest/package.json. */
    readonly description: string;
    /** Capabilities declared in the package manifest. */
    readonly capabilities: readonly PackageCapability[];
    /** Backing service the package needs (optional). */
    readonly requiresService?: ServiceRequirement;
    /** Credentials the user must configure (optional). */
    readonly requiresCredentials?: readonly CredentialRequirement[];
}
/**
 * The catalog. Order is the display order in the UI. The list is exhaustive
 * over user-facing pm packages: every package in the fleet that is not an
 * authoring template (`pm-starter`/`pm-ts-starter`) and not pm-web itself is
 * here. `pm-starter`/`pm-ts-starter` are authoring templates, not user-facing
 * packages; `pm-web` is this package.
 */
export declare const PACKAGE_CATALOG: readonly PackageCatalogEntry[];
/**
 * Look up a catalog entry by package name. Returns the entry or `undefined`
 * when the name is not in the catalog. This is the security-critical gate:
 * route handlers MUST call this and reject with 400 on a miss BEFORE passing
 * the name to any pm command, so a user-supplied string can never be
 * interpolated into an install target.
 */
export declare function findCatalogEntry(name: string): PackageCatalogEntry | undefined;
/**
 * Resolve a package name to its verified npm install spec
 * (`npm:<name>`), or `null` when the name is not in the catalog. Route
 * handlers use this to obtain the spawn argument without ever building an
 * install target from a raw user string.
 */
export declare function resolveNpmSpec(name: string): string | null;
/** The immutable list of catalog package names, in display order. */
export declare function catalogNames(): readonly string[];

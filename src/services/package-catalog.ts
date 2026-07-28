// ═══════════════════════════════════════════════════════════════
// PACKAGE CATALOG — the typed, immutable list of every user-facing pm package
// ═══════════════════════════════════════════════════════════════
//
// pm-web used to ship exactly one pm package — a vendored copy of pm-graph
// pinned to an old CLI — and offered no way to install any other. This
// catalog is the single source of truth for the per-project "Packages" view
// and the extensions routes: every package the UI can install is declared
// here, and every `:name` route parameter is validated against it BEFORE a
// pm command is ever spawned. A user-supplied name can never reach an install
// target — a catalog lookup miss must 400 before any process spawn.
//
// Truthfulness contract: the catalog mirrors each package's real
// `manifest.json` (name, capabilities) and README (gating). Do NOT invent
// capabilities or hide requirements here — the UI surfaces `requiresService`
// and `requiresCredentials` so users are not promised a one-click install for
// a package that needs a Neo4j instance or an API token. The
// `test/catalog.test.ts` suite asserts that every entry's declared capabilities
// match the on-disk `manifest.json` under fleet/<pkg>/manifest.json, so a
// drift between this catalog and the packages is a failing test, not a silent
// UI lie.

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
export const PACKAGE_CATALOG: readonly PackageCatalogEntry[] = [
  {
    name: "pm-graph",
    npmSpec: "npm:pm-graph",
    title: "Graph",
    description:
      "Knowledge graph and dependency graph extension for pm CLI workspaces, with optional Neo4j sync.",
    capabilities: ["commands", "importers", "services"],
    requiresService: { name: "Neo4j", optional: true },
  },
  {
    name: "pm-beads",
    npmSpec: "npm:pm-beads",
    title: "Beads",
    description:
      "Beads JSONL importer/exporter. Import work items from the Beads JSONL format into pm and export pm items back to Beads JSONL, preserving ids and dependency edges.",
    capabilities: ["commands", "schema", "importers"],
  },
  {
    name: "pm-brief",
    npmSpec: "npm:pm-brief",
    title: "Brief",
    description:
      "Token-budgeted agent briefs and next-work plans for pm workspaces",
    capabilities: ["commands", "renderers", "schema"],
  },
  {
    name: "pm-changelog",
    npmSpec: "npm:pm-changelog",
    title: "Changelog",
    description: "Generate CHANGELOG.md release notes from pm-cli items",
    capabilities: ["commands", "schema", "importers", "renderers"],
  },
  {
    name: "pm-context",
    npmSpec: "npm:pm-context",
    title: "Context",
    description:
      "Generate deterministic pm context packs for agent handoffs, reviews, and status briefs",
    capabilities: ["commands", "renderers", "schema"],
  },
  {
    name: "pm-csv",
    npmSpec: "npm:pm-csv",
    title: "CSV",
    description: "CSV importer and exporter for pm-cli",
    capabilities: ["commands", "importers", "schema"],
  },
  {
    name: "pm-gantt-chart",
    npmSpec: "npm:pm-gantt-chart",
    title: "Gantt Chart",
    description:
      "ASCII Gantt chart renderer + multi-format exporter for pm-cli",
    capabilities: ["commands", "schema", "importers", "preflight"],
  },
  {
    name: "pm-github",
    npmSpec: "npm:pm-github",
    title: "GitHub",
    description:
      "GitHub Issues + Projects v2 integration. Imports issues as pm items (`pm github import`), exports pm items as GitHub issues, syncs issue state, and bidirectionally syncs pm items with a GitHub Projects v2 board (`pm github project import/sync/list/fields`) — mapping pm status to the board Status column with idempotent, no-data-loss provenance.",
    capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"],
    requiresCredentials: [
      {
        label: "GitHub token (for private repos, 5000 req/hr, and export/push)",
        envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
        optional: true,
      },
    ],
  },
  {
    name: "pm-jira",
    npmSpec: "npm:pm-jira",
    title: "Jira",
    description: "Jira issue sync for pm-cli",
    capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
    requiresCredentials: [
      {
        label: "Jira API credentials (for live sync, import, and export --push)",
        envVars: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
      },
    ],
  },
  {
    name: "pm-linear",
    npmSpec: "npm:pm-linear",
    title: "Linear",
    description: "Linear.app issue sync for pm-cli",
    capabilities: ["commands", "schema", "importers", "preflight"],
    requiresCredentials: [
      {
        label: "Linear API key (for live import/export and validate --check-network)",
        envVars: ["LINEAR_API_KEY"],
      },
    ],
  },
  {
    name: "pm-ops",
    npmSpec: "npm:pm-ops",
    title: "Ops",
    description: "Multi-repo fleet operations for pm-cli",
    capabilities: ["commands", "renderers", "schema", "parser"],
  },
  {
    name: "pm-presets",
    npmSpec: "npm:pm-presets",
    title: "Presets",
    description:
      "All 7 official pm-cli workspace presets in one package: bug-triage, indie-dev, open-source, software-sprint, startup-roadmap, kanban, agent-workflow",
    capabilities: ["commands", "schema"],
  },
  {
    name: "pm-slack",
    npmSpec: "npm:pm-slack",
    title: "Slack",
    description: "Slack notifications for pm item lifecycle events",
    capabilities: ["commands", "hooks", "schema", "preflight"],
    requiresCredentials: [
      {
        label: "Slack webhook (for posting notifications)",
        envVars: ["PM_SLACK_WEBHOOK"],
      },
    ],
  },
  {
    name: "pm-slack-standup",
    npmSpec: "npm:pm-slack-standup",
    title: "Slack Standup",
    description: "Post pm context as a Slack standup message",
    capabilities: ["commands", "schema", "importers", "preflight", "services"],
    requiresCredentials: [
      {
        label: "Slack webhook (for posting the standup)",
        envVars: ["PM_SLACK_WEBHOOK"],
      },
    ],
  },
  {
    name: "pm-todos",
    npmSpec: "npm:pm-todos",
    title: "Todos",
    description:
      "TODO round-trip. Import/export/sync markdown checkboxes, todo.txt, jsonl, checkbox, and pi coding-agent todo JSON as pm items.",
    capabilities: ["commands", "schema", "importers", "preflight"],
  },
];

/** A frozen map keyed by package name for O(1) catalog lookup. */
const CATALOG_BY_NAME: ReadonlyMap<string, PackageCatalogEntry> = new Map(
  PACKAGE_CATALOG.map((entry) => [entry.name, entry] as const),
);

/**
 * Look up a catalog entry by package name. Returns the entry or `undefined`
 * when the name is not in the catalog. This is the security-critical gate:
 * route handlers MUST call this and reject with 400 on a miss BEFORE passing
 * the name to any pm command, so a user-supplied string can never be
 * interpolated into an install target.
 */
export function findCatalogEntry(name: string): PackageCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}

/**
 * Resolve a package name to its verified npm install spec
 * (`npm:<name>`), or `null` when the name is not in the catalog. Route
 * handlers use this to obtain the spawn argument without ever building an
 * install target from a raw user string.
 */
export function resolveNpmSpec(name: string): string | null {
  const entry = CATALOG_BY_NAME.get(name);
  return entry ? entry.npmSpec : null;
}

/** The immutable list of catalog package names, in display order. */
export function catalogNames(): readonly string[] {
  return PACKAGE_CATALOG.map((entry) => entry.name);
}
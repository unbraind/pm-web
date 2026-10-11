// ═══════════════════════════════════════════════════════════════
// PACKAGE CATALOG — the typed, immutable list of every installable pm package
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
// The catalog lists every public fleet package except `pm-web`
// itself (this package IS the host, so it cannot install itself). The
// `category` field distinguishes user-facing product extensions
// (`"extension"`) from authoring reference templates (`"template"`): the
// starters are real, published npm packages that ship `manifest.json` +
// `dist/` and call `registerCommand`, so installing them genuinely registers
// working commands — they exist to be read and copied as reference
// implementations covering every capability type, and the UI badges them so a
// user can tell a learning scaffold from a product extension.
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
 * The catalog. Order is the display order in the UI. The list is exhaustive
 * over every published pm package except `pm-web` itself (it is the host and
 * cannot install itself). The {@link PackageCategory} field on each entry
 * distinguishes user-facing product extensions from authoring reference
 * templates; the two starter packages sort last so product extensions appear
 * first.
 */
export const PACKAGE_CATALOG = [
    {
        name: "pm-graph",
        npmName: "pm-graph",
        commands: ["pm pm-graph ping", "pm pm-graph export", "pm pm-graph cypher", "pm pm-graph sync", "pm pm-graph status", "pm pm-graph query", "pm pm-graph neighbors", "pm pm-graph analyze", "pm pm-graph cycles", "pm pm-graph path", "pm pm-graph explain", "pm pm-graph critical-path", "pm pm-graph topo-sort", "pm pm-graph impact", "pm graph-export export"],
        links: { "docs": "https://github.com/unbraind/pm-graph#readme", "npm": "https://www.npmjs.com/package/pm-graph", "repository": "https://github.com/unbraind/pm-graph", "report": "https://github.com/unbraind/pm-graph/issues" },
        npmSpec: "npm:pm-graph",
        title: "Graph",
        description: "Knowledge graph and dependency graph extension for pm CLI workspaces, with optional Neo4j sync.",
        capabilities: ["commands", "importers", "services"],
        category: "extension",
        requiresService: { name: "Neo4j", optional: true },
    },
    {
        name: "pm-ado",
        npmName: "pm-ado",
        commands: ["pm ado validate"],
        links: { "docs": "https://github.com/unbraind/pm-ado#readme", "repository": "https://github.com/unbraind/pm-ado", "report": "https://github.com/unbraind/pm-ado/issues" },
        npmSpec: "npm:pm-ado",
        title: "Azure DevOps",
        description: "Azure DevOps client foundation for pm-cli. Its work-item updates assert System.Rev, batch reads surface missing items, and same-organization typed relations map to pm links. Full sync commands and revision-to-history reconciliation are planned.",
        capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
        category: "extension",
        // Release-gated behind vars.PM_RELEASE_APPROVED and absent from npm, so no
        // install spec resolves. Listed rather than hidden: a user reading the fleet
        // on GitHub can plainly see this package, and omitting it would make the
        // catalogue look complete while the UI never mentioned it.
        availability: "unreleased",
        requiresCredentials: [
            {
                label: "Azure DevOps credentials (organization URL, project, and a personal access token)",
                envVars: ["ADO_ORG_URL", "ADO_PROJECT", "ADO_TOKEN"],
            },
        ],
    },
    {
        name: "pm-beads",
        npmName: "pm-beads",
        commands: ["pm beads import", "pm beads export", "pm beads validate", "pm beads diff", "pm beads-import", "pm beads-export", "pm beads-validate", "pm beads-diff"],
        links: { "docs": "https://github.com/unbraind/pm-beads#readme", "npm": "https://www.npmjs.com/package/pm-beads", "repository": "https://github.com/unbraind/pm-beads", "report": "https://github.com/unbraind/pm-beads/issues" },
        npmSpec: "npm:pm-beads",
        title: "Beads",
        description: "Beads JSONL importer/exporter. Import work items from the Beads JSONL format into pm and export pm items back to Beads JSONL, preserving ids and dependency edges.",
        capabilities: ["commands", "schema", "importers"],
        category: "extension",
    },
    {
        name: "pm-brief",
        npmName: "pm-brief",
        commands: ["pm brief", "pm brief prompt", "pm brief next", "pm brief stale", "pm brief since", "pm brief diverge", "pm brief duplicates"],
        links: { "docs": "https://github.com/unbraind/pm-brief#readme", "npm": "https://www.npmjs.com/package/pm-brief", "repository": "https://github.com/unbraind/pm-brief", "report": "https://github.com/unbraind/pm-brief/issues" },
        npmSpec: "npm:pm-brief",
        title: "Brief",
        description: "Token-budgeted agent briefs and next-work plans for pm workspaces",
        capabilities: ["commands", "renderers", "schema"],
        category: "extension",
    },
    {
        name: "pm-changelog",
        npmName: "pm-changelog",
        commands: ["pm changelog generate", "pm changelog export"],
        links: { "docs": "https://github.com/unbraind/pm-changelog#readme", "npm": "https://www.npmjs.com/package/pm-changelog", "repository": "https://github.com/unbraind/pm-changelog", "report": "https://github.com/unbraind/pm-changelog/issues" },
        npmSpec: "npm:pm-changelog",
        title: "Changelog",
        description: "Generate CHANGELOG.md release notes from pm-cli items",
        capabilities: ["commands", "schema", "importers", "renderers"],
        category: "extension",
    },
    {
        name: "pm-context",
        npmName: "pm-context",
        commands: ["pm context-pack", "pm context-handoff", "pm context-usage"],
        links: { "docs": "https://github.com/unbraind/pm-context#readme", "repository": "https://github.com/unbraind/pm-context", "report": "https://github.com/unbraind/pm-context/issues", "npm": "https://www.npmjs.com/package/pm-context" },
        npmSpec: "npm:pm-context",
        title: "Context",
        description: "Generate deterministic pm context packs for agent handoffs, reviews, and status briefs",
        capabilities: ["commands", "renderers", "schema"],
        category: "extension",
    },
    {
        name: "pm-csv",
        npmName: "pm-csv",
        commands: ["pm csv import", "pm csv export", "pm csv validate", "pm csv-export export"],
        links: { "docs": "https://github.com/unbraind/pm-csv#readme", "npm": "https://www.npmjs.com/package/pm-csv", "repository": "https://github.com/unbraind/pm-csv", "report": "https://github.com/unbraind/pm-csv/issues" },
        npmSpec: "npm:pm-csv",
        title: "CSV",
        description: "CSV importer and exporter for pm-cli",
        capabilities: ["commands", "importers", "schema"],
        category: "extension",
    },
    {
        name: "pm-gantt-chart",
        npmName: "pm-gantt-chart",
        commands: ["pm gantt", "pm gantt export"],
        links: { "docs": "https://github.com/unbraind/pm-gantt-chart#readme", "npm": "https://www.npmjs.com/package/pm-gantt-chart", "repository": "https://github.com/unbraind/pm-gantt-chart", "report": "https://github.com/unbraind/pm-gantt-chart/issues" },
        npmSpec: "npm:pm-gantt-chart",
        title: "Gantt Chart",
        description: "ASCII Gantt chart renderer + multi-format exporter for pm-cli",
        capabilities: ["commands", "schema", "importers", "preflight"],
        category: "extension",
    },
    {
        name: "pm-github",
        npmName: "pm-github",
        commands: ["pm github import", "pm github export", "pm github sync", "pm github validate", "pm github gate", "pm github project list", "pm github project fields", "pm github project import", "pm github project sync"],
        links: { "docs": "https://github.com/unbraind/pm-github#readme", "npm": "https://www.npmjs.com/package/pm-github", "repository": "https://github.com/unbraind/pm-github", "report": "https://github.com/unbraind/pm-github/issues" },
        npmSpec: "npm:pm-github",
        title: "GitHub",
        description: "GitHub Issues + Projects v2 integration. Imports issues as pm items (`pm github import`), exports pm items as GitHub issues, syncs issue state, and bidirectionally syncs pm items with a GitHub Projects v2 board (`pm github project import/sync/list/fields`) — mapping pm status to the board Status column with idempotent, no-data-loss provenance.",
        capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"],
        category: "extension",
        requiresCredentials: [
            {
                label: "GitHub token (for private repos, 5000 req/hr, and export/push)",
                envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
                optional: true,
            },
        ],
    },
    {
        name: "pm-jev",
        npmName: "pm-jev",
        commands: ["pm jev triage", "pm jev dedupe", "pm jev ask", "pm jev gate", "pm jev models", "pm jev doctor"],
        links: { "docs": "https://github.com/unbraind/pm-jev#readme", "repository": "https://github.com/unbraind/pm-jev", "report": "https://github.com/unbraind/pm-jev/issues" },
        npmSpec: "npm:pm-jev",
        title: "Jev",
        description: "Typed, local-first System One decisions for pm items: batched choice/score/noul questions over a least-privilege item projection, answered by a local Ollama tev1 model by default or TypeSafe's hosted Jev behind an explicit privacy opt-in. Decisions are proposals: nothing is mutated unless --apply clears a configured probability threshold, and every applied proposal records a redacted receipt comment. Commands: jev triage, jev dedupe, jev ask, jev gate, jev models, jev doctor.",
        capabilities: ["commands", "schema"],
        category: "extension",
        availability: "unreleased",
        requiresService: { name: "Ollama (tev1:4b), or TypeSafe Jev with explicit privacy opt-in" },
        requiresCredentials: [{
                label: "TypeSafe hosted provider only (also requires jev.allow_external: true)",
                envVars: ["TYPESAFE_API_KEY"],
                optional: true,
            }],
    },
    {
        name: "pm-jira",
        npmName: "pm-jira",
        commands: ["pm jira sync", "pm jira import", "pm jira export", "pm jira validate"],
        links: { "docs": "https://github.com/unbraind/pm-jira#readme", "npm": "https://www.npmjs.com/package/pm-jira", "repository": "https://github.com/unbraind/pm-jira", "report": "https://github.com/unbraind/pm-jira/issues" },
        npmSpec: "npm:pm-jira",
        title: "Jira",
        description: "Jira issue sync for pm-cli",
        capabilities: ["commands", "schema", "importers", "hooks", "preflight"],
        category: "extension",
        requiresCredentials: [
            {
                label: "Jira API credentials (for live sync, import, and export --push)",
                envVars: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
            },
        ],
    },
    {
        name: "pm-linear",
        npmName: "pm-linear",
        commands: ["pm linear sync", "pm linear import", "pm linear export", "pm linear validate"],
        links: { "docs": "https://github.com/unbraind/pm-linear#readme", "npm": "https://www.npmjs.com/package/pm-linear", "repository": "https://github.com/unbraind/pm-linear", "report": "https://github.com/unbraind/pm-linear/issues" },
        npmSpec: "npm:pm-linear",
        title: "Linear",
        description: "Linear.app issue sync for pm-cli",
        capabilities: ["commands", "schema", "importers", "preflight"],
        category: "extension",
        requiresCredentials: [
            {
                label: "Linear API key (for live import/export and validate --check-network)",
                envVars: ["LINEAR_API_KEY"],
            },
        ],
    },
    {
        name: "pm-ops",
        npmName: "pm-ops",
        commands: ["pm ops scan", "pm ops policy", "pm ops verify-release", "pm ops report", "pm ops status", "pm ops outdated", "pm ops audit", "pm ops metrics"],
        links: { "docs": "https://github.com/unbraind/pm-ops#readme", "npm": "https://www.npmjs.com/package/pm-ops", "repository": "https://github.com/unbraind/pm-ops", "report": "https://github.com/unbraind/pm-ops/issues" },
        npmSpec: "npm:pm-ops",
        title: "Ops",
        description: "Multi-repo fleet operations for pm-cli",
        capabilities: ["commands", "renderers", "schema", "parser", "services"],
        category: "extension",
    },
    {
        name: "pm-presets",
        npmName: "pm-presets",
        commands: ["pm presets", "pm presets list", "pm presets show", "pm presets diff", "pm presets validate", "pm presets apply", "pm presets export"],
        links: { "docs": "https://github.com/unbraind/pm-presets#readme", "npm": "https://www.npmjs.com/package/pm-presets", "repository": "https://github.com/unbraind/pm-presets", "report": "https://github.com/unbraind/pm-presets/issues" },
        npmSpec: "npm:pm-presets",
        title: "Presets",
        description: "All 7 official pm-cli workspace presets in one package: bug-triage, indie-dev, open-source, software-sprint, startup-roadmap, kanban, agent-workflow",
        capabilities: ["commands", "schema"],
        category: "extension",
    },
    {
        name: "pm-slack",
        npmName: "pm-slack",
        commands: ["pm slack notify", "pm slack test", "pm slack digest"],
        links: { "docs": "https://github.com/unbraind/pm-slack#readme", "npm": "https://www.npmjs.com/package/pm-slack", "repository": "https://github.com/unbraind/pm-slack", "report": "https://github.com/unbraind/pm-slack/issues" },
        npmSpec: "npm:pm-slack",
        title: "Slack",
        description: "Slack notifications for pm item lifecycle events",
        capabilities: ["commands", "hooks", "schema", "preflight"],
        category: "extension",
        requiresCredentials: [
            {
                label: "Slack webhook (for posting notifications)",
                envVars: ["PM_SLACK_WEBHOOK"],
            },
        ],
    },
    {
        name: "pm-slack-standup",
        npmName: "pm-slack-standup",
        commands: ["pm slack-standup", "pm standup", "pm standup export"],
        links: { "docs": "https://github.com/unbraind/pm-slack-standup#readme", "npm": "https://www.npmjs.com/package/pm-slack-standup", "repository": "https://github.com/unbraind/pm-slack-standup", "report": "https://github.com/unbraind/pm-slack-standup/issues" },
        npmSpec: "npm:pm-slack-standup",
        title: "Slack Standup",
        description: "Post pm context as a Slack standup message",
        capabilities: ["commands", "schema", "importers", "preflight", "services"],
        category: "extension",
        requiresCredentials: [
            {
                label: "Slack webhook (for posting the standup)",
                envVars: ["PM_SLACK_WEBHOOK"],
            },
        ],
    },
    {
        name: "pm-todos",
        npmName: "pm-todos",
        commands: ["pm todos import", "pm todos export", "pm todos sync", "pm todos context", "pm todos validate"],
        links: { "docs": "https://github.com/unbraind/pm-todos#readme", "npm": "https://www.npmjs.com/package/pm-todos", "repository": "https://github.com/unbraind/pm-todos", "report": "https://github.com/unbraind/pm-todos/issues" },
        npmSpec: "npm:pm-todos",
        title: "Todos",
        description: "TODO round-trip. Import/export/sync markdown checkboxes, todo.txt, jsonl, checkbox, and pi coding-agent todo JSON as pm items.",
        capabilities: ["commands", "schema", "importers", "preflight"],
        category: "extension",
    },
    {
        name: "pm-starter",
        npmName: "pm-starter",
        commands: ["pm starter greet", "pm starter summary", "pm starter demo", "pm starter plan", "pm starter context", "pm starter search", "pm starter setup", "pm starter-demo import", "pm starter-demo export"],
        links: { "docs": "https://github.com/unbraind/pm-starter#readme", "npm": "https://www.npmjs.com/package/pm-starter", "repository": "https://github.com/unbraind/pm-starter", "report": "https://github.com/unbraind/pm-starter/issues" },
        npmSpec: "npm:pm-starter",
        title: "Starter",
        description: "Complete starter/scaffold extension for pm-cli showing all capability types",
        capabilities: [
            "commands",
            "renderers",
            "hooks",
            "schema",
            "importers",
            "search",
            "parser",
            "preflight",
            "services",
        ],
        category: "template",
    },
    {
        name: "pm-ts-starter",
        npmName: "pm-ts-starter",
        commands: ["pm hello", "pm ts-starter info", "pm ts-starter-demo import", "pm ts-starter-demo export", "pm ts-starter plan-demo", "pm ts-starter context-demo", "pm ts-starter search-demo", "pm ts-starter history-compact-demo", "pm ts-starter setup"],
        links: { "docs": "https://github.com/unbraind/pm-ts-starter#readme", "npm": "https://www.npmjs.com/package/pm-ts-starter", "repository": "https://github.com/unbraind/pm-ts-starter", "report": "https://github.com/unbraind/pm-ts-starter/issues" },
        npmSpec: "npm:pm-ts-starter",
        title: "TypeScript Starter",
        description: "TypeScript reference extension for pm-cli covering all capability types",
        capabilities: [
            "commands",
            "renderers",
            "hooks",
            "schema",
            "importers",
            "search",
            "parser",
            "preflight",
            "services",
        ],
        category: "template",
    },
    {
        name: "pm-vcs",
        npmName: "pm-vcs",
        commands: ["pm vcs init", "pm vcs status", "pm vcs add", "pm vcs commit", "pm vcs log", "pm vcs diff", "pm vcs branch", "pm vcs switch", "pm vcs merge", "pm vcs tag", "pm vcs undo", "pm vcs oplog", "pm vcs export", "pm vcs import", "pm vcs remote", "pm vcs clone", "pm vcs fetch", "pm vcs push", "pm vcs serve", "pm vcs verify", "pm vcs trace", "pm vcs files", "pm vcs changes", "pm vcs items", "pm vcs authority", "pm vcs layer", "pm vcs layer local", "pm vcs link", "pm vcs link resolve", "pm vcs obliterate", "pm vcs recover-lock", "pm vcs git items", "pm vcs git preflight", "pm vcs git preview"],
        links: { "docs": "https://github.com/unbraind/pm-vcs#readme", "repository": "https://github.com/unbraind/pm-vcs", "report": "https://github.com/unbraind/pm-vcs/issues" },
        npmSpec: "npm:pm-vcs",
        title: "VCS",
        description: "A general version control system written from scratch on the pm SDK for arbitrary files and structured records, with stable file and change identities, native PM attribution, its own object store, refs, merge, operation log and bundles, and no Git dependency in its engine.",
        capabilities: ["commands", "schema"],
        category: "extension",
        availability: "unreleased",
    },
    {
        name: "pm-rl",
        npmName: "pm-rl",
        commands: ["pm rl env register", "pm rl env list", "pm rl env show", "pm rl benchmark register", "pm rl eval record", "pm rl leaderboard", "pm rl run start", "pm rl run log", "pm rl run show", "pm rl run finish", "pm rl run verify", "pm rl generation register", "pm rl generation promote", "pm rl generation show", "pm rl lineage", "pm rl invalidate", "pm rl compare", "pm rl sweep plan", "pm rl sweep status", "pm rl transfer record", "pm rl transfer gap", "pm rl episode env register", "pm rl episode record", "pm rl episode replay", "pm rl outcome record", "pm rl simreal gap", "pm rl loop run", "pm rl loop status", "pm rl loop resume"],
        links: { "docs": "https://github.com/unbraind/pm-rl#readme", "repository": "https://github.com/unbraind/pm-rl", "report": "https://github.com/unbraind/pm-rl/issues" },
        npmSpec: "npm:pm-rl",
        title: "RL",
        description: "Reinforcement-learning programme management on the pm SDK. Content-addressed environments and benchmarks keep runs and evaluations attributable; fail-closed leaderboards refuse mixed environments and contaminated suites. Commands: `pm rl env register/list/show`, `pm rl benchmark register`, `pm rl eval record`, `pm rl leaderboard`, `pm rl run start/log/show/finish`, `pm rl generation register/promote/show`, `pm rl lineage`, `pm rl invalidate`, and `pm rl compare`.",
        capabilities: ["commands", "hooks", "schema"],
        category: "extension",
        availability: "unreleased",
    },
    {
        name: "pm-rust",
        npmName: null,
        npmSpec: null,
        title: "Rust native CLI",
        description: "Independent Rust-native implementation of public pm workspace contracts",
        capabilities: [],
        commands: ["pm-rust list", "pm-rust get", "pm-rust create", "pm-rust update", "pm-rust comment", "pm-rust close"],
        category: "native",
        availability: "unreleased",
        unavailableReason: "pm-rust is a pre-release native CLI, not an npm extension. It cannot be installed or enabled in a project by pm-web; see its documentation for native setup and supported workspace contracts.",
        links: {
            docs: "https://github.com/unbraind/pm-rust#readme",
            repository: "https://github.com/unbraind/pm-rust",
            report: "https://github.com/unbraind/pm-rust/issues",
        },
    },
];
/** A frozen map keyed by package name for O(1) catalog lookup. */
const CATALOG_BY_NAME = new Map(PACKAGE_CATALOG.map((entry) => [entry.name, entry]));
/**
 * Look up a catalog entry by package name. Returns the entry or `undefined`
 * when the name is not in the catalog. This is the security-critical gate:
 * route handlers MUST call this and reject with 400 on a miss BEFORE passing
 * the name to any pm command, so a user-supplied string can never be
 * interpolated into an install target.
 */
export function findCatalogEntry(name) {
    return CATALOG_BY_NAME.get(name);
}
/**
 * Resolve a package name to its verified npm install spec
 * (`npm:<name>`), or `null` when the name is not in the catalog. Route
 * handlers use this to obtain the spawn argument without ever building an
 * install target from a raw user string.
 */
export function resolveNpmSpec(name) {
    const entry = CATALOG_BY_NAME.get(name);
    if (!entry || entry.availability === "unreleased")
        return null;
    return entry.npmSpec;
}
/** The immutable list of catalog package names, in display order. */
export function catalogNames() {
    return PACKAGE_CATALOG.map((entry) => entry.name);
}
//# sourceMappingURL=package-catalog.js.map
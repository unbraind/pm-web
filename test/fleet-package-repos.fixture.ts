/**
 * The explicit, checked-in list of every public `unbraind/pm-*` package
 * repository: the fleet roster this catalog is held against.
 *
 * ⚠️ UPDATE THIS LIST WHEN A FLEET PACKAGE IS CREATED.
 *
 * The snapshot-based completeness gate reads `test/fleet-extensions.snapshot.json`,
 * which is generated from the fleet checkouts, and the live-fleet gate reads the
 * sibling directories. Both can only check what their inputs contain, and a
 * generated input can be (and was) regenerated without a package nobody
 * remembered: pm-lint and pm-review sat in the fleet, public on GitHub, while
 * the snapshot predating them kept every CI run green. This list is the
 * hand-maintained backstop. It is deliberately NOT derived from anything — it
 * is the independent roster a new package must be added to by hand, and a
 * companion assertion cross-checks it against the committed snapshot in both
 * directions, so neither list can drift from the other unnoticed.
 *
 * Membership rule: every PUBLIC `unbraind/pm-*` repository. Excluded are
 * `pm-cli` (the CLI itself, not an extension of it), `pm-web` (this package:
 * the host cannot install itself), the private fleet repositories, and the
 * private hosted/website repos. `pm-rust` is included even though it ships no
 * extension manifest — it is catalogued as a native package.
 */
export const FLEET_PACKAGE_REPOS: readonly string[] = [
  "pm-ado",
  "pm-beads",
  "pm-brief",
  "pm-changelog",
  "pm-context",
  "pm-csv",
  "pm-gantt-chart",
  "pm-github",
  "pm-graph",
  "pm-jev",
  "pm-jira",
  "pm-linear",
  "pm-lint",
  "pm-ops",
  "pm-presets",
  "pm-review",
  "pm-rl",
  "pm-rust",
  "pm-slack",
  "pm-slack-standup",
  "pm-starter",
  "pm-todos",
  "pm-ts-starter",
  "pm-vcs",
];
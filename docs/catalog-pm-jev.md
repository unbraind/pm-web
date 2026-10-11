# pm-jev catalog acceptance

This document retains the 2026-10-07 acceptance receipt for pm-web-s99c and
pm-web-cqwm before the later SDK upgrade. Current full-fleet catalog and command
acceptance is documented in [the fleet package catalog](fleet-package-catalog.md).

The baseline built package omitted pm-jev and returned `pm-web-candidate` as an
extension when that directory contained the host manifest. A real scratch
tracker was initialized with the installed CLI and populated with a synthetic
item. The canonical live-fleet catalog assertions passed 8/12 before the fix.

The catalog now mirrors pm-jev's current manifest description and its
`commands`/`schema` capabilities. Verified documentation, repository and
issue links are rendered on its card; the unpublished npm link is omitted. Ollama is the local default; hosted
TypeSafe credentials are optional and require a separate privacy opt-in.
The 2026-10-07 registry lookup returned E404, so `resolveNpmSpec('pm-jev')`
returns null and the card offers no installation. Publication intent remains
separate from registry availability. The snapshot generator recorded 21
extensions, including pm-jev with `publishable: true`, `npmPublished: false`.
The minimum pm host version for pm-jev is 2026.10.5.

Discovery reads every directory's manifest, derives the canonical name, checks
matching package identity and the public repository, excludes pm-web/pm-cli by
identity, and deduplicates equivalent worktrees. HTTPS, npm's git+HTTPS, and Git
SSH repository spellings resolve to the same repository. Conflicting worktree
metadata is reported rather than silently selecting a stale checkout. The
catalog assertions consume the same derivation, including metadata comparisons
for renamed checkouts. The generator still refuses unreadable metadata or
unreachable registry evidence.

The tests use real files and a disposable Git repository with a sibling Git
worktree of an extension package. Built-package acceptance initializes a real
tracker with the actual CLI, reads it with the actual SDK, checks Jev metadata,
links and availability, and proves host discovery leaves tracker settings
unchanged. No SDK mocks or provider calls are involved.

Behavioral revert proof executed the tests with the modules still loading:
removing only the built catalog's Jev entry failed its missing-entry assertion;
restoring only the discovery function's original body failed the filesystem
and built host-exclusion assertions. The final 21-package sibling-worktree
regression also failed its identity assertion with the original discovery body.
Restoring the changes passed all four focused tests and all 12 canonical
live-fleet assertions. The linked pm test commands passed 13/13 for pm-web-s99c
and 4/4 for pm-web-cqwm. Project test-result tracking is disabled, so receipts
are recorded in item comments.

Release preflight found a critical production advisory in locked proxy-addr
2.0.7. The minimal compatible lockfile refresh to 2.0.8 is tracked by
pm-web-6ama; `npm run audit:prod` reports zero production vulnerabilities.

The first full release run encountered eight unrelated fixture failures:
extensionless CommonJS fake CLI scripts inherited an ambient ESM package scope.
An isolated scratch root with an explicit CommonJS scope makes the focused
extension-route suite pass 9/9. Full release validation uses that isolation
without changing fixtures or assertions. Durable fixture hardening remains
open as pm-web-ummd. Nesting that root inside the package causes two more
fixture failures because Node finds pm-ops in the ancestor node_modules during
the omit-dev scenarios. Keep the scratch root outside the checkout:

```bash
catalog_test_tmp="$(mktemp -d -t pm-web-catalog-tests.XXXXXX)"
printf '%s\n' '{"type":"commonjs"}' > "$catalog_test_tmp/package.json"
git init --quiet "$catalog_test_tmp"
export TMPDIR="$catalog_test_tmp"
# Set PM_FLEET_ROOT to the complete fleet directory when checking live metadata.
npm run release:check
bun run release:check
rm -rf "$catalog_test_tmp"
```

The release script retains statements/lines >=90%, branches >=79%, functions
>=92% across its configured `src` inventory, plus zero duplication. It also
checks types, lint, docstrings, production audit, packed-package acceptance,
changelog consistency, and release workflow policy. Bun orchestrates the same
release script, whose coverage runner explicitly invokes Node. Packed
acceptance separately exercises npm and Bun consumers; this is not a claim
that every test executes under native Bun.

Tracker initialization automatically registers merge drivers in the enclosing
Git repository, including for scratch trackers with an explicit pm root.
An isolated scratch Git repository contains those generated attributes. No
pm SDK defect was found in the catalog acceptance; this CLI initialization
side effect is an isolation consideration, and no upstream issue was filed.

Earlier catalog validation passed both complete release gates with the
complete canonical live fleet and external scratch isolation:

| Command | Tests | Statements / lines | Branches | Functions |
| --- | --- | --- | --- | --- |
| `npm run release:check` | 484/484 | 90.25% | 79.57% | 93.90% |
| `bun run release:check` | 484/484 | 90.27% | 79.63% | 93.90% |

Each run reports all 33 configured source files, zero duplication, documented
declarations, and zero production audit vulnerabilities. Both catalog and
discovery services reach 100% in all four coverage dimensions. Each packed
acceptance run passes fresh npm and Bun consumers using the pinned pm host
2026.10.4, with valid `web status` contracts and no deprecated diagnostic.
The packed status is `down`; acceptance does not start or validate a hosted
service. Changelog and release-policy checks pass. A final registry lookup
still returns E404 for pm-jev. The hosted deployment remains outside this
package-only change.

## Round 2: command ownership

Catalog text and package enablement alone do not establish dispatch identity.
The runner now calls `pm package describe --project --json` with the same
binary, environment and tracker as execution. The pinned published CLI
2026.10.10 documents `details.command_ownership` in `docs/EXTENSIONS.md`
(lines 289 and 355); its exported SDK contract is
`dist/sdk/extension/describe.d.ts` (`ExtensionCommandOwnership`). Each exact
command path has handler/override claimants in activation order, one `winner`,
and the `last_activated_wins` policy. The check reads the whole table without
a package-name filter and requires every matching surface's winner to equal
the selected catalog identity. Missing, malformed or failed ownership reads
also refuse execution. HTTP 409 names a conflicting actual owner; ownership
refusals have empty command output.

Ownership inspection and process dispatch share the runner's workspace queue,
so web-managed lifecycle changes cannot interleave between them. Owned calls
use the process runner to preserve extension argument syntax and the same CLI
runtime as the probe. This is a snapshot check: external processes changing
installed packages or executable code are outside the in-process queue.
Runtime inspection activates installed extension modules; it does not invoke
the requested command handler.

The same HTTP acceptance runs against the built and source apps, installing
real npm Presets, then a local TypeScript
package registering `presets list` with a later activation priority. The
fixture requires the dispatch project key during activation, proving that the
ownership probe and execution share their environment. It checks
the published ownership receipt, proves direct CLI dispatch executes the local
handler, clears that synthetic marker, and asserts the web request returns
409 without recreating the marker or changing tracker settings. Disabling the
local package restores normal Presets execution. No SDK mock is involved.

The focused acceptance passes 3/3 with zero skips or cancellations. Restoring
only the previous `runPm` implementation, rebuilding, and selecting the built
collision test produces one assertion failure: HTTP 200 instead of 409, with
`owner: scratch-shadow` in command output. Fixed source bytes are restored and
server output rebuilt after the experiment. The PM-linked acceptance also
passes; project policy disables automatic linked-result persistence, so
verification receipts remain in comments on pm-web-s99c.

Final round-two release validation uses isolated Git identity, canonical fleet
metadata and an external scratch root. Both complete release chains pass:

| Command | Tests | Statements / lines | Branches | Functions |
| --- | --- | --- | --- | --- |
| `npm run release:check` | 499/499 | 90.51% | 80.50% | 93.45% |
| `bun run release:check` | 499/499 | 90.51% | 80.50% | 93.45% |

Both runs have zero skips/cancellations and report all 34 configured source
files at unchanged thresholds. Each passes four packed npm/native-Bun
current/minimum-host scenarios (2026.10.10 and 2026.10.4), production audit
with zero vulnerabilities, type checks, lint, zero duplication, docstrings,
pack dry-run, changelog and release-policy checks. Exact-head CI/review and
external processes changing package code remain separate boundaries.

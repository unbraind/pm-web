# pm-jev catalog acceptance

pm-web-s99c and pm-web-cqwm are implemented together for the public package.

The baseline built package omitted pm-jev and returned `pm-web-candidate` as an
extension when that directory contained the host manifest. A real scratch
tracker was initialized with the installed CLI and populated with a synthetic
item. The canonical live-fleet catalog assertions passed 8/12 before the fix.

The catalog now mirrors pm-jev's current manifest description and its
`commands`/`schema` capabilities. Verified public docs, npm, repository and
issue links are rendered on its card. Ollama is the local default; hosted
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

Both complete release gates passed on the implemented source tree with the
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

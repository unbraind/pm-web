# SDK update automation

Dependabot PR #181 changed the exact standalone SDK from 2026.10.4 to
2026.10.6 while leaving `manifest.json` at 2026.10.4. The packaging test
incorrectly treated a supported extension-host minimum as a duplicate SDK pin.

The standalone server continues to depend on an exact runtime SDK. The manifest
declares the oldest supported extension host separately. Dependency automation
can update the SDK and lockfile without rewriting or generating a manifest.
Packaging rejects missing or ranged versions and an SDK older than that floor.
`accept:packed` reads the shipped manifest and tests npm and native Bun installs
on both the minimum and current hosts. It checks the independently resolved
standalone SDK version and executes the extension's real `web status` handler.
An incompatible future update fails acceptance; changing the floor requires a
deliberate manifest edit and the same acceptance checks.

The candidate pins published SDK 2026.10.9, pm-ops 2026.10.6 and pm-changelog
2026.10.5. The supported extension-host minimum remains 2026.10.4. The behavioral
automation regression simulates dependency-only updates, including a year
rollover, and rejects old SDKs, ranges and malformed floors. Restoring the
original equality assertion makes the regression fail on the real SDK update.
The future-version fixture proves packaging policy, not compatibility with an
unpublished SDK; real packed acceptance remains mandatory for each update.

Package owner: [pm-web-8pml](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-8pml.toon).
Companion session: `../../.agents/pm/tasks/pm-cli-website-session-2026-10-10.toon`
(relative to this package root).

## Independent pending-PR assessment

PR #175 at `d883781d6d134694bedddd65ad37011aa2cbcdea` passes 16 extracted
catalog/discovery tests against the installed published SDK. Canonical identity,
renamed checkouts, duplicate worktrees, conflicting metadata and built-catalog
behavior are covered. The npm registry still returns 404 for pm-jev, consistent
with the proposed unreleased entry. This isolated run does not establish current
live-fleet snapshot fidelity.

PR #176 at `bd233d67c55b8e7b2624143c3048ce628ab78d95` passes 74 extracted
attestation tests, including its real Git/PM/inert-publisher indirection corpus.
The extracted own-repository test initially failed because that scratch source
directory had no tracked publish sources. Running the proposed verifier against
the canonical package passes with one recognized, attested publish. This checks
the supplemental guard with current pm-ops without changing either PR branch.

All available review bodies and inline/issue comments were read, including the
review-body material outside changed lines. The latest CodeRabbit bodies report
no actionable findings. Greptile reports an expired trial, Sourcery reports an
exhausted review budget, and cubic skipped. Recorded Node 22/26 CI is green for
both heads, but GitHub reports both branches as conflicting. Neither PR is
declared safe to merge until conflicts and missing required review evidence are
resolved. No review bot was requested.

## Repair of the release failures

PR182 selectively incorporates the catalog implementation from
[PR175](https://github.com/unbraind/pm-web/pull/175) at
`d883781d6d134694bedddd65ad37011aa2cbcdea` (Git author SteveBot; PM author
codex-sol): canonical discovery, pm-jev
metadata and public links, the existing unreleased install guard, and real
filesystem/Git-worktree/built-SDK regressions. Its tracker records and older
release receipts are not imported. This is the same catalog proposal carried
into the SDK candidate; PR175 remains open and needs reconciliation before
either overlapping branch is merged. The snapshot is regenerated using current
canonical package metadata and registry lookups, rather than copied from PR175.

The four imported catalog regressions fail against the original implementation.
PR175 consolidates eight in-memory discovery cases into three broader real
filesystem/worktree tests; their meaningful membership, unreadable-metadata,
empty-capability, publication-intent, host, non-directory and missing-root
assertions remain covered, with stricter identity/conflict rejection. The added
built-catalog test makes the complete suite 490 tests rather than 494; no source
or coverage threshold is removed.
The broader baseline focused run reports 25/38 pass: the four known catalog
failures, eight fixture module-scope failures, and an additional concurrency
timing failure. After the catalog reuse and explicit `.cjs` executable suffixes,
the catalog/extension/project/runner suites pass 42/42 with zero skips under a
parent package declaring `type: module`. Fixture behavior and HTTP assertions
are retained. The release-file handshake in the SDK/spawn concurrency case
proves the independent real SDK mutation completes while the busy workspace
remains held; it replaces a 400 ms scheduling assumption without changing a
production timeout.

The installed SDK's `GetResult.item` is the selected flat metadata projection;
`PmCompleteListResult.items` is the certified full list. The genuine SDK dispatch
test verifies both shapes, item bodies, positionals, pagination and fail-closed
receipts. No speculative metadata wrappers are introduced. These reads use the
installed 2026.10.9 SDK types and behavior.

The original standalone 2,000-item graph test passes at 6,355 ms for the actual
read (2,022 nodes and 23,063 relationships); its 21,099 ms whole-test duration
includes construction and the reference read. The prior full run failed its
cross-call timestamp tolerance before testing the measured read. Independent
operations now validate `generatedAt` against their actual operation windows.
Payload/order equality, all 2,000 items and the 10,000 ms read limit remain
mandatory; diagnostics report read latency before assertions. The combined
focused run correctly rejected a 10,918 ms read. The installed public SDK light
metadata reader shares the full reader's canonical candidate ordering while
skipping collection hydration. The graph now uses light IDs only for ordering;
all payloads remain certified full rows. The same lock and external-writer guard
remain in place. Focused queued/external-writer and large-corpus checks pass 2/2
with zero skips at 5,586 ms, including real full/light ordering equality.
Coverage files run serially to avoid suite fanout competing with the operation
being timed. Every configured test, source and threshold is retained. These
bounded measurements do not establish production capacity or hosted readiness.

The npm registry's latest braces 3.0.3, micromatch 4.0.8, fast-glob 3.3.3 and
pm-ops 2026.10.6 match the installed chain. No compatible patched release is
available for GHSA-vfj7-8cjw-p6xm. Full development audit remains four high
entries, owned by pm-web-xucb; the proposed audit fix downgrades pm-ops to
2026.9.13. The required duplication tool's optional fast-glob peer remains
installed. No dependency downgrade, audit suppression or gate change is used.

The first repaired full release run passes all 490 tests and its configured
coverage gate, then rejects packed acceptance when npm reports
`Exit handler never called` in `bun-current`. A focused retry reproduces it.
The diagnostic npm log identifies Bun as npm's runtime. Bun's
[documented `--bun` launcher](https://bun.sh/guides/install/from-npm-install-to-bun-install)
adds a recursive `node` alias to `PATH`; this makes the SDK's npm subprocess run
under Bun too. Packed acceptance now resolves the installed package's declared
`pm` binary and executes that file directly with Bun. PM still runs natively
under Bun, and its npm subprocess retains Node. Assertions, scenario count,
SDK version checks and command deadlines are unchanged. Focused packed
acceptance passes all four scenarios on the original npm 11.17.0, Node 24.19.0
and native Bun 1.3.5: both hosts resolve exactly, standalone SDK remains
2026.10.9, and every real `web status` handler returns the expected `down`
contract. This acceptance does not start a service. No upstream installer
or machine tool installation is modified. Isolated npm 11.21 also reproduces;
registry-current npm 12.2/Bun 1.4.2 diagnostic runs were canceled once the cause
was established and provide no accepted receipt.

Repair owners:
[pm-web-s99c](../.agents/pm/issues/pm-web-s99c.toon),
[pm-web-cqwm](../.agents/pm/issues/pm-web-cqwm.toon),
[pm-web-sspv](../.agents/pm/issues/pm-web-sspv.toon),
[pm-web-hqqp](../.agents/pm/issues/pm-web-hqqp.toon), and
[pm-web-xucb](../.agents/pm/issues/pm-web-xucb.toon).
They remain open for independent verification alongside pm-web-8pml and
companion pm-cli-website-session-2026-10-10.

## Final repair receipts

The complete linked release gate passes with Node 24.19.0, npm 11.17.0 and
native Bun 1.3.5. The database is disposable PostgreSQL 17.10, with synthetic
PM workspaces and an external scratch Git root declaring `type: module`.

| Command | Result |
| --- | --- |
| `node scripts/with-test-db.ts node --test test/catalog.test.ts test/catalog-built.test.ts test/fleet-snapshot.test.ts test/extensions-routes.test.ts test/projects-routes.test.ts test/pm-runner.test.ts` | 42/42 pass, zero skips after focused red. |
| `pm test pm-web-s99c --run --only-last --progress` | 16/16 catalog/discovery tests pass. |
| `pm test pm-web-sspv --run --only-last --progress` | 26/26 fixture/route/SDK tests pass. |
| `node scripts/with-test-db.ts node --test --test-name-pattern='large-corpus\|concurrent create' test/graph-export-fidelity.test.ts` | 2/2 pass, zero skips; real full/light ordering and queued/external writer guards; graph read 5,586 ms. |
| `pm test pm-web-hqqp --run --only-last --progress` | Focused 2,000-item graph test passes at 4,639 ms, zero skips. |
| `pm test pm-web-8pml --run --only-last --progress` | Linked `env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm run release:check` exits 0: 490/490 pass, zero skips. |
| `npm run accept:packed` | Four scenarios pass independently and again inside the final full gate, with exact hosts/standalone SDK and real `down` status handlers. |
| `env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm audit --json` | Current-author linked test executes and exits 1 with four high development entries; unresolved pm-web-xucb. Older audit links are untrusted in this branch and are missing evidence. |
| `pm health --strict-exit --json` | Pass; 13 stale-item advisories. |
| `pm validate --json` | Returns `ok: true` with metadata, resolution, file-link and linked-command warnings. |

Final accepted c8 coverage is 90.32% statements, 90.32% lines, 80.17% branches
and 93.43% functions, with all 34 configured server files present. Browser
TypeScript and operational scripts remain outside this denominator; whole-source
coverage stays with pm-web-fy9a. Duplication is zero across 44,952 lines and 155
sources. The final full-gate 2,000-item read is 3,230 ms, returning 2,022 nodes
and 23,063 relationships within the unchanged ten-second limit. These timings
measure bounded operations under the observed host conditions, not capacity.

All six genuine HTTP/SSE/PostgreSQL collaboration tests pass in the final full
suite: concurrent writes, replay/idempotency, graph-failure nonmutation,
watcher/presence behavior and lifecycle records. Production audit reports zero;
full development audit remains four high. Type checks, lint, docstrings,
coverage evidence invalidation/inventory checks, packing, changelog consistency,
release-date derivation and publish attestation all pass. Required final-head
review, historical privacy work, whole-source coverage and hosted readiness
remain separate. No deployment, tenant-data access, publication, bot requests
or owner closure occurs. Claims are released for independent verification.

## Prior baseline validation and limits

The six production collaboration tests pass without skips on a new disposable
PostgreSQL database and synthetic PM workspaces. They exercise real HTTP/SSE,
concurrent writes, idempotent replay, graph failure nonmutation, watcher fanout,
presence access control and the command lifecycle. These bounded tests do not
establish hosted deployment, load capacity or production recovery.

The existing coverage gate measures `src` only. Browser TypeScript and operational
scripts remain outside that denominator; pm-web-fy9a owns whole-source coverage.
Thresholds and source inclusion are unchanged. Strict PM health succeeds with
stale-item advisories; PM validation separately reports existing metadata,
resolution, file-link and linked-test trust warnings. Full development audit
debt remains owned by pm-web-xucb.

| Command | Result |
| --- | --- |
| `node --test test/packaging.test.ts test/sdk-update-automation.test.ts` | 5/5 pass, zero skips; restoring the original packaging assertion fails the new regression. |
| `pm test pm-web-8pml --run --only-last --progress` | Linked automation test passes 1/1. |
| `node scripts/with-test-db.ts node --test test/pm-collaboration.test.ts` | 6/6 pass, zero skips, with the externally supplied disposable database URL. |
| `npm run release:check` | Exit 1 at coverage: 481/494 pass, 13 fail, zero skips. |
| `npm run accept:packed` | Four scenarios pass: npm and native Bun, each on hosts 2026.10.4 and 2026.10.9, with independently resolved standalone SDK 2026.10.9. |
| `npm run audit:prod` | Pass, zero vulnerabilities. Full development audit has four high findings. |
| `npm run pack:dry-run` | Pass; build output remains identical to committed `dist`. |
| `npm run changelog:full` and `npm run changelog:check` | Regenerated bytes are unchanged; check passes. |
| `npm run verify:release-changelog-date` and `npm run verify:release-publish-attestation` | Both pass. |

The failed release run's raw c8 totals are 90.04% statements, 90.04% lines,
79.50% branches and 92.33% functions across 34 server source files. All configured
numerical thresholds are met, but failed tests reject the measurement and remove
the canonical reports. These figures are diagnostic evidence, not an accepted
coverage receipt or all-source coverage.

Four failures belong to catalog/snapshot work (pm-web-s99c and pm-web-cqwm).
Eight failures reproduce the extensionless synthetic CLI module-scope defect
(pm-web-sspv). The large graph case fails the 30-second generated-time parity
tolerance before reaching its 10-second read-budget assertion (pm-web-hqqp).
Its 118193 ms whole-test duration includes fixture generation and must not be
reported as measured graph-read latency. All assertions remain intact.

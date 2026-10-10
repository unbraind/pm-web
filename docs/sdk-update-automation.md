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

## PR #182 unpublished npm link repair

[CodeRabbit inline 4236357377](https://github.com/unbraind/pm-web/pull/182#discussion_r4236357377)
is valid at base `4ff3ec41fff7ea4e25d3155978f1bdf4bdc7ca9e`: Jev is
`unreleased`, its committed registry receipt is `npmPublished: false`, and a
fresh registry request returns HTTP 404. Its explicit npm URL nevertheless
renders because the Packages card enumerates every supplied link.

The server catalog and browser row contracts now make only `npm` optional.
Jev omits that property and retains documentation, repository and issue links.
The existing renderer is exported so tests can execute the production card
function without substituting browser dependencies. Published package links
still render. No SDK/dependency pin, application deadline, coverage threshold,
source inventory or telemetry setup changes.

`test/catalog-ui.test.ts` uses the real Jev entry and committed registry receipt.
Its published control combines the real Graph entry with the installed
published Graph package's own catalog links. Neither test mocks modules,
network calls, DOM or database behavior. The snapshot assertion also rejects
any npm link on an entry whose registry receipt says unpublished; the built
catalog test requires Jev's exact remaining links. Each of the four existing
packed scenarios additionally imports the installed catalog and browser card
using its actual Node or native Bun runtime and checks rendered Jev links.
All original host, standalone SDK, status, port and diagnostic checks remain.

| Command or control | Result |
| --- | --- |
| `node --test test/catalog-ui.test.ts` before the catalog repair | 1/2 pass; Jev fails because the npm URL is present; published Graph passes. |
| Restore only `src/services/package-catalog.ts` from base and run the same UI test | Exit 1, 1/2 pass; actual card HTML contains the forbidden npm anchor. Candidate source bytes are restored afterward. |
| `node --test test/catalog.test.ts test/catalog-built.test.ts test/catalog-ui.test.ts` | 15/15 pass, zero skips. |
| `pm test pm-web-s99c --run --only-last --progress` with the focused command linked | 15/15 pass, zero skips. |
| `npm run build`, `npm run typecheck`, `npm run build:test`, `npm run lint` | Pass; generated server catalog JS, declaration and map match the source repair. |
| `npm run duplication` and `npm run docstring` | Pass: zero duplicate lines across 45,021 lines and 156 sources; 95 files and 625 declarations documented. |
| `pm test pm-web-s99c --run --only-last --progress` with `npm run accept:packed` linked | All four npm/native-Bun current/minimum-host scenarios pass, including installed catalog/card assertions. Hosts are 2026.10.9/2026.10.4; standalone SDK is 2026.10.9 throughout; all real status handlers return `down` on the expected ports without deprecated diagnostics. |
| `pm test pm-web-hqqp --run --only-last --progress` | Existing focused graph check passes 1/1, zero skips; 2,000-item read is 4,495 ms. |
| Final `npm run coverage` with the disposable database and canonical fleet environment | Exit 0; 492/492 tests, zero skips; all 34 configured server files reported and thresholds met. Instrumented 2,000-item read is 3,257 ms. |

The initial linked `npm run coverage` invocation hits the PM runner's default
120-second budget and exits with a timeout, so it supplies no accepted coverage
evidence. The same coverage command is rerun directly against the newly created
disposable PostgreSQL 17.10 fixture. Application test deadlines remain unchanged.
The first complete direct run is 491/492, zero skips, and exits 1 solely on the
unchanged ten-second graph assertion: 15,811 ms, 2,022 nodes and 23,063 edges.
Its raw c8 totals are S/L 90.38%, B 80.25%, F 93.43% across the configured
34 server files. These are rejected diagnostic figures; canonical reports are
removed. The focused graph success does not accept that failed coverage run.
Only coverage is repeated afterward, without packed-installation overlap.

The final accepted report is 90.32% statements/lines, 80.18% branches and
93.43% functions. Statements and lines are 10,321/11,426, leaving 1,105
uncovered reporter counters each; branches are 1,768/2,205, leaving 437;
functions are 256/274, leaving 18. Browser TypeScript and operational scripts
remain outside the configured 34-server-file denominator. This is not all-source
100% coverage. The base receipt at `4ff3ec` was S/L 90.32%, B 80.17%, F 93.43%
with the same file count. All six genuine HTTP/SSE/PostgreSQL collaboration
tests pass in the final suite. The earlier full-suite timing failure remains a
separate measurement under pm-web-hqqp; final success does not erase it.

Source/test/package/distribution SHA-256 is
`fb5c50fef054e353db7e15434dc715226c60658e8defa71b4dd1597cd371648f`.
It hashes each sorted repository-relative path, NUL, file bytes, NUL for 285
tracked paths under `src`, `public`, `scripts`, `test`, `dist`, plus
`package.json`, `package-lock.json`, `manifest.json`, `tsconfig.json`,
`tsconfig.test.json`, `README.md` and `CHANGELOG.md`. The new UI test is included;
PM metadata and this receipt document are outside the fingerprint. Source bytes
remain identical through all checks and the negative-control restoration.

| Receipt | SHA-256 |
| --- | --- |
| Initial red UI run | `76359f2afd1231110b64763abebd461f04a2b59c285379a0ec6337dfcb19d0c6` |
| Source revert UI failure | `5d82c3fc1d5d0fa83f55a2094ff71601f2102cf937a02b2746accaa1ab583f10` |
| Focused direct green | `b09c1c0533ee8762abb4fe1a8c6b6d71a365c929450bf56848dd8d3c36200d44` |
| Focused linked green | `1e26b5b6061a246e466dba01fa65decc10b68bc743ca9f2df16acb8e0343f1ff` |
| Four-scenario packed linked green | `4b5fbfccd47bd6ab85ed09a77d6b0dd6e9a0bb1902440cc25fe272571ed84b68` |
| First complete, rejected coverage run | `356ea1b5031537b71ef8b8869d9a9dc6fd1e4f694d9f00cf4e4918a043c79f78` |
| Focused graph linked green | `e6948a8eae234f0ca45fd70fbd4a89348f00f12d755e610a4dd3d9e3d9e8e622` |
| Final accepted coverage run | `d36dded13b679d0bd053becfe608b1d558fde9105d85e09ad9c5afff766a21da` |
| Accepted LCOV | `bed3f41e85781ce5ae356f36e51acaea989d56ab2b9f58b4a63ea39e7189dbf8` |
| Accepted coverage summary | `9e7dac5def722b4e45e06b076b93516f0e4afaad35d773f42770d5eb1b837998` |

Owner [pm-web-s99c](../.agents/pm/issues/pm-web-s99c.toon) retains the evidence.
Feature owner pm-web-8pml, whole-source quality owner pm-web-fy9a, existing sync
owners and companion crosslink owner pm-cli-website-session-2026-10-10 remain
open. Required exact-head reviews, historical privacy work, development audit
debt and hosted readiness are separate gates. No bot replies, PR description
edits, merge, publication or deployment are part of this repair.
Claims on pm-web-s99c, pm-web-hqqp and pm-web-8pml are released without closing.
`pm history <id> --verify --strict-exit --json` passes for all three items with
current hashes matching their latest history entries. The disposable database
and packed fixtures are removed after verification.

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

## PR #182 directory enumeration review correction

CodeRabbit finding 4236540807 is valid: the conflict assertion selected the
metadata from the directory named `first`, although discovery accepts the first
record the filesystem enumerates. The existing real-filesystem case now swaps
both records between `first` and `second` and requires exactly one complete
retained record from those two valid alternatives plus the conflict diagnostic.
The scanner's ordering and production source are unchanged.

Keeping the original assertion while swapping the records fails with the
`conflict` record retained. The corrected complete fleet-snapshot file passes
3/3 with zero skips, including a real sibling Git worktree and its nested catalog
assertions. Test typechecking and lint pass. The earlier 492-test coverage and
four packed receipts belong to `af430dd`, before this test-only correction;
production and distribution bytes remain identical. Renewed exact-head review
and CI remain required, and the whole-source quality and deployment gaps stay
open.

## PR #182 deterministic discovery follow-up

Renewed review 5477988575, against `97de322`, confirms that the first retained
conflicting record depended on filesystem enumeration. Discovery now sorts
directory entries by string name with locale-independent lexicographic
comparison before the existing loop. Installed Node declarations define the
default `withFileTypes: true` result as `Dirent<string>[]`; buffer names require
an explicit buffer encoding. Candidate metadata and conflict refusal are
unchanged.

The existing real-filesystem test swaps the same incomplete and conflicting
records between `first` and `second`. It now requires the exact complete record
from `first` and the exact conflict diagnostic for `second`, alongside every
malformed-metadata diagnostic. It uses real filesystem calls, with no mocked
enumeration or read counts and no duplicate test.

The tightened test passes 3/3 on the old production source on this host, whose
enumeration already selects `first`. This is a cross-platform contract
correction, without a claimed fail-on-revert result. The corrected linked test
also passes 3/3, zero skips; source/browser and test typechecks and lint pass.
The production change makes the `af430dd` 492-test and four packed receipts
historical. New full-gate and packed receipts are required for this candidate.

The new complete gate passes on the corrected source, using Node 24.19.0,
npm 11.17.0, native Bun 1.3.5 and an own disposable PostgreSQL 17.10 database.
The shared heavy-gate lock serializes this run; canonical fleet metadata is
read without modifying sibling packages. The database is stopped and removed.

| Command / measurement | Current candidate result |
| --- | --- |
| `pm test pm-web-s99c --run --only-last --progress` | Existing discovery file 3/3, zero skips. |
| `npm run typecheck` and `npm run build:test` | Source, browser and test typechecks pass. |
| `pm test pm-web-8pml --run --only-last --progress` | Linked `env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm run release:check` exits 0; 492/492 tests, zero skips. |
| Configured server coverage | All 34 `src` files reported: statements/lines 90.33% (10325/11430), branches 80.10% (1768/2207), functions 93.43% (256/274). Remaining counters: 1105, 439, 18. Browser/tooling are excluded from this denominator. |
| Real graph corpus within the full suite | 2,000 items read in 4,748 ms; 2,022 nodes and 23,063 edges. Existing timing limits remain intact. |
| Real collaboration within the full suite | All six HTTP/SSE, concurrent edit, keyed replay, nonmutation, watcher/presence and lifecycle cases pass against the disposable database. |
| Quality / release checks within the full gate | Lint passes; duplication 0% over 45,033 lines / 156 sources; 95 files / 625 declarations documented; production audit 0 vulnerabilities; package, changelog, release date and publish attestation pass. |
| `npm run accept:packed` within the full gate | All four fresh installed-tarball scenarios pass, including existing catalog/card contracts and no deprecated diagnostics. |

| Packed scenario | Host version | Standalone SDK | Status / port |
| --- | --- | --- | --- |
| npm-current | 2026.10.9 | 2026.10.9 | down / 61113 |
| bun-current | 2026.10.9 | 2026.10.9 | down / 61114 |
| npm-minimum | 2026.10.4 | 2026.10.9 | down / 61115 |
| bun-minimum | 2026.10.4 | 2026.10.9 | down / 61116 |

The source/test/package/distribution fingerprint is
`6f02e7d92d3b78c1e68e284f3b78d7983ed4c45889693573e3fa26102f6ec7a8`
over 283 sorted tracked paths: `src`, `public`, `scripts`, `test`, `dist`,
package/lock/manifest and server/test compiler configuration, using path NUL
bytes NUL. It is unchanged after the full gate. These packed status checks do
not certify service startup or deployment.

Strict pinned PM health separately fails local extension-host skew:
SDK 2026.10.9 versus managed pm-github 2026.10.10, with 13 stale-item advisories.
PM validation reports `ok:true` with existing warnings. Both owner history chains
verify with current hashes matching their latest entries. No extension or tool
pin is changed by this correction. Development audit four-high debt,
whole-source coverage, review, historical privacy, graph/concurrency and hosted
readiness gates remain open. The hosted SDK 4 deployment is unchanged; this
candidate must not be deployed. Owners pm-web-s99c and pm-web-8pml remain open
for the orchestrator; release their claims at handoff, with no review messages,
PR body changes, merge, publication or deployment.

| Receipt | SHA-256 |
| --- | --- |
| Complete decoded linked release output | `fc540f551a869bdf7ea471ebbed29e65736dcd1d635fd195a8dabe5f3fbb8bb7` |
| Four-scenario packed receipt JSON | `8a8342a44093833d1e70edc0aeb59bd46c94bcc622c573acb75a4ebff3a1eae9` |
| Accepted coverage summary | `cb0e3a546c773eeeb566d8ccf60d6fdc91f0252f8b47adb9fdadcc1c2bd52c83` |

## Published SDK 2026.10.10 renewal

This dependency-only renewal starts at `f85d3d03740b783d0397e35fc6402862d97a3e0d`
on the existing PR #182 branch. The exact runtime and development host SDK now
resolves published `@unbrained/pm-cli` 2026.10.10. Only the SDK dependency pin and
its lockfile version, registry URL and integrity change. Installed public
`GetResult`, certified complete-list and light metadata declarations, and Node
filesystem/module declarations, remain compatible with the existing strict
TypeScript consumer. Source, tests and generated distribution bytes are unchanged.
No new test or dependency-only source-revert claim is introduced.

The package and manifest version remain 2026.10.9; the independently tested
minimum extension host remains 2026.10.4. Registry checks confirm the existing
pm-ops 2026.10.6 and pm-changelog 2026.10.5 pins remain current. pm-graph remains
2026.10.5. Node 24.19.0, npm 11.17.0 and native Bun 1.3.5 run the checks.

The first renewed linked release passes in 407.479 seconds, retaining the
original 1800-second limit; its complete suite takes 247.244 seconds. The older
2400-second release link also remains unchanged. All runs explicitly select the
canonical fleet, never the synthetic tracker sandbox as fleet inventory. Heavy
checks share the existing flock. A new disposable native PostgreSQL 17.10
cluster supplies the existing schema/HTTP/SSE helpers and is stopped and removed.
No Docker, hosted service, tenant data or telemetry resource is changed.

| Existing command / measurement | First renewed result |
| --- | --- |
| Reproducible `npm ci`, `npm run typecheck`, `npm run build:test` | Pass; installed SDK 2026.10.10. |
| `pm test pm-web-8pml --run --only-index 7 --progress --json` | Complete unchanged release: 492/492, zero skips, exit 0. |
| `pm test pm-web-8pml --run --only-index 8 --progress --json` | Six real disposable PostgreSQL collaboration cases pass, zero skips. |
| `pm test pm-web-8pml --run --only-index 9 --progress --json` | Six existing graph/observational cases pass, zero skips; 2000-item read 2489 ms, 2022 nodes, 23063 edges. |
| `pm test pm-web-8pml --run --only-index 6 --progress --json` | Existing packaging/SDK automation assertions 5/5, zero skips. |
| Production audit in the unchanged release | Zero vulnerabilities. |
| `pm test pm-web-8pml --run --only-index 10 --progress --json` | Genuine full-development audit exits 1: four high entries, braces/fast-glob/micromatch/pm-ops; existing pm-web-xucb stays open. |
| Strict pinned PM health with required merge drivers | Pass; 13 stale-item advisories. |
| PM validation | `ok: true` with existing metadata, link, resolution and linked-test warnings. |

The configured c8 denominator remains all 34 server files under `src`:
statements/lines 10325/11430 (90.33%), branches 1768/2207 (80.10%), functions
256/274 (93.43%). Uncovered counters are 1105 statements/lines, 439 branches
and 18 functions. Thresholds remain S/L 90, B 79, F 92, with no ignore entries.
Browser and tooling source is excluded from this denominator, so coverage is
PARTIAL. Docstrings cover the analyzer's selected 95 files / 625 declarations,
excluding tests, installed packages and compiled output; this is not whole-source
or whole-documentation certification. Duplication remains zero over 45033 lines /
156 sources, with zero clone pairs and the unchanged zero threshold.

All four fresh packed npm/Node and native-Bun scenarios pass on hosts 2026.10.4
and 2026.10.10. Each independently resolves standalone SDK 2026.10.10, preserves
its original status/port/config assertions, and exercises installed catalog/card
contracts. Status is `down` at ports 61113–61116; these receipts do not establish
service startup or hosted readiness. The full-suite 2000-item graph read is
2429 ms within its unchanged 10000 ms limit. Collaboration and graph checks are
bounded synthetic measurements, without production capacity or recovery claims.

Only owner pm-web-8pml is touched by unique author `codex-sol-8pml-20261010`.
All 152 previous history-file prefixes, including its original 98 events, are
preserved. Eleven relevant owner chains verify strictly with matching current
item hashes. The own claim is released without closing before changelog
regeneration and source freeze. Previous timeout, catalog/fixture, native npm
launcher and graph timing failures remain above as dated receipts. Historical
revert proofs are not reused as proof of this dependency-only renewal.

The committed [inventory](sdk-renewal-2026.10.10-inventory.json) records frozen
relative paths, Git blob SHA-1 and byte SHA-256. The separate
[final receipt](sdk-renewal-2026.10.10-receipts.md) records exact source commit,
renewed exact-tree gates, archive identity and evidence freshness. Whole-source,
whole-docs, development-audit, privacy, scale, review and hosted boundaries remain
open. No deployment, merge, publication, review request or PR-description edit
belongs to this renewal.

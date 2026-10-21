# Ordinary presence join storms: 2026-10-21

**The 3000-subscriber goal is not reached.** The measured sixteen-slot candidate kept all
1247 observed readiness probes healthy, but connection admission still exceeds
the unchanged 15-second client deadline below 3000. The largest completed cohort
is **2500 subscribers** in the burst-100 run. This is an observed readiness and
admission stopping point, not certification of a complete 2500-person roster or
of 3000-user collaboration. No measured mutation workload starts in these burst
experiments, and none reaches the final 3000-person roster barrier.

The [aggregate evidence](2026-10-21-joinstorm-numbers.json) retains failed and
inconclusive attempts, intermediate eight-slot admission, final sixteen-slot
admission, resource samples and runtime SHA-256 hashes. Baseline runtime is main
at `87b1dc2`. Its built SSE modules were verified byte-for-byte against that
commit before candidate builds. The registry CLI version was 2026.10.21;
tracker writes and synthetic CLI operations use the unchanged package pin,
2026.10.19.

The campaign hashes identify the measured build. The initial release-verification
build subsequently received equivalent lint fixes to the admission loop and the fan-out promise
callback; the completed campaign was not rerun after those spelling changes.
The initial release gates and restored regression tests ran against that source.
The evidence's `release_verification_runtime` entry records that source revision
and its compiled module hashes separately from the campaign hashes.
The subsequent PR #234 review fix limits authorization-failure cleanup to
unprocessed snapshot viewers. Neither this fix nor the earlier lint changes
were part of the measured campaign; its capacity results remain historical.

## Measured stopping points

All final runs use four independent reader workers, one production process,
distinct authenticated synthetic users, a plain-directory tracker and the real
disposable PostgreSQL fixture. Cohorts contain 100, 500 or 1000 simultaneous
connection attempts. Earlier sockets remain open. The next cohort begins after
the current connected frames and a 100 ms pause, without waiting for presence.
No quiet-setup interception is used. Final roster wait is 45 seconds; readiness
has a two-second client deadline and retains the production dependency cache.

| Runtime | Burst | Opened | Last complete cohort | Readiness failures/samples | Ready p99 / max ms | Server loop p99 ms | Peak RSS MiB | Stop |
|:---|---:|---:|---:|:---|:---|---:|---:|:---|
| Before, first four-worker attempt | 100 | 552 | 500 | 5/74 | 2127.5 / 2127.5 | 665.8 | 205.4 | connection deadline |
| Before, repeated campaign | 500 | 0 | none | unavailable | unavailable | unavailable | unavailable | server startup deadline |
| Before, repeated campaign | 1000 | 1 | none | 3/42 | 2009.4 / 2009.4 | 214.0 | 177.0 | project verification HTTP 500 |
| Final | 100 | 2500 | 2500 | 0/819 | 349.5 / 1766.1 | 155.1 | 325.9 | connection deadline |
| Final | 500 | 1850 | 1500 | 0/217 | 345.7 / 559.0 | 153.7 | 338.1 | connection deadline |
| Final | 1000 | 1813 | 1000 | 0/211 | 309.6 / 1024.0 | 109.4 | 312.5 | connection deadline |

These are separate busy-host observations, not a controlled percentage speedup.
The host has four logical CPUs. Final one-minute load averages were
45.53 → 58.77, 62.39 → 70.98 and 66.37 → 67.30 respectively. Population differs
between memory samples. No final reader disconnections were observed; incomplete
admission and missing final rosters still make every final run fail.

The first exploratory driver allocated fresh reader workers per cohort. It
opened 1397 sockets in burst-100 with 41 failed readiness samples, and reached
3000 in burst-500 with 108 failed samples. Those attempts are retained but are
not the four-worker comparison. The first four-worker result survived only in
stdout because a subsequent fixture initialization exceeded its deadline; its
summary is explicitly labeled in the evidence. A later resource-capture failure
is retained as inconclusive. The corrected driver saves each finished attempt
immediately and retains capture and cleanup failures separately.

Eight-slot admission kept readiness healthy for the 500/1000 bursts but timed
out at 2435/945 opened sockets; burst-100 opened 2075 and had one readiness
timeout. Sixteen slots use more of the existing pool while reserving four slots
at its default size. The noisy observations do not establish the optimal slot
count. Remaining connection deadlines need a quieter repeat and further setup
profiling; increasing the deadline is not evidence of meeting the current goal.

## Bounded work

Initial connection requests previously entered the shared SQL pool without an
admission bound. A large cohort could queue access/profile reads ahead of
readiness. The final code admits at most sixteen initializations, reduced for
smaller configured pools, and bounds waiting callbacks at 4096. Queued socket
closure cancels admission; overload returns 503 with a one-second retry hint.
Every admitted subscriber retains the original access, profile and resume checks.
The baseline verification error identifies its route phase; its underlying SQL
error category was not traced, so that observation alone cannot identify every
cause of the historical failures.

Presence scheduling now takes constant work per join, leave or view update and
coalesces into a fixed one-second window. Continuous joining cannot keep resetting
a trailing debounce forever. Roster construction and pending-snapshot assignment
remain linear per project window. A complete roster delivered to every viewer
still has quadratic total network bytes; this protocol is unchanged. It is
coalesced across joins and sent in bounded socket slices.

Fan-out processes at most 32 viewers before yielding and performs a fresh
membership read for each slice. A finite viewer snapshot bounds each pass even
during continuous new arrivals. Shared replay-position batches remain shared
across slices, keyed by both cursor and captured sequence. Each slice captures
event and registration boundaries before its authorization read. The final
probe observes a maximum of 32 synchronous response writes in all three runs.
The replay journal, deduplication, queue byte/batch bounds and stall deadlines
from PR #231 are unchanged.

## Regression and reproduction

The production-process regression uses 128 real authenticated sockets, a fresh
plain tracker, a server PATH containing only Node, and no setup interception.
It checks that a lone join does not immediately broadcast a full roster, every
socket receives the complete final roster, readiness succeeds, and the process
probe observes bounded response-write slices. A real HTTP admission test covers
active/backlog limits, cancellation, idempotent release and readiness while
initializations are held. Response-boundary tests cover membership revocation
between yielded slices and preserve shared frames, ordering and replay bounds.

Three isolated behavioral reverts fail as required: restoring only the old
presence scheduler fails the production-process test on an early one-person
roster; restoring only the old fan-out flush fails its bounded-write assertion;
disabling only the admission limit fails the real HTTP test with four active
initializations against a two-slot limit. All sources were restored after each
proof, rebuilt, and the PM-linked checks passed 40/40 plus 1/1 with no skips or
cancellations. Automatic PM test-result tracking is disabled in this project;
the item comment records these results without raw execution contexts.

```sh
npm run build
node scripts/with-test-db.ts node scripts/capacity-joinstorm.ts "$CAPACITY_OUTPUT"
node scripts/with-test-db.ts node --test test/presence-joinstorm.test.ts test/sse-admission.test.ts test/sse-fanout.test.ts test/sse.test.ts test/realtime-delivery.test.ts test/realtime-recovery.test.ts
```

PM: [pm-web-jstr](../../.agents/pm/issues/pm-web-jstr.toon). The item remains in
progress. The requested historical reference `pm-web-8kqg` is absent from this
tracker; capacity context comes from `pm-web-lh4b`, `pm-web-h4vh` and PR #231.

## Initial release verification

Both release commands use an isolated HOME and Git identity, with npm user
configuration disabled. Coverage thresholds and exclusions are unchanged.

`npm run release:check` exits **1** at coverage: **761 tests, 758 passed, two
failed, one canceled, zero skipped**. The built catalog-install test reaches its
unchanged 300-second deadline; the following source catalog test reports
`stateError: spawn ENOTDIR` on the initial listing. The large-corpus graph test
reports **11467 ms wall / 3000 ms CPU**, exceeding its unchanged 10000 ms wall
budget (7028 involuntary context switches; 2022 nodes and 23063 edges). These
failures are retained and linked to existing investigations
[pm-web-qdhx](../../.agents/pm/issues/pm-web-qdhx.toon) and
[pm-web-hqqp](../../.agents/pm/issues/pm-web-hqqp.toon); no causal baseline proof
was made for them in this task.

The new real-process join regression, admission test and fan-out/SSE regressions
pass in the full npm run. Aggregate coverage is statements/lines **92.10%**,
branches **82.47%**, functions **95.97%**, above the respective existing
92.07/80.5/94.59 thresholds. Failed tests still make the release gate fail;
subsequent capacity, audit, pack and changelog stages do not execute in that
command chain. Type checking, lint, zero duplication and docstrings pass.

`bun run release:check` also exits **1** at coverage: **761 tests, 756 passed,
four failed, one canceled, zero skipped**. The built catalog case again reaches
the 300-second deadline. The source catalog case returns `spawn ENOTDIR` where
an inactive-package refusal was expected. The graph read reports **13451 ms wall
/ 3269 ms CPU** (8037 involuntary context switches), exceeding the same budget.
The spawn-runner test misses its independent-workspace overlap assertion. Those
receipts enrich the existing timing investigations above.

The additional graph-provisioning failure returns HTTP **424** after a
**30000 ms command timeout** during activation. Both concurrent POSTs return
that failure after roughly 140 seconds overall. It is linked to existing
[pm-web-jpa6](../../.agents/pm/issues/pm-web-jpa6.toon); observational GET/HEAD
tests still pass. The provisioning test passed under the full npm gate, and no
causal baseline investigation was performed here.

The new real-process regression and admission/fan-out/SSE checks pass under
both full gates. The release commands remain red, and neither command reaches
its later release stages. No source or test code changed between these gates.
Bun aggregate coverage is statements/lines **92.36%**, branches **82.24%** and
functions **95.97%**; every existing threshold is retained.

## PR #234 review verification

Thread `PRRT_kwDOSZgR5c6uqz62` identified overbroad disconnection after a
later slice's membership read fails. Cleanup now detaches only the current and
remaining snapshot viewers. Earlier authorized slices and post-snapshot joins
stay connected and require fresh authorization for subsequent private events.
The review refresh found no additional unresolved threads or outside-diff findings.

Two new 96-viewer regressions cover failures in slices two and three, including
listener cleanup, no delivery to failed viewers, late joins and ordered recovery.
Restoring only the pre-review `flushFanout` makes both fail: 97 viewers close
instead of the expected 64 or 32. The fixed source was restored byte-for-byte;
the fan-out file passes 21/21. PM-linked production-process, fan-out, SSE delivery
and recovery checks pass 42/42, with admission separately passing 1/1.

Both full commands ran with isolated HOME/Git identity and unchanged thresholds.
Neither full command passed: each stopped at coverage despite exceeding every
coverage threshold. All changed regressions passed in both runs.

| Command | Passed / total | Failed / canceled / skipped | Statements and lines | Branches | Functions |
| --- | ---: | ---: | ---: | ---: | ---: |
| `npm run release:check` | 761 / 763 | 1 / 1 / 0 | 92.31% | 82.24% | 95.97% |
| `bun run release:check` | 760 / 763 | 2 / 1 / 0 | 92.34% | 82.41% | 95.68% |

Both runs hit the existing built catalog's 300-second deadline, followed by
`spawn ENOTDIR` in the source catalog case. An interrupted earlier attempt on
the fixed code passed the built case in 242.4 seconds; a subsequent isolated
catalog-file retry still passes only 1/3, with one failure and one cancellation.
These gaps remain tracked in [pm-web-qdhx](../../.agents/pm/issues/pm-web-qdhx.toon).
Bun also misses the independent-workspace spawn-overlap assertion; that check
passes in the full npm run and in its isolated 1/1 retry.

The unchanged 2000-item graph budget passes in both full runs: 8868 ms under npm
and 6589 ms under Bun, against 10000 ms. Graph provisioning also passes in both.
The later release stages were run independently because the full command chains
stopped at coverage: capacity acceptance passes 2/2 and the production audit finds
zero vulnerabilities. Package dry-run and packed consumer acceptance pass,
including all four npm/native-Bun current/minimum-host scenarios. Changelog,
release-date and publish-attestation checks pass. This review does not repeat the
join-storm campaign or certify the unmet 3000-subscriber target.

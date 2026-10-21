# Ordinary presence join storms: 2026-10-21

**The 3000-subscriber goal is not reached.** The final implementation keeps all
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
commit before candidate builds. The installed registry CLI was 2026.10.21;
tracker writes and synthetic CLI operations use the unchanged package pin,
2026.10.19.

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

```sh
npm run build
node scripts/with-test-db.ts node scripts/capacity-joinstorm.ts "$CAPACITY_OUTPUT"
node scripts/with-test-db.ts node --test test/presence-joinstorm.test.ts test/sse-admission.test.ts test/sse-fanout.test.ts test/sse.test.ts test/realtime-delivery.test.ts test/realtime-recovery.test.ts
```

PM: [pm-web-jstr](../../.agents/pm/issues/pm-web-jstr.toon). The item remains in
progress. The requested historical reference `pm-web-8kqg` is absent from this
tracker; capacity context comes from `pm-web-lh4b`, `pm-web-h4vh` and PR #231.

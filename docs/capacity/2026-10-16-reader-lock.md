# Reader-lock mitigation: 2026-10-16

Related feature: `pm-web-bazs`; investigation: `pm-web-h4vh`; upstream SDK issue: [pm-cli#1485](https://github.com/unbraind/pm-cli/issues/1485).

PR #211 was still open at branch creation. This change is based on `perf/realtime-delivery-p99` at `e4c3c0639faf0d5bf03e42b3e8ca2753cb0c486c`, reusing its opt-in stage probes. The pinned SDK stays at 2026.10.15. Only the public package and synthetic disposable test resources were used.

## What changes

The premise that every viewer creates a poller was incorrect: the existing reconciler already shares one mutation subscription per active project. That subscription nevertheless takes the exclusive SDK index lock on every idle 250 ms poll. Viewer count can affect fan-out and scheduling, but does not multiply this project's polling loops. Different active projects and different server processes still have independent loops.

The pinned public SDK mutation-event API has no cheap history generation marker. Before entering `listMutationEvents`, the follower now enumerates authoritative history stream names and stats each stream plus the optional runtime SQLite index and WAL. The exact token retains size, nanosecond mtime and ctime, device and inode, without rounding or a lossy aggregate hash. Missing files have explicit tokens. Non-missing filesystem errors propagate and trigger ordinary watcher recovery rather than certifying unchanged history. This is metadata I/O proportional to history stream count, once per project poll, without taking an index lock. Large-project metadata cost is unmeasured.

Unchanged polls skip SDK reads. Validated peer NOTIFY and local HTTP broadcasts invalidate active project gates, requiring a read on the next poll. Invalidations received during a read survive its completion. Identical concurrent SDK page requests share one in-flight promise per tracker and query; settled pages are never cached, and different filters/boundaries retain independent results. The existing one-loop-per-project reconciliation remains the main viewer coalescing mechanism. This does not coalesce independent server processes or arbitrary different queries.

A full SDK scan is due every five seconds even if all metadata aliases. Thus steady idle pressure is approximately 0.2 acquisitions/sec per active project, rather than zero forever. Metadata changes normally retain the ordinary 250 ms detection cadence. The SDK still owns pagination, index validation/rebuild and authoritative fallback; the package never treats the derived index as authoritative.

A skipped poll must not advance the replay floor. Each admitted scan starts at the previous completed scan's start minus the original 60-second window (clamped to attachment time), and prunes receipts only at that boundary. A fact that became visible within the original visibility window remains eligible at the next safety scan even if its timestamp is now older than 60 seconds. Scans are certified only after all pages are consumed. Errors or interrupted consumption retain the previous successful boundary. With ordinary scheduling, receipt retention can extend by the five-second check interval plus polling/read delay; the hard 10000-fact cap still reports overflow rather than evicting receipts silently. Scheduling delays have no finite wall-clock bound.

Subscriber authorization, session handling, project membership, event shapes, local delivery deduplication, the 15-second filesystem safety sweep and LISTEN/NOTIFY transport policy are unchanged. Signal callbacks exist only for active subscriptions and are removed when their loops stop.

## Measurement method and limits

The same test-only acquisition counter and stage tracing are used before and after. The counter observes successful index-lock payload writes, not failed lock attempts. After the production 15-second filesystem baseline, 100 authenticated viewers remain connected for a 12-second zero-writer interval. Its server index-lock delta divided by server monotonic elapsed time measures idle reader acquisitions. Initial attachment/rebuild is outside that interval. Each run then performs the original ten concurrent lanes (five HTTP SDK and five separate pinned CLI processes), five independent item updates per lane, 50 writes and 5000 expected receipts. Drain is four seconds and SLO is 2000 ms. No competing measurement or gate from this task ran during a measured workload.

The host has four logical CPUs. It could not be made quiet without interfering with unrelated work; short samples showed material CPU/I/O pressure and recorded load exceeded CPU count. These are shared-host observations, **not the requested quiet-host capacity certification**. Matched instrumentation permits comparing the observed mechanism, but varying host pressure and tracing prevent a causal end-to-end speedup claim. The probe's CLI lock wait is a lower bound including retries/I/O/scheduling; it is nested in pre-append time. HTTP index-lock wait is not separately measured. Quantiles from different stages must not be added.

```sh
uptime
node scripts/with-test-db.ts node scripts/capacity.ts --rungs 100 --writers 10 --writes-per-writer 5 --slo-ms 2000 --drain-ms 4000 --trace true --idle-ms 12000 --output "$CAPACITY_OUTPUT"
```

Use a new external output prefix for each run. `--idle-ms` defaults to zero and is bounded at 120000. The counter is installed only in the owned test server preload; production imports no probe.

## Correctness evidence

`test/history-read-gate.test.ts` covers unchanged admission, change admission, signal invalidation during a read, the exact safety deadline, failed/incomplete scan state, authoritative history without an index, equal-size writes with exactly equal mtimeNs, replacement inode changes, index/WAL changes, file removal, filesystem errors, real SDK single-flight with 100 concurrent queries, filter isolation and failed-flight cleanup. The metadata collision safety policy is checked separately from filesystem timestamp precision.

`test/mutation-replay.test.ts` uses real pinned CLI mutations: idle polling takes zero additional locks before the safety deadline; separate CLI writes bypassing NOTIFY are delivered; a skewed later-visible fact behind the SDK exclusive cursor arrives once; restart receipts suppress duplicates; and an intentionally aliased metadata token at a due safety scan still returns a near-expiry fact via the real SDK. Only the admission clock is held in the idle regression to prevent shared-host scheduling from accidentally reaching the legitimate safety deadline. The separate safety regression advances that deadline. A child with Node SQLite disabled exercises the SDK's actual authoritative-history fallback, without mocking SDK methods.

`test/mutation-read-signals.test.ts` verifies HTTP and validated peer notifications invalidate only their project, self/invalid notifications do not, and callbacks release independently. Existing authorization, reconciliation, recovery and real-process capacity tests remain in the unchanged release gates.

Behavioural revert: replacing only `followCommittedMutations` with the base implementation (plus its required import) failed both new regressions: 7 idle lock opens versus the previous 4, and an absent near-expiry CLI fact (0/2). Replacing only `singleFlightMutationPage` with direct SDK delegation failed the two-reader shared-result assertion (0/1); the restored test additionally exercises 100 readers. An earlier 100-reader revert diagnostic timed out and was terminated, so it is not used as the direct assertion proof. Functions were restored after each experiment. Full results and further measurements follow below.

## Three repeats at 100 subscribers

Each row committed 50/50 updates with zero lost receipts, duplicates, failed writes or disconnected subscribers. Pre-append is mutation timestamp to authoritative append completion; the combined column uses all 50 writes, with 25 samples in each origin column. Nearest-rank p99 at these populations is the maximum.

| Run | Idle locks / seconds | Locks/sec | Writer pre-append p99 ms | HTTP p99 ms | CLI p99 ms | CLI lock wait p99 ms | To-all p99 ms | Result |
|:---|:---|---:|---:|---:|---:|---:|---:|:---|
| B1 | 41 / 12.02 | 3.410 | 798.7 | 798.7 | 405.5 | 141.5 | 2335.1 | BREACH |
| B2 | 42 / 12.02 | 3.494 | 1039.3 | 377.3 | 1039.3 | 852.3 | 1605.0 | PASS |
| B3 | 42 / 12.02 | 3.494 | 1815.2 | 1007.4 | 1815.2 | 1745.6 | 2105.2 | BREACH |
| A1 | 2 / 12.02 | 0.166 | 291.8 | 207.3 | 291.8 | 217.9 | 786.1 | PASS |
| A2 | 2 / 12.02 | 0.166 | 596.8 | 562.0 | 596.8 | 464.4 | 1081.3 | PASS |
| A3 | 2 / 12.02 | 0.166 | 702.3 | 702.3 | 570.0 | 509.2 | 1353.4 | PASS |

Idle acquisition rate fell from 3.410–3.494/sec to 0.166/sec in these observations (about 95%). Each after interval contained two periodic full reads, with no writers. All three after repeats met the SLO. End-to-end and writer times were lower in these samples, but neither a quiet host nor a controlled causal speedup is established.

| Run | Uptime duration | uptime load 1/5/15 | Harness initial load 1/5/15 | RSS MiB | CPU p95 % core | Server loop p99 ms | Generator loop p99 ms | PG server/DB |
|:---|:---|:---|:---|---:|---:|---:|---:|:---|
| B1 | 3 days, 22:07 | 6.83 / 8.05 / 9.56 | 6.83 / 8.05 / 9.56 | 197.0 | 18.8 | 41.6 | 35.6 | 20/21 |
| B2 | 3 days, 22:08 | 11.38 / 9.06 / 9.81 | 12.28 / 9.33 / 9.89 | 197.9 | 20.2 | 36.2 | 40.2 | 20/21 |
| B3 | 3 days, 22:09 | 13.76 / 10.23 / 10.17 | 13.29 / 10.19 / 10.16 | 199.5 | 19.5 | 42.3 | 37.3 | 20/21 |
| A1 | 3 days, 22:16 | 20.41 / 17.23 / 13.32 | 21.08 / 17.53 / 13.48 | 190.9 | 24.3 | 33.6 | 46.6 | 20/21 |
| A2 | 3 days, 22:18 | 18.19 / 17.30 / 13.63 | 18.14 / 17.31 / 13.67 | 190.4 | 21.0 | 38.4 | 43.8 | 20/21 |
| A3 | 3 days, 22:19 | 16.24 / 16.99 / 13.78 | 17.39 / 17.22 / 13.89 | 190.6 | 23.7 | 34.8 | 39.7 | 20/21 |

All six runs had healthy before/after snapshots and no recorded server error kinds. PostgreSQL maximum connections was 100. JSON revision fields refer to the common parent while testing the package working tree; B is the base follower with the new test-only counter, A is the mitigation. The final PR supplies the source diff. Relative tracker roots remain distinct by working directory; the production fixtures use explicit absolute tracker roots.

## Increasing ladder and stopping point

After all three 100-subscriber repeats passed, the requested `250,500,1000` ladder stopped at its first rung. **250 subscribers breached the 2000 ms SLO; 500 and 1000 are unmeasured.** The 250 rung committed 50/50 writes and delivered all 12500 receipts exactly once, without failed writes, disconnects or recorded server error kinds. This is a timing breach with correct finite-window delivery, not proof of a saturated server resource.

| Subscribers | Idle locks/sec | HTTP pre-append p99 ms | CLI pre-append p99 ms | CLI lock wait p99 ms | To-all p50 / p95 / p99 ms | Lost / duplicates | Result |
|---:|---:|---:|---:|---:|:---|:---|:---|
| 250 | 0.250 | 1861.3 | 616.0 | 379.8 | 643.5 / 2046.9 / 2398.6 | 0 / 0 | STOP |

Pre-invocation uptime duration: 3 days, 22:20; load 1/5/15: 17.39, 17.06, 14.06. Harness initial load: 18.59 / 17.35 / 14.21; ending load: 20.55 / 18.07 / 14.68. RSS peak 197.0 MiB; server CPU p95 12.7% of one core; server/generator event-loop p99 93.5/88.9 ms; Postgres server/test-database connections 20/21 of 100. The idle interval contained three acquisitions in 12.02 seconds; its phase relative to the five-second deadline differs from the two-acquisition 100-subscriber intervals.

The SLO failure did not coincide with server CPU exhaustion, a large server event-loop stall or a full database pool. Shared-host scheduling/I/O pressure is observed, while its causal contribution and the next package bottleneck remain unproven. HTTP pre-append time is material in this rung. No upstream SDK lock fix is included, and active readers/writers can still contend.

```sh
uptime
node scripts/with-test-db.ts node scripts/capacity.ts --rungs 250,500,1000 --writers 10 --writes-per-writer 5 --slo-ms 2000 --drain-ms 4000 --trace true --idle-ms 12000 --output "$CAPACITY_OUTPUT"
```

Passing three 100-subscriber repeats proves only these finite, closed-loop synthetic runs. It does not establish hosted capacity, quiet-host capacity, sustained throughput, browser/proxy performance, multi-instance fan-out, slow-reader buffering, reconnect replay, large-project metadata cost, or guaranteed delivery for facts becoming visible more than 60 seconds after their timestamp. The replay dedupe memory cap remains 10000 facts per active project.

## Release validation

Both required commands ran with an isolated home, empty global/system Git configuration and the readonly canonical fleet metadata context, at unchanged thresholds. Initial attempts stopped at test-only lint issues; imports and synchronous builtin restoration were corrected before the runs below.

| Command | Coverage suite | Statements / lines | Branches | Functions | Capacity | Packed consumers | Outcome |
|:---|:---|---:|---:|---:|:---|:---|:---|
| `npm run release:check` | 646/646, zero fail/cancel/skip/todo | 92.47% | 81.00% | 96.02% | 2/2 | 4/4 | PASS |
| `bun run release:check` | 644 pass, 1 fail, 1 cancelled of 646; zero skip/todo | 91.61% | 80.65% | 95.69% | not reached | not reached | FAIL |

Coverage measures the 39 configured `src` files, not all executable frontend/script source. Thresholds remain statements/lines 92.07%, branches 80.50%, functions 94.59%; duplication remains zero. npm also passed every static, changelog and release-metadata check and found zero production vulnerabilities.

The Bun run's existing built catalog-install scenario exhausted its 300000 ms deadline; the source scenario then returned `stateError: spawn ENOTDIR`. These cases use `createApp` directly and start no mutation watcher. The same unchanged scenarios passed in the npm run. This matches the existing `pm-web-qdhx` cancellation pattern, where the new evidence is appended. The incomplete Bun run also failed its statements/lines floor; it is not a passing gate and no threshold was relaxed. Watcher regressions passed in both full suites. GitHub checks are verified on the pushed head and reported separately.

The stage probe begins immediately before each SDK page call. With change detection, append-to-detecting-read therefore includes metadata traversal as well as polling delay; it does not isolate the timer from stat latency. Neither tracing nor this mitigation establishes the exact contribution of other readers versus writers to an individual SDK lock wait.

`node_modules/.bin/pm test pm-web-bazs --run --progress` passed both linked commands: the focused source suite 29/29 and `npm run accept:capacity` 2/2, with zero failure categories or skipped selections. The project has test-result tracking disabled, so no machine last-run receipt was saved; the observed results are recorded in the feature comments without changing that policy. The feature remains in progress and its claim is released for orchestrator verification. The existing follow-up `pm-web-qdhx` also contains the catalog failure evidence.

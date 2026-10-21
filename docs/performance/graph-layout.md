# Large graph layout

The force worker and frame loop share deterministic Barnes–Hut repulsion.
Graphs of up to 512 nodes retain the symmetric exact calculation. Larger
sets use a quadtree with opening angle 0.75. Cells containing the target are
always opened; bounded terminal buckets exclude its own mass. A 32-level
limit handles coincident points without pairwise fallback. Springs, tag
centroids, pinning, cooling and the 180-step settle schedule are unchanged.
The initial sunflower seed and layout-switch offsets are deterministic.
The worker still publishes one final result; cancellation and the control
coalescing debounce stay in the canvas. The extra module is precached.

`npm run build:frontend && node --test test/graph-physics.test.ts` checks
fourfold growth below sevenfold actual distance evaluations, exact small
forces, a 5% RMS force-error ceiling, determinism, fixed coordinates and
degenerate positions. This is a complexity regression independent of host
scheduling, rather than a tighter or relaxed wall-clock test deadline.

The browser harness uses the production canvas, worker and package-card
renderer from a frozen local static copy. It initializes and seeds a real
non-git scratch tracker through the pinned SDK and expands its synthetic
labels into fixed sunflower chains with n−1 links. It records the public
setData call, time to final publication, animation frame intervals, 50 ms
input-task delays, finite coordinates and static positions while pending.
These are browser layout measurements, not server/database capacity claims.
The fixed 180 steps are the product's settle schedule, not a proof of energy
convergence for arbitrary dense graphs. Repulsion is approximately O(n log n)
for ordinary spatial distributions; springs remain O(edges).

Build, then set `CHROMIUM_PATH` and `GRAPH_EVIDENCE` to local executable and
external evidence destinations. Run `GRAPH_PHASE=before node
scripts/graph-scale-browser.ts` and `GRAPH_PHASE=after node
scripts/graph-scale-browser.ts`. BEFORE reconstructs the canvas and force
module from `GRAPH_BASE_REF` (default `origin/main`); AFTER uses the current
build. Both use the same seed and sizes 500, 2000, 5000 and 10000. No hosted
endpoint, hosted tracker or Docker service is involved.

## Local browser observations

One observation per phase/size, in a shared Linux environment with Node
24.19.0 and sampled CPU pressure of 95–97%. The phase runs overlapped other
local work. Wall time includes debounce, worker startup, transfer and final
publication; CPU contention makes these observations unsuitable as fixed
latency guarantees. All graphs are chains with n−1 dependency edges, the
same sunflower seed and the same 180 steps.

| Nodes | Settle before (s) | Settle after (s) | Before/after | Frame p95 before/after (ms) | 50 ms task delay p95 before/after (ms) |
|---:|---:|---:|---:|---:|---:|

| 500 | 2.534 | 7.086 | 0.36× | 283.3 / 716.7 | 342.6 / 837.3 |
| 2,000 | 36.048 | 22.415 | 1.61× | 566.6 / 716.7 | 741.4 / 1127.8 |
| 5,000 | 283.712 | 46.669 | 6.08× | 866.6 / 733.3 | 1180.2 / 1232.4 |
| 10,000 | 920.313 | 117.877 | 7.81× | 849.9 / 1083.3 | 1258.2 / 1567.1 |

The 16.7 ms frame budget is unmet in both phases on this loaded host. At 500
nodes the exact force law is retained; its radius is identical. A later
candidate-only observation measured 2.523 s at 500 and 9.204 s at 2,000,
showing run-to-run variation. The later harness also initializes translations before timing. These later samples do not replace the
primary table. The artifact runner separately observed 2,000-node settling
at 2.090 s before and 0.793 s after, with frame p95 near 16.8 ms. CI numbers
are not local-host measurements.

All local sizes retained static positions until the single final result and
published finite coordinates. Settled RMS radius changed by 0%, −1.04%,
−1.00% and −1.12% respectively. This scale metric and the seeded 5% RMS
force-error regression bound a useful visual comparison; they do not certify
all possible graph shapes. The screenshots permit direct inspection of the
500- and 2,000-node layouts.

The first tick performs 58,299 distance evaluations at 1,000 nodes and
303,203 at 4,000 (5.20× growth). Restoring only the original tick function
and rebuilding fails the regression with 499,500 → 7,998,000 evaluations
(16.01×). At 10,000 nodes, 859,665 evaluations replace 49,995,000 pairs.
The candidate physics suite passes 4/4. Existing browser checks pass initial
worker scheduling, delayed fitting, replacement restart, stale-result
rejection, empty data and early hierarchical cancellation. The real SDK
non-git tracker test passes with Git excluded from PATH.

Raw measurements and production-source hashes are in
[graph-layout-measurements.json](graph-layout-measurements.json). Review PNGs
and JSON receipts are workflow artifacts linked from the PR body; images
are retained for 30 days and are not committed. The screenshot harness
initializes production translations and rejects unresolved package keys.
The catalog's added cards are visible as not yet released, with optional RLM
service/key requirements and no install action.

## Validation boundaries

At implementation head `67fd2de55bd12cf7049e0382f5c4a1b1b9c1c351`, both
Node 22 and Node 26 CI jobs pass complete isolated-identity
`npm run release:check` and `bun run release:check`: **770/770 tests per
gate**, zero failures/cancellations/skips, capacity **2/2**, and packed
npm/native-Bun consumers **4/4**. The consumer hosts are the package-pinned
2026.10.19 and minimum 2026.10.4; the standalone SDK is 2026.10.19. These
receipts do not claim latest-registry 2026.10.21 consumer acceptance.
Configured `src` coverage reports 47 sources, statements/lines 92.85%,
branches 82.58–82.59% and functions 95.45–96.26%, above unchanged floors.
[Complete CI run](https://github.com/unbraind/pm-web/actions/runs/39639377337).
The browser physics regressions supplement that server-source coverage scope.

The complete local npm command exits 1: **770 tests, 767 pass, 2 fail,
1 canceled, zero skipped**. The built catalog acceptance hits 300000 ms,
the following source case reports `spawn ENOTDIR` (pm-web-qdhx), and the
unchanged server 2,000-item graph read takes 13922 ms against its 10000 ms
bound (pm-web-hqqp). Observed S/L 92.13%, B 82.49%, F 95.97% does not make
that failed run accepted coverage evidence. The local Bun attempt is
terminated at its 3600000 ms outer linked-runner bound, without terminal
suite totals; partial output contains catalog, graph-read and other
process/timing failures. The repository's internal limits are unchanged.

The focused local commands pass physics **4/4**, no-git **1/1**, catalog/UI
**26/26** and scoped workflow policy **8/8**, including real SDK scratch
trackers. Independent automated reviews returned policy/quota availability
responses rather than substantive review or approval. No independent
approval is claimed. Full-fleet SDK registration compatibility is separately
tracked in pm-web-v6p4; scoped snapshot refresh does not certify other
packages' freshness. The PR links final metadata-head checks and the current
artifact. Both requested items remain in progress for orchestrator review.

A separate local capacity attempt also fails: **2 tests, 0 pass, 1 fail,
1 canceled**, zero skipped. Its 20-subscriber/five-writer smoke reaches
60000 ms; the next two-subscriber trace case reports setup failure. This
local failure is separate from the four complete CI capacity receipts.

The separate local production audit reports zero vulnerabilities and package
packing dry-run succeeds. Local packed acceptance stops when its first npm
consumer installation exceeds the existing 300000 ms command bound; no local
consumer receipt is accepted. Separate changelog freshness, version-derived
date and publish-attestation checks pass. Complete CI receipts remain the
positive packed-consumer evidence. These local holds and missing independent
approval remain review limitations, rather than being hidden by the CI pass.

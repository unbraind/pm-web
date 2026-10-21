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
showing the scheduling variation. These later samples do not replace the
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

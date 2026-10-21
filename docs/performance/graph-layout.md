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

Measured results and screenshot provenance are added after both runs finish.

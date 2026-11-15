# Fleet CI v2

The required checks remain `test (22)` and `test (26)`, on `ubuntu-latest`.
PRs and manual dispatch run quick CI; superseded PR runs cancel. Every PR job
has a 30-minute timeout. There is no push trigger in `ci.yml`.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker PR, both nodes | Deep |
| --- | --- | --- | --- | --- |
| npm ci, prepare merge drivers, pinned managed extension | yes | yes | yes | local independent + hosted matrix |
| Strict pm health, required merge drivers | yes | yes | yes | local independent + hosted matrix |
| Build and complete test suite | quick, no coverage/pack/changelog | quick through release gate | pack builds shipped output | full hosted matrix |
| Typecheck, ESLint, duplication, docstrings | via build only | release gate | executable tracker files select code path | local independent + hosted matrix |
| Fresh build / committed dist drift | — | yes | — | local independent |
| Coverage: statements/lines 92.07%, branches 80.5%, functions 94.59% | — | quick, unchanged thresholds | — | full hosted matrix, unchanged thresholds |
| Capacity smoke: 20 SSE subscribers, five writer lanes | — | release gate | — | full hosted matrix |
| Production dependency audit | — | release gate | — | hosted matrix |
| Package dry run and packed consumer acceptance | — | release gate | yes, docs are shipped inputs | hosted matrix |
| Changelog consistency | — | release gate | yes | hosted matrix |
| Release changelog date / publish attestation verifiers | — | release gate | date verifier | hosted matrix |
| Identity audit, replay privacy, signing-secret fixture, evidence source security | suite | suite | yes | local independent + hosted matrix |
| Startup docs, graph-layout docs, capacity trace docs, gated-sync verification, development-audit tracker receipt | suite | suite | yes | local independent + hosted matrix |
| Packaging metadata and all published Markdown links/packed byte contracts | suite | suite + packed acceptance | yes | local independent + hosted matrix |
| Bun package-graph install smoke | — | yes | packed acceptance | hosted matrix |
| Full independent seeded contract/evidence/permission schema suites | — | — | — | local independent |
| Maker footer browser acceptance | — | — | — | hosted browsers |
| Decision inbox before/after browser screenshots | — | — | — | hosted browsers + artifacts |
| Authorized agent context browser acceptance and screenshots | — | — | — | hosted browsers + artifacts |
| Desktop/mobile contract explorer browser acceptance and screenshots | — | — | — | hosted browsers + artifacts |
| Permission impact preview and invalidation browser evidence | — | — | — | hosted browsers |
| CodeQL | separate matching-path workflow | separate matching-path workflow | excluded paths | main matching paths and Monday 04:47 UTC |

The docs/tracker classification compares actual PR base/head endpoints, with
NUL-delimited filenames and rename folding disabled. A source-to-docs move
therefore still runs code CI. Executable tracker files and managed-extension
configuration select the code path. Unrecognized files select the code path.
No separate Markdown linter, `privacy` script or `identity:check` script exists;
the suites above enforce these contracts. Inspection of lint, duplication and
docstring scripts showed source-code scopes, whereas packaging and document-link
checks read README, CHANGELOG, nested published Markdown and tracker receipts.
The cheap path consequently retains packing and packed acceptance; it does not
trade these inputs for a falsely green check.

## Deep runner placement

Deep runs on main pushes, daily at **02:19 UTC**, and manual dispatch. Release
remains at hourly :41 (daily release 03:41); weekly CodeQL stays Monday 04:47.
Deep has per-ref cancellation and 120-minute job timeouts, explicit
`PM_TEST_DEPTH=full` and `PM_TEST_TIME_SCALE=3`. No deep check is required.

* `deep independent` runs on `pm-local`, with the controller-owned
  `PM_LOCAL_DEEP=off` fallback to `ubuntu-latest`. It runs strict tracker health,
  static gates, fresh-build drift, independent full seeded suites and all cheap
  documentation/privacy/identity suites. Self-hosted setup does not restore the
  GitHub npm cache: the image mounts a persistent npm cache. Bun comes from its
  image; setup-bun runs only for the GitHub-hosted fallback. `bun --version`
  records the actual runtime.
* **Service exception:** `deep (22, npm)`, `deep (22, bun)`, `deep (26, npm)` and
  `deep (26, bun)` run on `ubuntu-latest` with PostgreSQL 17. Each job runs exactly
  **one intact original release gate**, never consecutive npm and Bun gates.
  Coverage and capacity require real PostgreSQL; local runners cannot launch
  service containers. Keeping the composite gate intact duplicates its static
  checks with the local job, but preserves the complete original release
  contract. These jobs deliberately do not use the local-runner expression.
* `deep browsers` runs on `ubuntu-latest`, Node 26, with PostgreSQL and Playwright
  `--with-deps chromium`. It retains every original browser check and artifact;
  apt installation and service containers are unavailable on `pm-local`.

This is the explicit hosted-service exception to the fleet's usual local deep
matrix. No service test is skipped. The original standalone repetitions of
checks already inside `release:check` are removed from PR CI, while unique
committed-output and browser checks remain in the tiers above. No release caller,
release verifier, branch protection or repository variable is changed.

## Depth and time contracts

Unset, `full` and unrecognized `PM_TEST_DEPTH` values retain full depth. Quick
uses the same deterministic seed prefix at one tenth depth, rounded up, with a
minimum of 25 capped by the original count. The 500-case resume, permission
routing, contract partition and evidence sequence tests use 50 cases; the
1,000-case permission/evidence schema tests use 100. Every assertion and fixture
stays. Existing 20-case graph fidelity and capacity/fanout boundary fixtures are
not repetitive large property corpora and remain unchanged. The modified suites
have no seeded success/refusal counters or generated filename control characters.
Coverage scope, exclusions and all four thresholds are unchanged in both depths.

`PM_TEST_TIME_SCALE` defaults to 1, must be finite and positive, and is validated
at module load before affected child launches. Scaled watchdogs use `Math.ceil`
and must remain positive safe integer milliseconds. Only packed command watchdogs
and runner/startup/CLI test harness timeouts are scaled. The runner's 30ms product
timeout and its exact diagnostic assertion remain **30ms**; request deadlines,
lookup/lock budgets, startup readiness contracts and capacity/graph latency
contracts are not scaled. The deterministic corpus loops terminate by case and
operation counts. Job timeouts bound the complete run.

Packed acceptance already exercises npm/Bun project installs at current and
minimum host versions, npm/Bun global launchers, native Bun execution and the
`bun x --no-install pm` credential boundary. This proves the installed bunx
launcher path, not an uncached ephemeral registry install. The PR therefore uses
`bun install --no-save` as its extra package-graph smoke, not another full gate.

## Measurements and validation

Owner's 24-hour fleet measurement: 39,929 runner-minutes; pm-web used 1,759
runner-minutes on November 14, with median successful PR wall 57 minutes and
maximum 504 minutes. The latest successful main CI, run **43729657164**, measured
Node 22 **120m22s** created-to-completed (**35m25s** execution) and Node 26
**115m05s** (**27m59s** execution). It repeated full npm/Bun gates on both nodes.
The retrieved log archive's slowest seeded resume invocation was **109.072s**;
evidence sequences reached **30.210s**, graph properties **28.113s**. These are
individual full-depth test timings, not full-gate benchmarks or quick estimates.

Local validation is limited to typecheck, lint, touched test files and one quick
coverage attempt bounded at 20 minutes. Full depth is reserved for deep CI after
merge. PR timing and exact validation results are recorded in
[the package task](../.agents/pm/tasks/pm-web-qdhx.toon), companion
`pm-cli-website-dyhg`. Queue-inclusive CI wall time is measured from job
`created_at` to `completed_at`, separately from execution. CI observation ends
within 30 minutes after the last push; unfinished runs remain explicit gaps.

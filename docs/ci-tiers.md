# Fleet CI v2

The required checks remain `test (22)` and `test (26)`, on `ubuntu-latest`.
PRs and manual dispatch run quick CI; superseded PR runs cancel. Every PR job
has a 30-minute timeout. There is no push trigger in `ci.yml`.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker PR, both nodes | Deep |
| --- | --- | --- | --- | --- |
| npm ci, prepare merge drivers, pinned managed extension | yes | yes | yes | local independent + hosted matrix |
| Strict pm health, required merge drivers | yes | yes | yes | local independent + hosted matrix |
| Build and test suite | quick, except packed inventory; no coverage/pack/changelog | quick through release gate | pack builds shipped output | full hosted matrix |
| Typecheck, ESLint, duplication, docstrings | via build only | release gate | executable tracker files select code path | local independent + hosted matrix |
| Fresh build / committed dist drift | — | yes | — | local independent |
| Coverage: statements/lines 92.07%, branches 80.5%, functions 94.59% | — | quick, unchanged thresholds | — | full hosted matrix, unchanged thresholds |
| Capacity smoke: 20 SSE subscribers, five writer lanes | — | release gate | — | full hosted matrix |
| Production dependency audit | — | release gate | — | hosted matrix |
| Package dry run and packed consumer acceptance | — | release gate | yes, docs are shipped inputs | hosted matrix |
| Changelog consistency | — | release gate | yes | hosted matrix |
| Release changelog date / publish attestation verifiers | — | release gate | yes | hosted matrix |
| Identity audit, replay privacy, signing-secret fixture, evidence source security | suite | suite | yes | local independent + hosted matrix |
| Startup docs, graph-layout docs, capacity trace docs, gated-sync verification, development-audit tracker receipt | suite | suite | yes | local independent + hosted matrix |
| Packaging metadata and all published Markdown links/packed byte contracts | suite, except packed inventory | suite + packed acceptance | yes | local independent + hosted matrix |
| Bun install and bunx installed-host smoke | — | yes | packed acceptance | hosted matrix |
| Full independent seeded contract/evidence/permission schema suites | — | — | — | local independent |
| Maker footer browser acceptance | — | — | — | hosted browsers |
| Decision inbox before/after browser screenshots | — | — | — | hosted browsers + artifacts |
| Authorized agent context browser acceptance and screenshots | — | — | — | hosted browsers + artifacts |
| Desktop/mobile contract explorer browser acceptance and screenshots | — | — | — | hosted browsers + artifacts |
| Permission impact preview and invalidation browser evidence | — | — | — | hosted browsers |
| CodeQL | separate matching-path workflow | separate matching-path workflow | excluded paths | main matching paths and Monday 04:47 UTC |

The docs/tracker classification compares actual PR base/head endpoints, with
NUL-delimited filenames and rename folding disabled. A source-to-docs move
therefore still runs code CI. Executable files under docs or the tracker, and managed-extension
configuration, select the code path. Unrecognized files select the code path.
The code-PR Node 22 leg excludes only the named published-Markdown inventory
case because it executes `npm pack`; the case remains in Node 26 coverage,
docs-only CI and every deep gate. No other floor test is excluded.
No separate Markdown linter, `privacy` script or `identity:check` script exists;
the suites above enforce these contracts. Inspection of lint, duplication and
docstring scripts showed source-code scopes, whereas packaging and document-link
checks read README, CHANGELOG, nested published Markdown and tracker receipts.
The publish verifier also examines every tracked file for a shell shebang, so
even docs-only CI retains both release verification commands.
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
and runner/startup/CLI/catalog test harness timeouts are scaled. The runner's 30ms product
timeout and its exact diagnostic assertion remain **30ms**; request deadlines,
lookup/lock budgets, startup readiness contracts and capacity/graph latency
contracts are not scaled. The deterministic corpus loops terminate by case and
operation counts. Job timeouts bound the complete run.

Packed acceptance already exercises npm/Bun project installs at current and
minimum host versions, npm/Bun global launchers, native Bun execution and the
`bun x --no-install pm` credential boundary. This proves the installed bunx
launcher path, not an uncached ephemeral registry install. The PR therefore uses
`bun install --no-save` and `bunx --no-install pm --version` as its extra
package-graph/launcher smoke, not another full gate.

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

Initial local validation on Node 26.13.0 passed `npm run check`,
`npm run build:test`, `npm run lint`, and the linked eight-file quick-depth
command in **140.393 seconds**. Workflow parser/helper regressions passed 3/3.
The single quick coverage attempt is bounded to 20 minutes; full depth is deferred.

The first PR run finished Node 22 in **6m12s** and Node 26 in **11m06s**,
created-to-completed, with workflow-integration failures. These are not accepted
successful quick benchmarks. Browser guards
and the screenshot uploader's existing file-scoped approval now follow the
deep workflow. Deep uses conditional literal npm/Bun commands because the
unchanged publish-attestation analyzer correctly refuses an expanded executable.
The focused helper/browser/action-policy command passed in **19.407 seconds**.

The initial Node 26 quick run observed **94.29% statements/lines, 86.02%
branches and 97.61% functions**, above every unchanged floor. Its only failures
were the workflow integration assertions described above; the failed gate is
not accepted coverage evidence. No late-seed branch regression appeared in that
report. The final head requires a fresh passing hosted run.

The single local quick coverage attempt stopped at its **1,200-second cap**
(exit 124; 1,200.064 seconds observed). It reproduced the existing catalog
installation fixture's 300-second aggregate timeout and subsequent source
fixture failure, in addition to the already-corrected old browser guard. It
produced no accepted coverage report. The catalog aggregate/SSE harness watchdogs now use the same validated scale;
its focused retry is recorded in the task. No product deadline was changed and
no second local coverage run was started. Both focused commands passed; test
typecheck and ESLint passed again after the workflow-contract corrections.

The scaled catalog file retry passed **3/3 in 357.463 seconds**, with no
failures, cancellations or skips. Its built/source cases took 175.622/178.027
seconds each; both are below the original per-case 300-second bound without
coverage instrumentation. This focused pass does not certify the previously
failing instrumented aggregate. The final task claim is released for owner
verification; required final-head CI and full-depth certification remain open.

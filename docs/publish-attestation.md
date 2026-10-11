# Publish attestation gate

`npm run verify:release-publish-attestation` checks every tracked executable
source discovered by `pm-ops/attestation`. A correctly attested publish in one
step cannot excuse an unattested invocation elsewhere. No recognized publish is
also a failure.

The pinned **pm-ops 2026.10.6** auditor resolves literal scalar bindings, including
`NPM=npm` and `PUB="npm publish"`, and checks every literal function body. Its
canonical tokenizer, tracked-file discovery and provenance flag rules remain the
basis of this gate. The consumer adds failures for indirection that this version
cannot prove safe. It never removes a canonical failure or treats unknown text as
attesting evidence.

For example, the following fails even if the workflow also contains a normal
`npm publish --provenance`:

```bash
PUB="npm publish"
$PUB --access public
```

Adding `--provenance` to the variable-routed invocation passes. A literal function
whose body runs `npm publish --provenance` also passes. The last disabling flag
still wins, so `--provenance --no-provenance` fails.

The supplemental checks reject aliases, executable array expansions, quoted
executable variable expansions, compound executable words, partially expanded
executable names and paths, dynamic
`eval`/shell payloads (including variable-routed aliases and evaluators), unknown
publisher subcommands and forwarded function
arguments, and publishers spawned by `xargs` or `parallel`. Their input arguments
can append `--no-provenance`, including when the publisher is a literal scalar
variable. These unsupported forms fail even with a provenance-looking argument.
Use a literal function body or a readable unquoted scalar command instead.
Literal `eval "npm publish --provenance"` and quoted scalar provenance flags remain
supported. Unknown arguments on a resolved publish also fail because they could
supply a later disabling flag.

The supplemental guard parses workflow YAML and manifest scripts as data. Each `run` body and each
package script is checked separately, preventing one shell process's bindings
from attesting another process's publish. Invalid executable data fails closed;
the supplemental guard skips displayed shell text and workflow metadata, and
handles cyclic YAML references without looping. The canonical recognition count remains the original
scanner's count; supplemental failures can identify omitted paths without
claiming to have resolved them.

The regression suite uses staged Git fixtures, a real initialized pm tracker and
the built package's status handler through the real SDK dispatcher. An inert
Bash publisher records the arguments from aliases, function argument forwarding
and unquoted command variables. This proves that those shells reach `publish
--access public` without invoking a registry publisher.

```bash
npm run build
npm run build:test
node --test test/publish-indirection.test.ts test/verify-release-publish-attestation.test.ts
```

## Canonical follow-up

Move these conservative rejection rules and their adversarial corpus into
`pm-ops/attestation`. Its shell model needs proofs for alias invocations, partially
expanded command positions, forwarded publisher subcommands, quoted executable
word boundaries, executable arrays, unknown flags, spawning-wrapper input and independent workflow shell
scopes. Then publish a canonical auditor and update this consumer's exact pin.
The consumer guard can be removed only after its behavioral corpus passes through
the canonical export. This change updates only the public package gate and has no
hosted deployment component.

## Verification evidence and limits

The focused consumer suite passes **75 tests**, with no skips. Replacing only
`auditPublishAttestation` with the canonical call leaves imports, the launcher and
tests intact: the targeted corpus executes **66 tests**, with **35 assertion
failures** and **31 passes**. Alias and forwarded-function scenarios fail after
actually reaching the inert publisher. Restoring the implementation restores the
focused suite.

Earlier worktree release validation exposed catalog blockers:
[worktree identity discovery](../.agents/pm/issues/pm-web-cqwm.toon) and
[the missing pm-jev catalog/snapshot entry](../.agents/pm/issues/pm-web-s99c.toon).
Main now includes the catalog and discovery repairs. The catalog test also supports
a standalone checkout using its committed snapshot;
that validation scope does not establish live fleet freshness. Release evidence
must distinguish these two layouts.

Extensionless CommonJS test fixtures also inherit an ancestor package's module
type. The affected 26-test subset passes with an isolated CommonJS scratch root;
[fixture isolation follow-up](../.agents/pm/tasks/pm-web-jp0u.toon) records this
existing test dependency. Scratch trackers created by the new regression helper
declare their own module type, select their tracker path explicitly and initialize
their own Git repository before pm, keeping automatic merge-driver configuration
inside the fixture.

The historical implementation at commit `2f2652d` passed both `npm run release:check` and
`bun run release:check` in independent standalone CI layouts. Each runs **555 tests**, with
zero failures or skips. Configured coverage measures **33 source files** at
**90.23% statements/lines**, **79.41% branches** and
**93.90% functions**, against unchanged **90/90/79/92** thresholds. Duplication is
zero, production audit is clean, and packed npm and native Bun consumer
acceptance passes. Typechecking, lint, docstrings, pack dry run, changelog/date
checks and attestation verification also pass. This receipt covers the public
package and committed snapshot; live-fleet freshness remains a separate claim.
The subsequent verification receipt changes only tracker records and this
documentation; executable inputs remain identical to the tested implementation.


## Merged-main verification

Merge commit `58ebab7` retains the conservative audit function unchanged and
main's exact SDK **2026.10.10**, **pm-ops 2026.10.6**, graph and catalog changes.
The PM merge drivers preserve both comment histories, all linked test commands
and their authors. Audited reconciliation changes test provenance to merge-union
metadata and leaves all 147 tracker histories without drift.

The merged focused suite passes **75 tests**, with zero failures or skips.
Replacing only `auditPublishAttestation` with `return canonicalAudit(sources)`
executes **67 tests**: **35 failures caused by behavioral assertions**, **32 passes**, zero skips and no
module-load or syntax failures. The original function is restored byte-for-byte;
its SHA-256 is
`b6e5283f64625ef495c7e811378c0af8cfa052fe8e15834be694d8cfbb0d38ed`.
This proof retains imports, launcher and test files and exercises the real SDK,
initialized trackers, staged Git fixtures and inert Bash publisher.

The PM-linked command remains the same; its timeout increases from 180 to 900
seconds after the measured focused run took 327 seconds under concurrent
verification load. This does not change assertions or release-gate thresholds.

Release validation uses standalone CI checkouts with `PM_FLEET_ROOT` unset,
fresh external scratch directories and fresh Git identity environments:

```bash
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun run release:check
```

`TMPDIR` is also set to a fresh external directory with no ancestor package or
tracker metadata. The configured source/test lists and 90/90/79/92 coverage
thresholds and zero-duplication threshold are unchanged. The real test database
supports synthetic test fixtures; hosted services and data are outside this
verification scope.


The first merged npm release run executes **559 tests**: **557 passes**, **two
failures**, zero skips. Both failures are unchanged tests outside the attestation
implementation:

- The 2,000-item graph read takes **33,115 ms** against its **10,000 ms** bound;
  evidence remains on [pm-web-38n5](../.agents/pm/features/pm-web-38n5.toon).
- The spawn-overlap assertion observes `end first` before `start independent`.
  Same-workspace serialization holds. The explicit process-start scheduling
  follow-up is [pm-web-fhob](../.agents/pm/tasks/pm-web-fhob.toon).

Diagnosis observes shared verification load averaging 62.75 across four logical
CPUs, suggesting contention without proving it is the sole cause. No limits,
tests, sources or production graph/runner behavior are changed to excuse these
failures. The raw log prints **90.28% statements/lines**, **80.04% branches** and
**93.06% functions**. Those aggregate values exceed the configured thresholds,
but the failed test run prevents a release-gate pass and the coverage gate
correctly discards its report artifacts. These numbers are a failed-run
measurement, not an accepted coverage receipt.


The orchestrator intentionally interrupted the attempted local `bun run
release:check`, the remaining npm gate-tail run and the old CLI session to avoid
repeating heavy validation under extreme shared-host contention. **Neither
interrupted run passes.** Preserve the completed npm failure receipt, focused
75/75 and PM-linked 75/75 acceptance, and the 67-test guard-only revert proof.

The only additional executable change is the authorized copy of
`.github/workflows/ci.yml`. Both existing **Node 22 and Node 26** jobs now execute
literal `npm run release:check` and `bun run release:check` with fresh `HOME`,
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. Workflow YAML, both
literal gate commands and the fail-closed audit verdict are checked locally.
Original runtime sources, test lists, assertions, thresholds and auditor
behavior remain unchanged. Independent **PR #176 CI run 38116108000 passes**
on implementation head `06f50e6`: both Node matrix lines pass literal npm and
Bun release checks, each **559/559 tests**, zero failures/skips, all 34 configured
server sources meeting the unchanged thresholds, all four packed current/minimum
npm/Bun scenarios, strict fresh-checkout PM health and committed dist checks.

The follow-ups remain open, and the implementation item remains `in_progress`
with its claim released for independent verification. No new PM CLI or SDK API
defect is established by these shared-host timing observations.

The orchestrator's independent focused repeat also passes **75/75** without
skips. Recording this completed verdict changes documentation and tracker
evidence only; the implementation and test inputs remain identical. The final
receipt commit receives its own exact-head CI verification.


Final lightweight reconciliation passes with **zero drift**, **zero repairs** and
**zero pending receipts**. Strict local PM health reports the existing managed
`pm-github` host/SDK version skew (**2026.10.10 / 2026.10.11**) and 13 advisory
stale in-progress items. This does not establish an SDK API defect and does not
excuse a health gate; the independent checkout runs the committed managed
extension installer. The source and test inputs remain identical to merge
commit `58ebab7`, so the completed focused and PM-linked acceptance receipts are
retained without another heavy local suite.

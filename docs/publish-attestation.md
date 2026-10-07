# Publish attestation gate

`npm run verify:release-publish-attestation` checks every tracked executable
source discovered by `pm-ops/attestation`. A correctly attested publish in one
step cannot excuse an unattested invocation elsewhere. No recognized publish is
also a failure.

The pinned **pm-ops 2026.10.4** auditor resolves literal scalar bindings, including
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
arguments. These unsupported forms fail even with a provenance-looking argument.
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
word boundaries, executable arrays, unknown flags and independent workflow shell
scopes. Then publish a canonical auditor and update this consumer's exact pin.
The consumer guard can be removed only after its behavioral corpus passes through
the canonical export. This change updates only the public package gate and has no
hosted deployment component.

## Verification evidence and limits

The focused consumer suite passes **71 tests**, with no skips. Replacing only
`auditPublishAttestation` with the canonical call leaves imports, the launcher and
tests intact: the targeted corpus executes **62 tests**, with **32 assertion
failures** and **30 passes**. Alias and forwarded-function scenarios fail after
actually reaching the inert publisher. Restoring the implementation restores the
focused suite.

Worktree release validation also exposes existing catalog blockers:
[worktree identity discovery](../.agents/pm/issues/pm-web-cqwm.toon) and
[the missing pm-jev catalog/snapshot entry](../.agents/pm/issues/pm-web-s99c.toon).
The catalog test supports a standalone checkout using its committed snapshot;
that validation scope does not establish live fleet freshness. Release evidence
must distinguish these two layouts.

Extensionless CommonJS test fixtures also inherit an ancestor package's module
type. The affected 26-test subset passes with an isolated CommonJS scratch root;
[fixture isolation follow-up](../.agents/pm/tasks/pm-web-jp0u.toon) records this
existing test dependency. Scratch trackers created by the new regression helper
declare their own module type, select their tracker path explicitly and initialize
their own Git repository before pm, keeping automatic merge-driver configuration
inside the fixture.

The implementation at commit `a7233d1` passes both `npm run release:check` and
`bun run release:check` in a standalone CI layout. Each runs **551 tests**, with
zero failures or skips. Configured coverage measures **33 source files** at
**90.23% statements/lines**, **79.41% npm branches / 79.42% Bun branches** and
**93.90% functions**, against unchanged **90/90/79/92** thresholds. Duplication is
zero, production audit is clean, and packed npm and native Bun consumer
acceptance passes. Typechecking, lint, docstrings, pack dry run, changelog/date
checks and attestation verification also pass. This receipt covers the public
package and committed snapshot; the live-fleet blockers above remain separate.

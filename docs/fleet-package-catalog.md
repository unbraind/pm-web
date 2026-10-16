# Fleet packages in pm-web

The Packages view lists all 25 public fleet package identities. Each extension's
npm identity comes from `package.json`, its description and capabilities come
from `manifest.json`, and its command paths come from SDK registration metadata.
Requirements come from the package README. The two authoring templates use the
concise package description.
Swarm is a workflow product extension with `commands` and `schema` capabilities.
Its card uses curated display text while the snapshot retains the shorter
manifest summary from `feat/swarm`. It lists `pm swarm plan`, `start`, `status`,
`sync`, `land`, `reap` and `settings`; its unreleased card shows GitHub links
and no Install action.
Every extension includes documentation, repository and issue links; npm links
are shown only when the registry serves a published version.

The registry-backed snapshot contains 24 actual pm extensions: 17 published,
and seven unpublished (`pm-ado`, `pm-jev`, `pm-lint`, `pm-review`, `pm-rl`,
`pm-swarm`, `pm-vcs`). Publication intent
is insufficient evidence. `npm run fleet:snapshot` checks the registry and
refuses to overwrite its receipt when a lookup cannot be completed. Fleet
freshness checks compare the receipt with canonical package metadata wherever
sibling checkouts are available. Equivalent Git worktrees are collapsed;
conflicting metadata fails explicitly, in deterministic directory order.

## Refreshing package metadata

ADO exposes `pm ado validate`, `pm ado import`, `pm ado export` and `pm ado sync`,
with revision-checked updates and per-field three-way reconciliation. Jev also
exposes `pm jev link`. Both cards remain unreleased; these command declarations
establish neither npm publication nor live credentialed integration.

Regenerate the existing snapshot from the canonical fleet checkouts:

```sh
PM_FLEET_ROOT=<fleet-root> npm run fleet:snapshot
PM_FLEET_ROOT=<fleet-root> node --test test/catalog.test.ts test/fleet-commands.test.ts
```

Replace `<fleet-root>` with the directory containing the package checkouts. With
sibling canonical checkouts, `npm run fleet:snapshot` defaults to the parent
directory. Review and commit `test/fleet-extensions.snapshot.json` and
`test/fleet-native-commands.snapshot.json` together with
any corresponding catalog changes. Generation reads the fleet without building
or changing it, and checks npm availability before replacing the snapshot.

`scripts/read-fleet-commands.ts` uses each manifest's entry to locate TypeScript
source, then asks the pinned SDK for declared command-handler metadata in a
disposable package copy. This includes synthesized importer/exporter paths,
avoids stale compiled output and never runs command handlers. Installed package
dependencies are reused, with the host's pinned SDK available as a fallback.
Missing source, failed loading/activation, conflicting worktree declarations or
unreachable registry lookups abort generation without replacing the snapshot.
This operates on trusted fleet source, whose activation code runs during inspection.

The offline catalog test compares all 25 entries' command lists with
its independently generated snapshot, so omissions and extra paths fail even in
standalone CI. VCS retains its documented `pm vcs layer local` path under the
registered `pm vcs layer` dispatcher as an explicit assertion. With
`PM_FLEET_ROOT` set, the source freshness test also detects registration changes
before regeneration. Native Rust has no extension manifest
or SDK command receipt. Its separate snapshot verifies the Cargo binary identity
and extracts the documented `cargo run --` commands from the README native slice,
including `claim` and `release`, without building or executing Rust.

`pm-rust` is the remaining public package. Its `Cargo.toml` and README describe
an independent pre-release native CLI. It has no root `package.json` or
extension manifest, no npm identity or install spec, and no declared extension
capabilities. Its card lists its documented native commands and links to native
setup. pm-web cannot install or activate it as an npm extension. The server
returns a specific explanation instead of trying a fabricated npm package.

For a published extension, Install downloads the actual npm package into the
project; Enable activates its runtime registrations. An enabled card exposes
its documented command paths and accepts arguments as a JSON string array.
For example, choose `pm presets list` and enter `["--json"]`. Commands run
through the existing project runner without a shell, require edit permission
and an enabled extension, reject unknown command paths and global workspace
selectors, and return output beside the controls. Arguments retain extension
semantics, including Jira's `--project` flag. Existing hooks, schema, importers,
renderers, search, parser, preflight and services continue to use the pm runtime.
External services and credentials remain prerequisites described on each card;
listing or installing a package does not configure those dependencies.

Extension commands use the bounded process path in the existing runner. Its
in-process argv adapter knows positional and boolean arity from the core SDK
tool schema; treating extension commands as core actions loses nested command
positionals and extension-only boolean flags. Preserving the exact argument
array fixes both documented `pm presets list` and unified `pm presets --list`
forms without changing core action dispatch.

Before dispatch, the runner binds the effective command owner to the selected
package using the pinned CLI's real package-describe receipt. It normalizes
global options with the public SDK bootstrap contract, so separate values such
as `--author synthetic` and `--output-format json` cannot hide a competing
`presets list` handler. Equals forms and global boolean options follow the same
contract before or after nested command tokens. Ambiguous extension-local
option arity branches between a value and a positional token; only candidate
paths with a competing or unverifiable owned command return HTTP 409. Harmless
values such as `list --limit 5` and `--display-name 7d --list` remain allowed.
Candidate prefixes are pruned against the ownership table to bound the search.
Terminators carrying operands that an extension could dispatch itself return
HTTP 409. An empty trailing terminator and owned commands such as
`pm presets --list` remain supported.

## Acceptance and scope

`test/catalog-install-e2e.test.ts` serves the compiled application over HTTP,
uses a real disposable PostgreSQL owner/project and real initialized pm tracker,
and downloads published Presets from npm. It checks all 25 identities and their
metadata, installs and activates Presets, verifies installed/enabled/runtime
active state and executes its documented nested command. Unpublished ADO and
Swarm return the unreleased 409 explanation; native Rust returns a distinct
409 explanation. Neither changes tracker settings.
The real SSE connection observes install, activation and deactivation events;
command execution does not emit a package-state event that redraws its output.
It also rejects malformed arguments, undeclared commands and workspace escapes.
No SDK mocks or hosted deployment are involved.

Issue [#189](https://github.com/unbraind/pm-web/issues/189) extends both source
and compiled HTTP acceptance with a real higher-priority synthetic collision.
Each global-option form first executes the shadow through the pinned CLI, then
must return HTTP 409 through Web without an execution marker or settings change.
Local valued options execute successfully when all candidate owned prefixes
belong to Presets, including while the shadow is active if the value cannot
reach its sub-path. A separate `list` value is refused while an equals-form
value remains an option value. Multiple unknown options retain every candidate
prefix, so consuming their values cannot hide the shadow command.
Deactivating the shadow restores successful selected-package execution. The
original finding concerns current source after #175; the published Web
2026.10.11 tarball predates that change. No published Web or hosted exposure is
asserted by these tests.

`test/catalog-ui.test.ts` checks metadata links, the native boundary and labelled
keyboard controls with live result feedback. The existing filesystem and Git
worktree regressions retain canonical discovery and snapshot coverage. These
receipts establish public-package catalog and bounded command acceptance. They
do not establish live credentialed integration, service configuration, native
Rust deployment or every external package's own correctness.

## Behavioral revert proof

The built HTTP test executes with all modules loading in both experiments.
Removing only the native Rust catalog entry fails the exact 22-identity
assertion. Restoring that entry, then removing only the command route's explicit
timeout/process selection fails Presets command execution: the in-process
adapter returns 400 instead of 200. Each experiment executes one test and
produces one behavioral AssertionError, with no syntax or module-load failure.
Restoring the former command package-state broadcast fails the same test's
real SSE assertion: a `run` refresh would discard command output. Install,
activation and deactivation still appear before the decisive assertion.
Original source bytes are restored and the compiled server rebuilt after each
experiment. The restored acceptance passes, including actual npm installation.

For #189, replacing only `commandOwnershipError` with its baseline implementation
and rebuilding leaves the regression tests intact. Both source and built flows
fail the separate-value author case: HTTP 200 returns `scratch-shadow` output
instead of HTTP 409. That run executes three tests, with one pass, two behavioral
assertion failures and zero skips. Restoring the fix and rebuilding passes all
three tests.

## Release receipts

The #189 candidate starts at `f5b90ac7bc8a8cf895af754a6fbfdb235dd438d7`,
keeps CLI 2026.10.10 and Web version 2026.10.11, and passes both local release
gates with a scratch HOME and disabled global/system Git configuration:

| Command | Tests | Statements / lines | Branches | Functions |
| --- | --- | --- | --- | --- |
| `npm run release:check` | 575/575 | 90.54% | 80.47% | 93.45% |
| `bun run release:check` (retry) | 575/575 | 90.61% | 80.62% | 93.45% |

Both report all 34 configured sources at unchanged 90/90/79/92 thresholds,
zero skipped tests, zero duplication and zero production audit findings, and
accept all four packed npm/Bun current/minimum-host scenarios. Changelog,
release-date and publish-attestation checks pass. Both packed candidate tarballs
have SHA-1 `d3184c08bc542634a5666e3628fc0d8865d66694`; these are local artifacts,
not registry publication receipts. PM-linked HTTP acceptance passes 3/3.

The first Bun attempt remains failed evidence: 573/575, with the existing graph
wall-time assertion at 10277 ms and independent-child startup overlap failure.
They remain tracked by `pm-web-hqqp` and `pm-web-qdhx`. The unchanged retry passes
the graph bound at 7983 ms and the overlap assertion. No graph implementation,
timing assertion or threshold was changed; scheduling risk remains open.

Independent CI run 38116214351 on implementation head `f4f7dc1` executes the literal `npm run release:check` and
`bun run release:check` with fresh HOME and disabled global/system Git
configuration on both existing Node matrix lines. Each of the four runs passes
496/496 tests with zero failures or skips. All 34 configured server sources meet
the unchanged statements/lines 90, branches 79 and functions 92 thresholds.
Each runner also accepts all four packed npm/Bun current/minimum-host scenarios.

This receipt includes the feedback correction and extended SSE acceptance.
Restored PM-linked HTTP/SSE acceptance passes
1/1; canonical discovery/built-catalog acceptance passes 4/4, focused catalog/UI
and filesystem discovery passes 20/20, and corrected route acceptance passes 9/9.
The first local full attempt exposed two historical assertions, corrected
without weakening unpublished no-spawn or category checks. A second local
attempt was stopped for the feedback correction; neither is a full gate pass.
The final receipt commit changes documentation and tracker evidence only;
runtime, tests, dependencies, dist and workflow inputs remain identical. It
receives its own exact-head CI verification.

Current strict local PM health reports managed GitHub host/SDK version skew
between 2026.10.10 and 2026.10.11. Tracked integrity/history remains clean and
reviewed reconciliation leaves no drift or pending receipts. Fresh independent
CI's pinned managed-extension setup passes strict PM health. This does not
establish health of inherited local extension state or a hosted deployment.

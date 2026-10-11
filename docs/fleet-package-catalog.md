# Fleet packages in pm-web

The Packages view lists all 22 public fleet package identities. Each extension's
npm identity comes from `package.json`, its description and capabilities come
from `manifest.json`, and its command paths and requirements come from the
package README. The two authoring templates use the concise package description.
Every extension includes documentation, repository and issue links; npm links
are shown only when the registry serves a published version.

The registry-backed snapshot contains 21 actual pm extensions: 17 published,
and four unpublished (`pm-ado`, `pm-jev`, `pm-rl`, `pm-vcs`). Publication intent
is insufficient evidence. `npm run fleet:snapshot` checks the registry and
refuses to overwrite its receipt when a lookup cannot be completed. Fleet
freshness checks compare the receipt with canonical package metadata wherever
sibling checkouts are available. Equivalent Git worktrees are collapsed;
conflicting metadata fails explicitly, in deterministic directory order.

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

## Acceptance and scope

`test/catalog-install-e2e.test.ts` serves the compiled application over HTTP,
uses a real disposable PostgreSQL owner/project and real initialized pm tracker,
and downloads published Presets from npm. It checks all 22 identities and their
metadata, installs and activates Presets, verifies installed/enabled/runtime
active state, executes its documented nested command, and proves unpublished ADO and
native Rust return distinct 409 explanations without changing tracker settings.
The real SSE connection observes install, activation and deactivation events;
command execution does not emit a package-state event that redraws its output.
It also rejects malformed arguments, undeclared commands and workspace escapes.
No SDK mocks or hosted deployment are involved.

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

## Release receipts

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

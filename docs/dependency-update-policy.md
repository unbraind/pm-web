# Dependency update policy

Dependency updates change the lockfile and package or workflow references once.
The release gates validate their meaning instead of requiring duplicate pin
edits in test code.

The standalone SDK remains exact-pinned. `manifest.json` declares a separately
supported extension-host minimum. Both versions must meet the certified SDK API
baseline, 2026.10.4, and the standalone version must meet the host floor. That
baseline is the oldest certified SDK contract for the complete readers,
mutation subscriptions and extension commands used here. It was certified
after the production SDK removed its vulnerable fast-glob dependency chain. Matching older pins cannot lower it silently.
Packed acceptance installs the actual archive with npm and native Bun on both
the declared minimum host and current host, resolves the standalone SDK
independently and executes the real extension handler in disposable trackers.
Future version fixtures prove policy, while these real installations prove
compatibility with each published SDK.

External workflow actions must use a full 40-character hexadecimal commit SHA,
a stable release comment (`v7`, `v7.1` or `v7.1.0`) and an approved action name
from an allowed owner. Every workflow YAML file is discovered, including the metadata action in the
auto-merge workflow. The YAML parser inspects every `uses` field, including
quoted references and compact steps. CodeQL sub-actions must share both commit
and release comment, and remain grouped in the dependency updater. The group check uses parsed
action references, so quoted pins are supported and comments cannot substitute
for executable scanning steps. Both `init` and `analyze` must be present;
duplicating `init` cannot substitute for analysis even when pins and comments agree. CI checkout
must still disable persisted credentials. New suppliers require policy changes;
updates to existing suppliers need only their workflow references changed.
Version comments document releases; the local gate does not independently
attest that a remote tag resolves to the specified SHA.

`test/workflow-update-automation.test.ts` executes the actual workflow gate in
an isolated fixture with only workflow edits. It checks new and quoted pins and
rejects short/nonhex SHAs, mutable tags, missing/malformed versions, unapproved
owners/actions, nonliteral references, compact-step bypasses, empty action
corpora, new workflows with unapproved suppliers and inconsistent CodeQL
commits or comments.
`test/sdk-update-automation.test.ts` checks dependency-only updates, calendar
rollover, versions below the declared floor, ranges, malformed floors and a
simultaneous downgrade below the independently certified API baseline.

Historical PR #181 proposed SDK 2026.10.6, pm-ops 2026.10.6 and pm-changelog
2026.10.5. Main already has SDK 2026.10.10 via #182, with the same tool pins and
the host-floor repair. Applying #181's historical package bytes therefore
lowers the SDK; a rebased current scenario keeps 2026.10.10. The historical
scenario is acceptance evidence, not a proposed downgrade.

The graph latency assertion retains its 10-second wall-clock limit. Its CPU
and context-switch diagnostics distinguish computation from scheduling pressure;
they do not replace the elapsed-time guard. Reads retain the certified full,
unbounded, strictly observational SDK result, native ordering and concurrent-write
refusal. Scheduling investigations belong to the existing
[pm-web-hqqp](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-hqqp.toon) item.

Tracker: [pm-web-8pml](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-8pml.toon).

The HTTP contract fixtures await their real CLI verification subprocesses.
Synchronous verification blocked the shared server/client event loop and
produced intermittent loopback connection resets under load. A real-tracker
regression requires an authenticated HTTP probe to start while CLI verification
is pending. Reverting only the verification helper fails that regression;
the fixture retains every persisted-data assertion and the original HTTP
connection handling, without retries or longer deadlines.

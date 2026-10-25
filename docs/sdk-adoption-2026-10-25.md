# SDK settings and tracker admission

The 2026-10-25 audit identified two local copies of core behavior. This change
keeps the pinned SDK at 2026.10.20 and delegates both to its public API.

| Audit finding (baseline `74ee868`) | Replacement | Regression evidence |
| --- | --- | --- |
| `src/services/pm-runner.ts:336-368`: raw settings read/merge/write | `readSettingsWithMetadata` read snapshot and `writeSettings` delta protocol | Opaque provider/top-level keys and telemetry survive; workspace locking and stale disjoint writes; verified audit entry; malformed settings refusal; cache-primed history corruption refusal |
| `src/index.ts:278-285`, `src/services/pm-runner.ts:380-381`: initialization markers | Shared `workspaceInitialized` adapter over `assertInitializedTracker` (includes `assertReadableTrackerRoot`) with explicit tracker roots | Built doctor command, project-presence checks, missing/partial/non-directory/unreadable roots; no enclosing-tracker substitution |

No audit finding remains unadopted. The settings merge still selects the same
Ollama model, base URL and LanceDB path. Its handwritten JSON persistence and
the doctor/project marker algorithms are deleted. `initProject` awaits the SDK
settings commit before graph provisioning. The internal `projectExists` helper
now returns a promise; it has no production call sites in this baseline.

The SDK owns locking, opaque-key reconciliation, stale-snapshot conflict
handling, atomic persistence and workspace-history verification/compensation.
The adapter refuses SDK fallback settings warnings instead of writing defaults
when the original settings cannot be validated. No telemetry configuration is
changed by the implementation.

Neither replaced implementation previously read item history. Existing
`getItemAt`, complete-list certificate validation and route status mapping are
unchanged. The new corruption test primes both the mutation-event cache and
settings cache, alters a workspace-history hash, then requires the settings
write to fail with the original settings bytes restored and corrupt evidence
untouched. An event index is never used as an integrity receipt.

## Differential proof

Build the candidate, then run:

```sh
npm run build:server
node scripts/sdk-adoption-differential.ts <public-pm-web-checkout> <public-pm-slack-checkout> <public-pm-vcs-checkout>
```

The script builds baseline `74ee868` (override with `PM_SDK_BASE_REF`) from a Git
archive and uses the candidate's built output. It exposes the baseline's two
private functions in disposable builds by appending exports, without changing
their bodies. It snapshots tracked public tracker files with `git archive`,
reads the source checkouts only, and runs both builds on separate disposable
non-Git copies with parent Git discovery fenced off. No runtime caches or
hosted data are copied. Source trackers and their histories are never written.

Parsed settings and initialized/present/missing project outputs must be equal.
The script asserts every intentional difference:

- A `tasks` directory alone no longer makes doctor report an initialized tracker.
- Roots with search permission but no directory-read permission are refused.
- Schema-invalid settings are refused instead of being overwritten; malformed
  JSON also remains refused. Read warnings are checked before any settings write.
- Each changed settings document gains one verified workspace audit entry;
  the baseline wrote settings without recording it. Existing audit history is
  extended, never repaired or rewritten.

Settings key order/whitespace follows the SDK serializer; JSON values are the
comparison contract. These stricter admissions are intentional. Missing project
checks still return false, with no SDK diagnostic or filesystem path exposed.
Doctor retains its existing readiness result shape and text; HTTP route status
mapping is unchanged.

## Revert proof

Tests use real CLI-initialized non-Git trackers, plus a subprocess with no Git
executable on PATH. With only the settings function body restored to baseline,
the audit, lock, cache-corruption and invalid-settings regressions fail (4/4).
With only `projectExists` restored, the explicit-root preflight test fails on a
searchable but unreadable tracker. Restoring the baseline doctor implementation
and rebuilding makes its marker-only regression fail. Restoring the candidate
makes all seven SDK-adoption tests pass.

Exact commands and release-gate receipts are recorded on `pm-web-ireq`, related
to existing SDK-adoption items `pm-web-8pml` and `pm-web-cvny`. Coverage thresholds
are unchanged: statements/lines 92.07%, branches 80.5%, functions 94.59%.

## Verification receipts

Implementation commit `81c89aa` passed the complete CI matrix:
[CI run](https://github.com/unbraind/pm-web/actions/runs/40225837893).

| CI runtime | Functional tests | Statements / lines | Branches | Functions |
| --- | --- | --- | --- | --- |
| Node 22, npm release gate | 843/843 | 93.38% | 84.40% | 96.61% |
| Node 22, Bun release gate | 843/843 | 93.38% | 84.37% | 96.61% |
| Node 26, npm release gate | 843/843 | 93.38% | 84.37% | 97.26% |
| Node 26, Bun release gate | 843/843 | 93.39% | 84.41% | 97.26% |

All four gates retain the configured thresholds and include packed current and
minimum-host npm/Bun consumers (4/4 per gate), capacity checks (2/2 per gate),
production audit and release metadata checks. All 63 configured server source
files are measured; `src/tracker-preflight.ts` is 100% in every dimension.
CodeQL also passed. The pm-linked targeted suite passed 32/32.

The first local isolated npm gate is preserved as failed evidence: 843 total,
841 passed, one failed and one canceled. Built Presets acceptance exhausted its
unchanged 300-second budget; the following source acceptance returned
`spawn ENOTDIR`. This is the previously tracked `pm-web-qdhx` timing/cancellation
class. No catalog implementation, timeout or threshold was changed. Both
catalog scenarios pass in the unchanged retry and in the corrected local Bun
run. An initial isolated Bun checkout lacked its trusted base reference; that
setup-only run was invalidated, the base reference was restored, and all four
identity audits passed before restarting the full gate.

The corrected local isolated Bun release gate completed successfully: 843/843
functional tests, capacity 2/2, packed consumers 4/4, zero production audit
vulnerabilities, and all release metadata checks. Coverage was 93.39%
statements/lines, 84.41% branches and 97.26% functions.

The unchanged local isolated npm retry also completed successfully: 843/843
functional tests, capacity 2/2, packed consumers 4/4, zero production audit
vulnerabilities, and all release metadata checks. Coverage was 93.39%
statements/lines, 84.38% branches and 97.26% functions. Local commands were
`env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check`
and the equivalent `bun run release:check` in an isolated checkout with its own
test database. The earlier failure remains evidence of the open timing risk.

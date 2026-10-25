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

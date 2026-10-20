# Startup readiness regression evidence

Baseline: public package main at `5346b64`. Only package code, scratch trackers
and an isolated PostgreSQL test server were used.

## Observable behavior without database settings

`$port` below denotes a free scratch port. The first diagnostic lines are shown;
foreground startup prints its starting/Ctrl+C banner only after configuration
preflight succeeds.

| Command | Before exit / first diagnostic lines | After exit / first diagnostic lines |
| --- | --- | --- |
| `pm web --port $port --json` | 1 / `Server operation failed (private details redacted)` | 1 / `pm-web startup preflight failed:`; `DATABASE_URL is not set. pm-web requires PostgreSQL.`; missing `POSTGRES_HOST` and `POSTGRES_DB`, with export guidance |
| `pm web --detach --port $port --json` | 0 / `pm-web started on port ...` although the child dies | 1 / `Detached startup failed: child exited before becoming healthy.`; `pidfile: absent (no stale pidfile)`; last redacted child log lines |
| `pm web doctor --port $port --json` | 0 / `ok: true`, five checks without a database check | 0 / `ok: false`; database `configured: no; reachable: unchecked; schema version: unchecked`, with setting names and guidance |
| `pm web status --port $port --json` | 0 / `status: down` after false detached success | 0 / `status: down` after explicit failed startup; no stale pidfile |

The host currently labels detailed detached JSON errors `invalid_argument_value`;
the actionable child diagnostics remain in `detail`. This is a host error-labeling
UX gap, not a successful startup.

Doctor retains its existing diagnostic exit convention: consumers should inspect
`ok` and the named checks. Successful database checks report configured/reachable
and schema revision 1. An empty or incompatible database fails the schema check;
doctor does not apply migrations.

## Design

A first-import preflight validates database configuration, port, pool size,
startup deadline, production signing configuration and optional OIDC settings.
Its messages contain setting names and instructions, never configured values.
The ordinary generic-error redaction remains in place for arbitrary exceptions.

Detached startup requires IPC confirmation that its own child bound the port,
then a successful healthy JSON response. Its deadline defaults to 30000 ms;
`--startup-timeout` overrides `PM_WEB_STARTUP_TIMEOUT_MS` (range 1–300000).
The PID is published only after readiness. Failure terminates and joins the
child, reports the pidfile state, and includes at most ten lines from a bounded
log tail with connection strings and configured credentials redacted. Logs use
private file permissions and survive launcher exit.

Startup records schema revision 1 after the packaged idempotent migrations.
Doctor catches client-construction errors (including certificate options) without
printing their configured values. It checks configuration, a bounded real connection and that schema revision
without modifying the database. PostgreSQL URLs with a query-provided host are
accepted by the preflight and exercised against a real database and built server. The README describes PostgreSQL prerequisites
and plain-directory tracker operation without git.

## Initial implementation release checks

The final `npm run release:check` and `bun run release:check` both exited 0.
Each used a fresh HOME, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1` and an isolated UTF-8 PostgreSQL test database.
Hashes of all 393 runtime, test, schema and build inputs remained unchanged
through both sequential commands. Dependency pins, source scope, thresholds and
existing test deadlines were unchanged.

| Gate | Tests | Statements | Lines | Branches | Functions |
| --- | --- | --- | --- | --- | --- |
| `npm run release:check` | 699/699 | 92.61% | 92.61% | 81.55% | 95.97% |
| `bun run release:check` | 699/699 | 92.65% | 92.65% | 81.63% | 95.97% |
| Unchanged minimum | — | 92.07% | 92.07% | 80.5% | 94.59% |

Both runs reported all 44 required source files, zero test failures,
cancellations, skips or todo cases, capacity acceptance 2/2, packed consumers
4/4 (npm/Bun, pinned/minimum host), zero production audit vulnerabilities,
and successful typecheck, lint, duplication, docstrings, package dry run,
changelog, release-date and publish-attestation checks.
The separate native Bun detached start/health/stop acceptance also passed.

Earlier full attempts reproduced catalog deadline/cascade failures and graph
latency covered by `pm-web-qdhx` and `pm-web-hqqp`; one earlier fatal-output case
also reached its existing child deadline. Final full runs passed all of these
without changing their deadlines or lowering any coverage floor.

Host CLI observations: detailed detached runtime failures are labeled
`invalid_argument_value`, and source-directory installation reached its
10,000-entry scan cap. Packed archive installation and all four consumer
scenarios passed. These host UX gaps were observed rather than filed upstream.

## Tests and behavioral reverts

The focused suite runs real processes loading `dist/server.js` or the built
extension. It passed **13/13**, with no skipped or canceled tests, through:

```sh
node scripts/with-test-db.ts node --test test/startup-readiness.test.ts
```

The source-helper contracts additionally execute the lifecycle helper with a real
built child and the database diagnostic against real PostgreSQL. Focused source
coverage measures 100% statements, lines and functions for both helpers; branch
coverage remains below 100% and is reported by the full gate. Oversized child log
lines are tested with and without a final newline, including an independent
check that the private log really contains the synthetic credential.

It is also linked to `pm-web-onv4` and passed through `pm test --run --progress`
with source workspace and schema tracker context. The real CLI parser selection
is also linked to `pm-web-xo0i` and passed **1/1**. The detached selection is
linked to `pm-web-odwq` and `pm-web-xo0i`; each passed **4/4**. Test-result tracking
is disabled in the existing tracker, so the explicit receipts are in comments.

Each revert below restored only the relevant behavior, rebuilt with
`npm run build:server`, and ran the unchanged selected tests. Each exited 1;
fixed sources were restored and rebuilt afterwards.

| Behavior restored | Test selection in `test/startup-readiness.test.ts` | Result |
| --- | --- | --- |
| Old startup guard placement and generic diagnostics | `--test-name-pattern='foreground built\|built server reports every invalid'` | 0/2 passed; both regressions failed |
| Immediate detach spawn/unref/pidfile success | `--test-name-pattern=detached` | 0/4 passed; missing configuration, immediate health/live pidfile, timeout and unrelated-listener regressions failed |
| Doctor client construction outside the redacted diagnostic catch | `--test-name-pattern='doctor process'` | 0/1 passed; invalid certificate configuration regression failed |
| Camel-case parsed deadline lookup removed | `--test-name-pattern='real CLI\|detached unhealthy'` | 0/2 passed; real parser and normalized deadline regressions failed |
| Packaged SQL revision marker removed | `--test-name-pattern='doctor process'` | 0/1 passed; SQL-initialized database readiness failed |
| Log redaction removed | `--test-name-pattern='configuration validation'` | 0/1 passed; credential/connection-string privacy assertion failed |
| Incomplete oversized-line guard removed | `--test-name-pattern='redacted log tails'` | 0/1 passed; synthetic credential reached the diagnostic output |
| Source lifecycle restored to immediate success | `--test-name-pattern='source helper'` | 0/1 passed; missing-database startup falsely succeeded |
| Source database diagnostic restored to blind success | `--test-name-pattern='source database'` | 0/1 passed; missing configuration falsely passed |
| Valid query-provided PostgreSQL host rejected | `--test-name-pattern='source helper\|source database\|configuration validation'` | 0/3 passed; real startup, connectivity and configuration assertions failed |
| Doctor without the database check | `--test-name-pattern='doctor process'` | 0/1 passed; database diagnostic regression failed |

The SDK compatibility test creates a real tracker with `pm init` in a temporary
plain directory, explicitly sets its tracker path, sets
`GIT_CEILING_DIRECTORIES` to the temporary directory's parent and uses a `PATH`
with no git executable. SDK-dispatched create/get/update/list all pass. This is
acceptance of already-working behavior rather than a newly fixed no-git defect.

Reopening the two existing released items causes the required full changelog
regeneration to omit their former historical entries. History records remain
append-only; the generated changelog is retained exactly as checked by the gate.

## PR 230 review round

All comments in both unresolved review threads were read, including pagination
receipts confirming no omitted threads or comments. The latest CodeRabbit review
had no outside-diff findings. Both findings were valid.

| Thread or finding | Fix |
| --- | --- |
| `PRRT_kwDOSZgR5c6uZXBh` | Match the pool and doctor's truthy `DATABASE_URL` selection. An empty value falls back to discrete settings. Permit an omitted database path so `pg` can apply its database defaults. Keep whitespace-only values invalid, matching the runtime's URL selection. |
| `PRRT_kwDOSZgR5c6uZXB1` | Preserve non-production OIDC soft-disable behavior while retaining production configuration refusal. |
| Orchestrator: premature foreground banner | Run the shared configuration preflight with the effective port before printing either foreground progress line. The child still independently validates its own configuration. |
| Self-review: empty optional numeric settings | Preserve runtime defaults for empty port, pool-size and startup-timeout environment settings. Share discrete PostgreSQL port resolution between validation, pool and doctor. Explicit invalid flags and nonempty invalid numeric values still fail. |

Whole-PR self-review checked the configuration consumers, server bootstrap,
doctor, detached readiness, and progress/success output for the same defects.
The database fix also applies to the source assertion, doctor and detached child
through their shared validator. Detached success already follows child-owned
readiness. The additional empty-numeric-settings defect is fixed as listed above.

New real-process regressions exercise empty-URL discrete fallback and an omitted
database path with `PGDATABASE`, through both built startup and doctor. OIDC tests
cover incomplete and invalid settings in development and test, production
refusal, and unset `NODE_ENV`. The actual CLI runs `web --json` in a non-git
temporary tracker and must fail without either foreground progress line. Valid
preflight still prints progress when a later bind operation fails.
Empty numeric settings are exercised in source validation and real built
detached startup, with explicit invalid-value and invalid-flag controls.

Each independent behavioral revert rebuilt the server and ran the unchanged
selection below. Every failure was the intended assertion, with no timeout,
cancellation or skip. Fixed sources were restored and rebuilt afterwards.

Base command: `node scripts/with-test-db.ts node --test
--test-name-pattern="PATTERN" test/startup-readiness.test.ts`.

| Reverted behavior | Pattern | Reverted result |
| --- | --- | --- |
| Treat empty `DATABASE_URL` as supplied | `database preflight` | 0/1 passed; exit 1 |
| Require database path in URL | `database preflight` | 0/1 passed; exit 1 |
| Make non-production OIDC soft-disable fatal | `OIDC preflight` | 0/1 passed; exit 1 |
| Remove foreground preflight before banner | `foreground built\|real CLI` | 0/2 passed; exit 1 |
| Reject empty optional numeric environment settings | `empty optional numeric` | 0/1 passed; exit 1 |
| Reject empty discrete PostgreSQL port | `empty optional numeric` | 0/1 passed; exit 1 |
| Reject empty startup-timeout environment in launcher | `empty optional numeric` | 0/1 passed; exit 1 |

The existing bootstrap lifecycle test now requires an actionable foreground
configuration error for a missing JWT secret. It restores valid signing
configuration before independently proving that a missing source-wrapper child
still propagates a numeric child-exit error. This keeps refusal-before-spawn and
actual child failure as separate assertions. The focused lifecycle selection
passes 1/1; reverting only the foreground preflight and rebuilding makes it fail
0/1 with exit 1. Command: `node scripts/with-test-db.ts node --test
--test-name-pattern="the extension starts, probes" test/server-bootstrap.test.ts`.

### Review-round release gates

[CI run 39458568307](https://github.com/unbraind/pm-web/actions/runs/39458568307)
passed both complete release commands on source head `9415541`, with fresh HOME
and isolated Git identity in each job. Committed dist matched a fresh build.
Both Node versions also passed strict tracker health with the pinned managed
extension, and CodeQL passed on the same head.

| Node | Full command | Tests | Statements | Lines | Branches | Functions |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | `npm run release:check` | 703/703 | 92.63% | 92.63% | 81.69% | 95.12% |
| 22 | `bun run release:check` | 703/703 | 92.66% | 92.66% | 81.71% | 95.12% |
| 26 | `npm run release:check` | 703/703 | 92.61% | 92.61% | 81.64% | 95.98% |
| 26 | `bun run release:check` | 703/703 | 92.63% | 92.63% | 81.69% | 95.98% |
| Unchanged minimum | | | 92.07% | 92.07% | 80.5% | 94.59% |

Every gate reported all 44 required source files, zero failed/canceled/skipped/todo
tests, capacity acceptance 2/2, packed consumers 4/4, zero production audit
vulnerabilities, zero duplication and 764 documented declarations. Type checks,
lint, package contents, changelog, release-date and publish-attestation checks
also passed. Coverage scope, thresholds, dependency pins and repository test
deadlines are unchanged.

The linked startup suite passed 16/16 before the additional numeric case; linked
numeric and corrected bootstrap selections each passed 1/1. The final full suites
include all 17 startup tests and the corrected bootstrap test. Eight independent
behavioral reverts failed nine selected cases as intended. No revert proof relied
on a timeout or cancellation.

The original linked run reached its default outer 120-second command timeout;
the unchanged suite passed on retry with `--timeout 600`. A local full run hit
the known catalog 300-second timeout/cascade and graph latency failures tracked
by `pm-web-qdhx` and `pm-web-hqqp`; it was interrupted after CI exposed the stale
bootstrap expectation. Those catalog and graph cases pass in both final CI
runtimes. The genuine bootstrap assertion mismatch was corrected while retaining
the separate missing-child failure assertion. The initial duplicated test setup
was extracted into fixture helpers; the unchanged zero-duplication gate passes.

The final evidence update preserves the 261 recorded runtime/test/build inputs
and committed dist from `9415541`; it changes only pm records and this document.
Local strict health separately reports an installed-extension version skew and
stale active-item warnings; fresh CI uses the pinned extension and passes health.
No new pm CLI/SDK defect was identified in this round.

## Outside-diff configuration documentation review

The next complete review read found zero unresolved inline threads and no
pagination gaps. CodeRabbit review `PRR_kwDOSZgR5c8AAAABTR3jXw` reports one
outside-diff finding at `README.md:144` (fingerprint
`158f0c65fd1f0464cbb39328`). The environment table incorrectly required
`DATABASE_URL`, although the setup text, validator, pool and doctor support
`POSTGRES_HOST` plus `POSTGRES_DB` instead. The table now lists both methods as
alternatives and documents the optional discrete port and credentials.

Whole-diff self-review found two more instances of misleading requirement
wording: the table made `JWT_SECRET` unconditionally required and described
optional OIDC validation as unconditionally strict. It now describes production
signing requirements and OIDC soft-disable outside production, consistent with
the existing runtime and startup regressions.

`node --test test/startup-docs.test.ts` passes 3/3 directly and through
`pm test pm-web-onv4 --run --progress --only-last`. The contracts compare the
table with actual validator results for alternative and incomplete database
settings, production signing configuration and partial OIDC settings.

Each independent revert restores only its original README table row, retaining
the fixed tests and all other changes. No build is needed for these documentation
reverts. Each command below fails its intended assertion with exit 1, zero passed
and one failed test, without timeouts, cancellations or skips. Fixed documentation
was restored after each proof, then the full docs suite passed 3/3 again.

| Reverted row | Exact command |
| --- | --- |
| `DATABASE_URL` required unconditionally | `node --test --test-reporter=tap --test-name-pattern="README database" test/startup-docs.test.ts` |
| `JWT_SECRET` required unconditionally | `node --test --test-reporter=tap --test-name-pattern="README signing" test/startup-docs.test.ts` |
| OIDC validation unconditionally strict | `node --test --test-reporter=tap --test-name-pattern="README OIDC" test/startup-docs.test.ts` |

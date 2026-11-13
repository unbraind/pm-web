# Project storage removal

Project deletion keeps the storage pin selected at admission: the physical workspace and tracker, the physical parent, and the leaf device/inode captured by `lstat`. Validation also checks that the logical parent still names that physical parent. Validation paths are read-only; removal never uses them. Discovery remains asynchronous and bounded. Missing entries, dangling links and symlink loops keep their lexical fallbacks.

Changed call sites:

- `src/routes/projects.ts`: `removeOwnedProject`, shared by DELETE and failed-initialization cleanup, passes its admission pin through eviction and removal. Its row transaction and workspace queue remain held through commit or rollback.
- `src/services/pm-runner.ts`: `pinWorkspaceStorage` captures entry identity; `evictPmClient` accepts that pin; `assertPinnedProjectEntry` verifies it before eviction and again afterwards; `deleteProjectDir` removes only through the captured physical parent. A changed or unprovable identity that is visible at the check refuses before filesystem mutation and retains the row for retry. The check is not atomic with the removal: a writer that can modify the captured physical parent could replace the leaf between the final identity check and `rm`. Node has no inode-bound recursive removal, so closing that window needs an fd-relative mechanism that this package does not have; the guarantee covers ancestor retargeting and swaps that happen before the final check.
- `scripts/capacity-fixture.ts`: fixture teardown and failed-setup cleanup evict the captured project and remove the captured temporary root. An eviction refusal still permits independent synthetic-row cleanup, while removal has its own identity check.

Remaining destructive calls on project storage:

| Call | Safety condition |
| --- | --- |
| `deleteProjectDir`: `fs.promises.rm(target, { recursive: true, force: true })` | Target is the captured physical parent plus leaf; parent and leaf device/inode and workspace/tracker identities are checked after eviction. It is used only for a non-symlink entry. |
| `deleteProjectDir`: `fs.promises.unlink(target)` | Same captured parent and leaf checks; a leaf symlink is unlinked without traversing its target, including dangling links and loops. |
| Project-storage `rename` | None in production. Tests rename only their disposable fixture entries to exercise replacement and retargeting. |

Other removal calls are outside project directories: `src/health.ts` unlinks reserved, random `.healthz-*.tmp` root probe files without recursion; launcher modules remove their own PID files. Browser, public-tracker, packed-package and differential scripts remove roots they exclusively create with `mkdtemp`; build and coverage scripts replace generated outputs. These do not remove an admitted project directory or tracker.

The isolated tracker-fixture cleanup sites are `scripts/agent-context-browser.ts`, `scripts/decision-inbox-browser.ts`, `scripts/graph-scale-browser.ts`, `scripts/permission-impact-public-data.ts`, `scripts/sdk-adoption-differential.ts`, `scripts/read-fleet-commands.ts`, `scripts/public-tracker-copy.ts` and `scripts/accept-packed.ts`. Each removes only its exclusive `mkdtemp` root. The packed acceptance script also unlinks deliberately removed synthetic evidence files below its own isolated scenario cwd. `scripts/brand-browser.ts` owns a separate temporary static-file root. None accepts a project path from a request or a queued admission.

The regression corpus uses the disposable PostgreSQL wrapper and real SDK trackers. It retargets an ancestor during a deferred real-filesystem eviction lookup and compares both storage trees byte for byte, including inode identities; a second case replaces the leaf inode during that lookup. Refused deletes retain their rows. Normal deletes, leaf-symlink unlinking and a retry after a refused eviction remain allowed.

## Validation commands

Every command is capped at 1,200 seconds. The importer gate uses at most two workers and the disposable test database; the full release matrix is left to CI.

```sh
timeout 1200s node scripts/with-test-db.ts node --test --test-reporter=tap --test-concurrency=2 test/authorized-project-reads.test.ts test/capacity-cli.test.ts test/capacity-setup.test.ts test/capacity-trace.test.ts test/capacity.acceptance.ts test/capacity.test.ts test/decision-inbox-routes.test.ts test/decision-inbox.test.ts test/graph-export-fidelity.test.ts test/graph-no-git.test.ts test/graph-provision-pin.test.ts test/graph-provision.test.ts test/graph-read-only.test.ts test/history-read-gate.test.ts test/idempotency-access.test.ts test/idempotency.test.ts test/identity-audit.test.ts test/item-history-at.test.ts test/item-history-projection.test.ts test/maintenance-providers.test.ts test/mutation-replay.test.ts test/packaging.test.ts test/pm-collaboration.test.ts test/pm-command-access.test.ts test/pm-route-cli-contracts.test.ts test/pm-runner.test.ts test/pm-schema-history-routes.test.ts test/presence-joinstorm.test.ts test/projects-routes.test.ts test/realtime-delivery.test.ts test/resume-packets.test.ts test/sdk-adoption.test.ts test/sse-fanout-resume.test.ts test/startup-readiness.test.ts test/workspace-alias.test.ts
timeout 1200s npm run build
timeout 1200s npm run build:test
timeout 1200s npm run typecheck
timeout 1200s npm run lint
timeout 1200s npm run duplication
timeout 1200s npm run docstring
timeout 1200s node_modules/.bin/pm health --strict-exit
timeout 1200s node_modules/.bin/pm validate --check-history-drift --check-storage-integrity --strict-exit
timeout 1200s npm run changelog:check
```

After committing the generated output, repeat CI's freshness check: remove the generated `dist/` directory, run the full build, and require an empty `git status --porcelain=v1 --untracked-files=all --ignored=matching -- dist/`. A disposable baseline rebuild independently reproduces the previous stale-artifact failure: the compiled route gains the storage-identity guard that its committed JavaScript lacked.

## Pool and tracker queue nesting audit

- `src/routes/projects.ts:removeOwnedProject` (DELETE and failed-init cleanup): short `pool.query` discovery finishes and releases its lease, then `runSerialized`, then `pool.connect`, BEGIN, row lock and owner/slug/storage revalidation, pinned removal, row deletion, COMMIT/ROLLBACK, client release, queue release. No checked-out connection crosses admission.
- `src/services/authorized-project-reads.ts:readAuthorizedProject`: initial authorization queries release before `runOnPinnedStorage`; inside the queue each access query uses a short independent `pool.query`. No connection is retained across queue admission or SDK reads.
- `src/services/pm-runner.ts`: `initProject`, `readPinnedProjectExtensionStates`, `runExtensionCommand`, `readProjectCommandOwners`, `readCompletePmItems`, `runPm` and `runGetItemAt` enter `runSerialized` or `runOnPinnedStorage` without a database connection. Their filesystem/SDK/process callbacks do not check out SQL clients. There is no function named `withTrackerQueue` in the package; these are its tracker queue entry points.
- `src/routes/groups.ts`: connect, BEGIN, SQL on that same client, COMMIT/ROLLBACK, release; no tracker queue or external wait.
- `src/routes/oidc.ts` and `src/oidc.ts:resolveExternalIdentity`: provider network work finishes before connect; identity transaction, advisory/row locks and queries all use the supplied client, then release. No tracker queue or second pool checkout inside those locks.
- `src/services/permission-impact.ts:previewPermissionImpact`: connect, read-only SQL snapshot, direct observational SDK `listAllComplete` and runtime contract reads with extensions disabled, COMMIT/ROLLBACK, release. These SDK reads do not enter the package tracker queue or request another pooled connection.
- `src/services/realtime-bus.ts:startRealtimeBus`: one dedicated LISTEN connection; notification callbacks deliver events synchronously, without entering a tracker queue. Publishing uses separate short queries and does not await admission while holding a query lease.

The pool regression starts a real realtime listener with `PM_WEB_DB_POOL_MAX=2`. A deferred authorized read owns the tracker queue while deletion joins it; both an unrelated HTTP read and the held read's final authorization must complete within 1,500 ms, below the pool's 5,000 ms timeout. Removing the queue-before-connection change independently fails both assertions. Row removal, owner change and slug change between enqueue and lock retain all tracker bytes and answer 404/409. Existing normal-delete and ancestor-retarget cases remain in the route corpus.

Current queue-before-connection importer gate (including the two-slot pool child corpus):

```sh
timeout 1200s node scripts/with-test-db.ts node --test --test-reporter=tap --test-concurrency=2 test/authorized-project-reads.test.ts test/capacity-setup.test.ts test/decision-inbox-routes.test.ts test/decision-inbox.test.ts test/graph-export-fidelity.test.ts test/graph-no-git.test.ts test/graph-provision-pin.test.ts test/graph-provision.test.ts test/graph-read-only.test.ts test/history-read-gate.test.ts test/idempotency-access.test.ts test/idempotency.test.ts test/identity-audit.test.ts test/item-history-at.test.ts test/item-history-projection.test.ts test/maintenance-providers.test.ts test/mutation-replay.test.ts test/packaging.test.ts test/pm-collaboration.test.ts test/pm-command-access.test.ts test/pm-route-cli-contracts.test.ts test/pm-runner.test.ts test/pm-schema-history-routes.test.ts test/project-delete-pool.test.ts test/projects-routes.test.ts test/realtime-delivery.test.ts test/sdk-adoption.test.ts test/startup-readiness.test.ts test/workspace-alias.test.ts
```

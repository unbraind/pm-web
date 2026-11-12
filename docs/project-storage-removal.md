# Project storage removal

Project deletion keeps the storage pin selected at admission: the physical workspace and tracker, the physical parent, and the leaf device/inode captured by `lstat`. Validation also checks that the logical parent still names that physical parent. Validation paths are read-only; removal never uses them. Discovery remains asynchronous and bounded. Missing entries, dangling links and symlink loops keep their lexical fallbacks.

Changed call sites:

- `src/routes/projects.ts`: `removeOwnedProject`, shared by DELETE and failed-initialization cleanup, passes its admission pin through eviction and removal. Its row transaction and workspace queue remain held through commit or rollback.
- `src/services/pm-runner.ts`: `pinWorkspaceStorage` captures entry identity; `evictPmClient` accepts that pin; `assertPinnedProjectEntry` verifies it before eviction and again afterwards; `deleteProjectDir` removes only the captured physical entry. A changed or unprovable identity refuses before filesystem mutation and retains the row for retry.
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

# Observable real-time synchronization after catalog PR #197

Merged main `06958bd` into PR #199 without conflicts after completing PR #196. SDK remains pinned to `2026.10.13`; SDK `2026.10.14` remains separately owned by PR #196. This synchronization adds the catalog fix and validation evidence. No new observability implementation or regression was introduced; existing behavioural revert proofs for watcher delivery, request middleware, stale watcher health, fatal stdout flushing, duplicate SSE clients and explicit log-level fixtures remain applicable.

## Validation

Both release commands use fresh HOME, unset PM_PATH/PM_AUTHOR/PM_ROOT, disabled global/system Git configuration, canonical fleet context through PM_FLEET_ROOT, and disposable real PostgreSQL. Thresholds remain 90% statements/lines, 79% branches and 92% functions. Presets acceptance retains its 300-second deadline.

| Command | Tests | Passed | Failed | Cancelled/skipped/todo | Exit |
| --- | ---: | ---: | ---: | --- | ---: |
| `npm run release:check` | 591 | 591 | 0 | 0/0/0 | 0 |
| `bun run release:check` | 591 | 591 | 0 | 0/0/0 | 0 |

Both first attempts passed completely. No known load flake occurred and no retry was needed. Built/source Presets acceptance took 100.079/92.826 seconds under npm and 93.896/99.254 seconds under Bun. Canonical catalog assertions all passed.

Coverage accounts for all 36 configured source files: npm 90.83% statements/lines, 81.57% branches, 93.77% functions; Bun 90.83% statements/lines, 81.56% branches, 93.77% functions. Each complete gate passed typechecks, lint, zero duplication, docstrings (97 files/646 declarations), production audit (zero vulnerabilities), pack dry-run, all four actual packed npm/native-Bun pinned/minimum-host scenarios, changelog check, release-date verification and publish-attestation verification.

The pm-linked observability and real-server HTTP SSE/privacy tests passed 10/10. Tracker history-drift and storage-integrity validation passed without warnings. The item remains in progress and its claim is released for orchestrator verification. No PR merge, release, publication, hosted-data access or deployment occurred.

```sh
env -u PM_PATH -u PM_AUTHOR -u PM_ROOT HOME=$(mktemp -d) GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check
env -u PM_PATH -u PM_AUTHOR -u PM_ROOT HOME=$(mktemp -d) GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun run release:check
node scripts/with-test-db.ts node --test test/observability.test.ts test/observable-realtime.test.ts
```

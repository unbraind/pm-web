# PM CLI/SDK 2026.10.4 certification

Owner: [pm-web-8pml](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-8pml.toon). Reused the existing open certification chore; its dated history remains intact. Prerequisite PR #163 was rebased, independently gated at 409/409, lease-pushed, reviewed and merged by the orchestrator as `86c31b1`; this branch starts from that new main.

## Consolidated updates

Runtime CLI stays exact **2026.10.4**, with the existing matching extension floor. pm-ops, pm-changelog and managed pm-github are **2026.10.4**. All development dependencies are exact, including jscpd **5.4.0**, types/node **26.6.4**, TypeScript **7.0.2**, tsx **4.23.15**, eslint **10.12.0**, Babel parser **8.0.6**, syntax plugin **8.0.3**, and yaml **2.9.1**. Runtime pg **8.23.1** is within the updated declared range. Incorporates pending Dependabot #162, #164, #165 and #166, including exact CodeQL SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` with its **v4.38.2** comment.

The merge-driver launcher is copied byte-for-byte from the installed pm-ops template. Its malformed lookup regression fails the old launcher and passes the published replacement. Updated the reviewed CodeQL allowlist without weakening its exact-SHA assertion. Regenerated the 20-extension fleet snapshot through the existing online generator after the canonical pm-ts-starter SDK description changed; no package or catalog entry was omitted.

Packed acceptance found that project creation beneath an ancestor tracker refused implicit initialization. A regression executes the actual pinned CLI (only graph extension discovery is synthetic), fails before the fix, and now verifies the child prefix and byte-identical ancestor settings. The runtime explicitly selects the new child workspace and non-interactive defaults with no force override. The packaged server build is regenerated.

## Gates and boundaries

Every heavy command runs under `flock /tmp/claude-1000/heavy-gate.lock`.

- `npm install`, then clean `npm ci`: pass; lock reproduces pinned dependencies.
- `bun install --no-save`: pass. This repository has no tracked Bun lock; removed only the newly generated scratch lock.
- `node --test test/prepare-merge-driver.test.ts`: **7/7 pass**, zero skips.
- `PM_FLEET_ROOT=<canonical fleet root> node --test test/workflow-security.test.ts test/catalog.test.ts`: **15/15 pass**, zero skips.
- `node --test --test-name-pattern=project.initialization.selects test/pm-runner.test.ts`: **1/1 pass**, zero skips, actual pinned CLI.
- `pm test pm-web-8pml --run --only-index 3 --progress --json`: linked `env -u PM_PATH npm run release:check`, source workspace and tracker context, explicit canonical PM_FLEET_ROOT: **411/411 pass**, zero skips.
- Full gate uses an isolated temporary native PostgreSQL **17.10** cluster, stopped and deleted afterwards. No Docker or hosted service is used.
- Duplication: **0/40,537 lines, 142 sources, zero clone pairs**, unchanged zero threshold.
- Coverage: **84.49% lines / 80.60% branches / 77.82% functions**, 32 configured application source files. Existing 79/79/75 thresholds remain unchanged; statements are unmeasured. Whole-source quality owner **pm-web-fy9a** remains open.
- Fresh `rm -rf dist` + `npm run build`: pass; commit regenerated server artifacts. Frontend build passes.
- `npx pm health --strict-exit --require-merge-drivers`: exit zero; stale-item advisories remain separate from failures.
- `npm audit --omit=dev`: clean; GitHub open Dependabot alerts: zero.
- `npm audit`: **four high development entries**, still blocked through unpatched braces/micromatch/fast-glob/pm-ops; owner [pm-web-xucb](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-xucb.toon). No compatible patched braces3 release exists. Removing the unused repository fast-glob dependency was independently attempted in pm-graph: it makes audit clean but breaks canonical pm-ops10.4 duplication, which statically imports its declared optional fast-glob peer. This duplication consumer must supply that peer. No forced downgrade, audit suppression or gate exception was added.

The first gate failed the old action allowlist and stale snapshot (408/410); those failures are preserved and fixed. An initial linked scoped run omitted PM_FLEET_ROOT and correctly refused the worktree inventory. Initial linked audit runs encountered runner-injected EALLOWSCRIPTS; direct audits and child-scoped environment-cleaned receipts distinguish execution failure from actual vulnerabilities. None of these failures counts as a passing receipt.

## Packed real-tracker acceptance

Copied this repository’s `.agents/pm` to `/tmp/claude-1000/cert-wt/pm-web-dogfood/.agents/pm`, ran `npm pack`, installed the tarball with `npm install --save-exact <archive> @unbrained/pm-cli@2026.10.4`, then `npx -y @unbrained/pm-cli@2026.10.4 package install <archive> --project`.

For both launchers `npx -y @unbrained/pm-cli@2026.10.4` and **native Bun** `bunx --bun @unbrained/pm-cli@2026.10.4`, ran on separately allocated ports:

```sh
<launcher> web doctor --port <port> --json
<launcher> web status --port <port> --json
<launcher> web --detach --port <port> --json
<launcher> web status --port <port> --json
<launcher> web stop --port <port> --json
<launcher> web status --port <port> --json
```

Both doctor checks report OK; status transitions DOWN → UP/healthy → DOWN. Each CLI launches the documented packaged Node server, using the acceptance-owned database, projects directory and PID files. A synthetic local account and project exercise the actual registration/project APIs. Copied the real tracker into that project; authenticated board, export and observational graph reads include **all 132 lifecycle items**, including the certification owner. An independent `list --all --full --include-body` with unbounded output supplies the baseline. npm/Bun export item values match deeply, and tracker documents/history/settings remain byte-identical around the observational reads. The first comparison mistakenly used the default open-only baseline (21); correcting it to `--all` retained the complete 132-item assertion.

Stopped both acceptance servers and the native database, and deleted the scratch projects/tracker. This does not attest hosted deployment, live identity providers, tenant isolation, realtime recovery/scale, external services or privacy issue #96.

## Managed GitHub preview

Installed managed **pm-github 2026.10.4** and added CI restoration of that exact verified extension. `npx pm github sync --repo unbraind/pm-web --dry-run` exits zero: no provenance-linked cases, `synced: 0`, `skipped: 0`, `planned: 0`. No issue writes or scheduled sync.

Certification remains **NOT READY** while the full-development audit and required reviewer evidence remain open. The orchestrator owns merge, item closure and any separate deployment.

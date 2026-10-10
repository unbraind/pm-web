# SDK 2026.10.10 exact-tree receipts

These executed receipts identify source `01b82d6` and frozen metadata head
`df2e7aa6ae0469965bf2e858027d60a250fd0329`. The later review follow-up changes
only documentation and the paired 8pml/xucb tracker histories. The inventory
below remains the immutable tested-tree inventory, rather than claiming that
its digest describes the later documentation edits. Runtime source, tests,
gates, package metadata, lockfile and all 262 archived files are unchanged.

At tested head `df2e7aa6ae0469965bf2e858027d60a250fd0329`, source commit
`01b82d6f111b80b0b1412abb0707f79c3b1bd44e` was followed by the original receipt
and pm-web-8pml metadata under author `codex-sol-8pml-20261010`. That original
renewal touched only the SDK owner. Later review follow-ups update documentation
and the paired pm-web-8pml/pm-web-xucb records under author `codex`; they are
identified separately in Git history and the PR. Claims remain released and all
items remain unclosed. Runtime, tests, gates and distribution bytes are unchanged.

Frozen inventory: `613` paths, byte SHA-256
`2ed20c143671f2b08370444b01f7b3fc94b666c76e837343ba5a94c76689bb3c`. Inventory artifact SHA-256:
`635ac25e59b8ea578990e49773e92c9367a6518b79c2b13397854f1cb56da9fa`.
The inventory contains each relative path, Git blob SHA-1 and file SHA-256.
At tested head `df2e7aa6ae0469965bf2e858027d60a250fd0329`, only the original
pm-web-8pml TOON/history, inventory itself and this receipt are outside its
recursive digest. The inventory is committed and separately hashed. The
original source-to-tested-head metadata delta contains this receipt and paired
SDK-owner metadata. Later documentation and paired 8pml/xucb updates have
separate byte-comparison receipts; the frozen inventory does not certify their
metadata bytes. Runtime, tests, gates, package/lock and all 262 archived files
retain their tested bytes. Fresh builds at the tested tree reproduced the
committed distribution bytes.

Both unchanged release links run on the exact source commit. Original limits
remain 1800 seconds (link 7) and 2400 seconds (link 3); packed commands retain
five-minute deadlines and the graph retains its 10000 ms operation limit.
Canonical fleet selection is explicit. The existing shared flock serializes
heavy checks. Fresh native PostgreSQL 17.10 uses only a disposable cluster with
existing schema, HTTP/SSE and workspace helpers, stopped and removed afterward.
Node 24.19.0 runs server coverage, collaboration and graph cases; native Bun
1.3.5 runs the packed extension and standalone SDK cases. npm is 11.17.0.
These receipts do not certify a Bun-hosted server, deployment or production load.

| Linked command (pm-web-8pml) | Result | Runner elapsed |
| --- | --- | --- |
| 7: `env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm run release:check` | 492/492, skips 0; exit 0 | 440995 ms |
| 3: `env -u PM_PATH npm run release:check` | 492/492, skips 0; exit 0 | 591292 ms |
| 8: `node scripts/with-test-db.ts node --test test/pm-collaboration.test.ts` | 6/6, skips 0; exit 0 | 16014 ms |
| 9: `node scripts/with-test-db.ts node --test test/graph-export-fidelity.test.ts test/graph-read-only.test.ts` | 6/6, skips 0; exit 0 | 66717 ms |
| 6: `node --test test/packaging.test.ts test/sdk-update-automation.test.ts` | 5/5, skips 0; exit 0 | 1452 ms |
| 10: `env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS npm audit --json` | Exit 1, four high development audit entries; existing debt remains open | 2380 ms |

## Coverage and selected documentation scope

Release link 7: all 34 configured server files reported. statements 10323/11430 (90.31%), 1107 uncovered; lines 10323/11430 (90.31%), 1107 uncovered; branches 1765/2205 (80.04%), 440 uncovered; functions 256/274 (93.43%), 18 uncovered; report SHA-256 `44330a63c342794f6168adf5fbb0413adf881329d28e31794bd6a26e921fe703`.

Release link 3: all 34 configured server files reported. statements 10331/11430 (90.38%), 1099 uncovered; lines 10331/11430 (90.38%), 1099 uncovered; branches 1773/2211 (80.18%), 438 uncovered; functions 256/274 (93.43%), 18 uncovered; report SHA-256 `62dca8b9b89475d9d2de1ac2887a94c33b2d12d03c2cc79eb9f98095bd47319a`.

Coverage is PARTIAL: browser and tooling source remain outside the unchanged
`src` denominator. Thresholds remain S/L 90, B 79, F 92, no ignore entries.
Statements/lines are c8/V8 reporter counters. Both releases retain selected
95-file / 625-declaration docstring scope, excluding tests, dependencies and
compiled output. This is not whole-source or whole-documentation certification.
Duplication remains 0/45033 lines, 156 sources, zero clone pairs, zero threshold.
The original owner acceptance text is retained with only SDK-version renewal;
its clean-both-audits requirement remains unmet. Production audit is zero; the
real development audit fails on four high entries
through braces, fast-glob, micromatch and pm-ops. Existing pm-web-xucb remains open.

## Actual packed archive and runtime bounds

Both release runs use byte-identical actual acceptance archives, captured read-only
while the existing consumer checks execute: 681064 bytes, package
2026.10.9, standalone dependency SDK 2026.10.10. The package version intentionally
differs from the SDK dependency pin; this document title names the SDK renewal,
not a package release.

SHA-256: `e903c1d65775bd1089bbfda7f478c158405bcf271eb114688b45bcf9c49b0b9e`.

SHA-1: `3e99861dba0acaf6e80ceba9a009ea9f43f9c5e0`.

Npm integrity: `sha512-roOYeZMgagVGPKOqWP99qVJOJWC1dn27H5iGcgIT3arqPy1Rl4TWZs8iq72mvOMLZ/nauDgKhuqzE/vrgOrR+w==`.

| Scenario | Host | Standalone SDK | Status / port |
| --- | --- | --- | --- |
| npm-current | 2026.10.10 | 2026.10.10 | down / 61113 |
| bun-current | 2026.10.10 | 2026.10.10 | down / 61114 |
| npm-minimum | 2026.10.4 | 2026.10.10 | down / 61115 |
| bun-minimum | 2026.10.4 | 2026.10.10 | down / 61116 |

All original version/config/status/port, diagnostic and installed catalog/card
assertions pass in each run. These checks do not start a service.

Link 7 measured graph reads: 2000 items, 3758 ms, 2022 nodes, 23063 edges.

Link 3 measured graph reads: 2000 items, 3111 ms, 2022 nodes, 23063 edges.

Link 9 measured graph reads: 2000 items, 1787 ms, 2022 nodes, 23063 edges.

All six genuine PostgreSQL collaboration cases pass without skips in both full
suites and the separate linked run. HTTP/SSE concurrent edits, replay silence,
graph nonmutation, watcher fanout, presence access and lifecycle assertions are
preserved. Graph payload/order, queued/external-writer guards, GET/HEAD/neighbors
permissions, discovery order and catalog metadata remain unchanged. These are
bounded disposable fixtures, not privacy, capacity, tenant isolation or recovery
certification for hosted resources.

## Histories, freshness and retained failures

All 152 starting history-file byte prefixes are preserved. The SDK owner's
original prefix is 98 events / 163816 bytes, SHA-256
`fd0eb9eda8d70f91a9ac3c570794674d6f02b8495ed75e26b91d0691f448e0bb`.
At the tested head, eleven related owner chains verify strictly with matching
latest/current hashes; only the SDK owner changed in that renewal. Subsequent
review follow-ups update both 8pml and xucb, with their paired histories verified
separately. The original claim release precedes source freeze and the
package-owned `npm run changelog:full`; regenerated changelog bytes are unchanged.
Strict pinned health passes with 13 stale-item advisories; validation returns
`ok: true` with existing metadata, resolution, file-link and trust warnings.

Tested-head SDK-owner strict history: 114 events, item hash
`7c07a23f324ab748143c7055275f47c9e595d74dfddf96e10c717d2ab3998507`, latest/current match.

Raw outputs and deadlines remain local; tracked receipts contain hashes and
sanitized measurements. Previous 481/494 failures, native npm launcher failure,
linked coverage timeout and rejected 15811 ms graph run remain dated in
[sdk-update-automation.md](sdk-update-automation.md). The initial attempt at the older 2400-second link was refused before execution
for foreign branch provenance (CLI exit 5, linked result exit 1, trust_refusal).
Its raw receipt is retained separately. After reviewing the exact command,
clone-local acknowledgement records trust without running or marking tests
passed; the subsequent fresh linked run must supply actual execution evidence.
The first acknowledgement invocation was rejected (exit 2) because a
selection flag required --run; it executed no test. The corrected whole-item
acknowledgement follows review of every existing linked command. No ownership,
project policy, source bytes or deadline is changed by that acknowledgement. The full-development audit failure remains explicitly open.
No dependency-only source revert proof is claimed. Whole-source, whole-docs,
privacy, scale, required review and hosted readiness remain open. No Docker,
hosted data/config, telemetry, deployment, merge, release, publication, GitHub
comment, bot request or PR-description change occurs.

| Receipt | UTC start / end | Raw decoded output SHA-256 |
| --- | --- | --- |
| Final link 7 | 2026-10-10T16:44:12Z / 2026-10-10T16:51:34Z | `1e12aaf9b54928afdae866daf76bdd76a4a48253e8409758431a79e99f375a27` |
| Final link 3 | 2026-10-10T16:54:12Z / 2026-10-10T17:04:05Z | `9f1359e8d45c57f41a74985bece79e05246c3de16f3c91057015b5f228d1df84` |
| Final link 8 | 2026-10-10T16:51:35Z / 2026-10-10T16:51:52Z | `4535cfb999a166d3ada8996b2df83d07f2e7408648a03a91cc37d5df2fed7497` |
| Final link 9 | 2026-10-10T16:51:52Z / 2026-10-10T16:53:00Z | `d421891f0bbc0b523e26fbe57914d85c5c8fc13a0f55135adba005b05b2078bb` |
| Final link 6 | 2026-10-10T16:53:00Z / 2026-10-10T16:53:03Z | `4f5184165ece5f735811f936e7b96796e9c2fe8844854f3a979f12ee6eeccdab` |
| Final link 10 | 2026-10-10T16:53:03Z / 2026-10-10T16:53:06Z | `2052509f35704051b62f6628c4dfbc1316d4e7ed99742fd0a8e110a3d7f6323a` |

Older-link pre-execution refusal JSON SHA-256: `cc0e1a1e43867e6b1c39ffa834d5e20d1a6e0c32320de91d40e6662af027b802`.

Clone-local command-review acknowledgement JSON SHA-256: `44b879e0005e1592854b86f8b41ddd1f184a5b906b374ce0b94a755b22995308`. This is trust evidence, not test execution.

| Accepted report | SHA-256 |
| --- | --- |
| Release link 7: coverage-summary.json | `44330a63c342794f6168adf5fbb0413adf881329d28e31794bd6a26e921fe703` |
| Release link 7: lcov.info | `963b2f807f4472d713726fd10bbe938c03a02287a3b6407d9c6381c3a711dc64` |
| Release link 7: coverage-final.json | `93303f074372fe95ec6f4c03d005e089bfd12b3312e723fea32da1d06d2c3869` |
| Release link 3: coverage-summary.json | `62dca8b9b89475d9d2de1ac2887a94c33b2d12d03c2cc79eb9f98095bd47319a` |
| Release link 3: lcov.info | `efb47fe1eccfce6e2db367a8e6f019f7088c0ea4c8d88cd894d769e6688b88c9` |
| Release link 3: coverage-final.json | `4ffbb59da11906178e093e1ab77497540333fc43d93cde3ea901871b33171842` |

Accepted canonical coverage file modification times after the final release
(measured, not rewritten):

- coverage-summary.json: 2026-10-10T17:00:50.380014+00:00, 10918 bytes.
- lcov.info: 2026-10-10T17:00:50.379014+00:00, 160040 bytes.
- coverage-final.json: 2026-10-10T17:00:50.382015+00:00, 1388529 bytes.

Installed root package declarations and versions after reproducible npm ci:

| Package | Declared | Installed |
| --- | --- | --- |
| @babel/eslint-parser | 8.0.6 | 8.0.6 |
| @babel/plugin-syntax-typescript | 8.0.3 | 8.0.3 |
| @types/cookie-parser | 1.4.10 | 1.4.10 |
| @types/express | 5.0.6 | 5.0.6 |
| @types/jsonwebtoken | 9.0.10 | 9.0.10 |
| @types/node | 26.6.4 | 26.6.4 |
| @types/pg | 8.23.1 | 8.23.1 |
| @types/uuid | 11.0.0 | 11.0.0 |
| @unbrained/pm-cli | 2026.10.10 | 2026.10.10 |
| bcryptjs | ^3.0.3 | 3.0.3 |
| c8 | 12.0.0 | 12.0.0 |
| cookie-parser | ^1.4.7 | 1.4.7 |
| eslint | 10.12.0 | 10.12.0 |
| express | ^5.2.1 | 5.2.1 |
| express-rate-limit | ^8.6.2 | 8.7.1 |
| fast-glob | 3.3.3 | 3.3.3 |
| jscpd | 5.4.0 | 5.4.0 |
| jsonwebtoken | ^9.0.2 | 9.0.3 |
| neo4j-driver | ^6.2.0 | 6.2.0 |
| openid-client | ^6.8.7 | 6.8.8 |
| pg | ^8.23.1 | 8.23.1 |
| pm-changelog | 2026.10.5 | 2026.10.5 |
| pm-graph | 2026.10.5 | 2026.10.5 |
| pm-ops | 2026.10.6 | 2026.10.6 |
| tsx | 4.23.15 | 4.23.15 |
| typescript | 7.0.2 | 7.0.2 |
| uuid | ^14.0.2 | 14.0.2 |
| yaml | 2.9.1 | 2.9.1 |

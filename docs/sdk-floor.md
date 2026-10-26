# Published pm SDK capability floor

Audited main: `ce79dd38d8429ee44ce347d79c0c3c74b58b04ca`. Required API floor: **2026.8.21**.

Declared host floor: `2026.10.4`. npm peer: `not declared`. Runtime npm dependency: `2026.10.20`. This standalone service resolves the SDK through that exact dependency; it does not declare a peer.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [src/services/decision-inbox.ts:2](../src/services/decision-inbox.ts#L2) |
| `@unbrained/pm-cli/sdk :: agentSessionEnvironment` | 2026.8.2 | 2026.8.1 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: assertInitializedTracker` | 2026.8.21 | 2026.8.20 | [src/tracker-preflight.ts:1](../src/tracker-preflight.ts#L1), [src/contract-explorer.ts:1](../src/contract-explorer.ts#L1) |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [src/agent-context-commands.ts:1](../src/agent-context-commands.ts#L1), [src/contract-explorer-commands.ts:1](../src/contract-explorer-commands.ts#L1), [src/decision-commands.ts:1](../src/decision-commands.ts#L1) |
| `@unbrained/pm-cli/sdk :: defineExtension` | 2026.5.1 | 2026.3.12 | [src/index.ts:21](../src/index.ts#L21) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [src/agent-context-commands.ts:1](../src/agent-context-commands.ts#L1), [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5), [src/services/decision-inbox.ts:2](../src/services/decision-inbox.ts#L2), [src/contract-explorer-commands.ts:1](../src/contract-explorer-commands.ts#L1), [src/decision-commands.ts:1](../src/decision-commands.ts#L1) |
| `@unbrained/pm-cli/sdk :: getContracts` | 2026.5.24 | 2026.5.18 | [src/contract-explorer.ts:1](../src/contract-explorer.ts#L1) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [src/services/resume-packets.ts:2](../src/services/resume-packets.ts#L2) |
| `@unbrained/pm-cli/sdk :: getItemAt` | 2026.7.15 | 2026.7.14 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: getSettingsPath` | 2026.5.14 | 2026.5.12 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: isMutationAction` | 2026.7.25 | 2026.7.24 | [src/contract-explorer.ts:1](../src/contract-explorer.ts#L1) |
| `@unbrained/pm-cli/sdk :: isPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5), [src/services/decision-inbox.ts:2](../src/services/decision-inbox.ts#L2) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5), [src/services/decision-inbox.ts:2](../src/services/decision-inbox.ts#L2) |
| `@unbrained/pm-cli/sdk :: listAllItemMetadataLight` | 2026.7.23 | 2026.7.22 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: listMutationEvents` | 2026.7.25 | 2026.7.24 | [src/services/resume-packets.ts:2](../src/services/resume-packets.ts#L2), [src/services/history-read-gate.ts:5](../src/services/history-read-gate.ts#L5) |
| `@unbrained/pm-cli/sdk :: pathExists` | 2026.5.14 | 2026.5.12 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: PM_TOOL_PARAMETERS_SCHEMA` | 2026.5.1 | 2026.3.12 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: QUERY_CURSOR_CONTRACT` | 2026.7.13 | 2026.7.12 | [src/routes/pm.ts:18](../src/routes/pm.ts#L18) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [src/services/resume-packets.ts:2](../src/services/resume-packets.ts#L2) |
| `@unbrained/pm-cli/sdk :: readSettingsWithMetadata` | 2026.7.23 | 2026.7.22 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: runWithAgentSessionContext` | 2026.8.2 | 2026.8.1 | [src/routes/pm.ts:18](../src/routes/pm.ts#L18) |
| `@unbrained/pm-cli/sdk :: stripGlobalBootstrapTokens` | 2026.7.17 | 2026.7.16 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk :: suppressHostOutput` | 2026.7.15 | 2026.7.14 | [src/index.ts:21](../src/index.ts#L21) |
| `@unbrained/pm-cli/sdk :: writeSettings` | 2026.7.23 | 2026.7.22 | [src/services/pm-runner.ts:5](../src/services/pm-runner.ts#L5) |
| `@unbrained/pm-cli/sdk/query :: resolveHybridSemanticWeight` | 2026.7.26 | 2026.7.25 | [src/routes/pm.ts:13](../src/routes/pm.ts#L13) |
| `@unbrained/pm-cli/sdk/query :: resolveSearchMaxResults` | 2026.7.26 | 2026.7.25 | [src/routes/pm.ts:13](../src/routes/pm.ts#L13) |
| `@unbrained/pm-cli/sdk/query :: resolveSearchScoreThreshold` | 2026.7.26 | 2026.7.25 | [src/routes/pm.ts:13](../src/routes/pm.ts#L13) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [src/index.ts:403](../src/index.ts#L403), [src/index.ts:439](../src/index.ts#L439), [src/index.ts:509](../src/index.ts#L509) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [src/agent-context-commands.ts:7](../src/agent-context-commands.ts#L7), [src/agent-context-commands.ts:8](../src/agent-context-commands.ts#L8), [src/agent-context-commands.ts:9](../src/agent-context-commands.ts#L9), [src/agent-context-commands.ts:10](../src/agent-context-commands.ts#L10), [src/agent-context-commands.ts:11](../src/agent-context-commands.ts#L11), [src/agent-context-commands.ts:12](../src/agent-context-commands.ts#L12), [src/agent-context-commands.ts:13](../src/agent-context-commands.ts#L13), [src/agent-context-commands.ts:15](../src/agent-context-commands.ts#L15), [src/agent-context-commands.ts:16](../src/agent-context-commands.ts#L16), [src/contract-explorer-commands.ts:8](../src/contract-explorer-commands.ts#L8), [src/contract-explorer-commands.ts:9](../src/contract-explorer-commands.ts#L9), [src/contract-explorer-commands.ts:11](../src/contract-explorer-commands.ts#L11), [src/contract-explorer-commands.ts:15](../src/contract-explorer-commands.ts#L15), [src/decision-commands.ts:6](../src/decision-commands.ts#L6), [src/decision-commands.ts:8](../src/decision-commands.ts#L8), [src/decision-commands.ts:10](../src/decision-commands.ts#L10), [src/index.ts:334](../src/index.ts#L334), [src/index.ts:335](../src/index.ts#L335), [src/index.ts:340](../src/index.ts#L340), [src/index.ts:400](../src/index.ts#L400), [src/index.ts:436](../src/index.ts#L436), [src/index.ts:506](../src/index.ts#L506) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [src/contract-explorer-commands.ts:7](../src/contract-explorer-commands.ts#L7), [src/decision-commands.ts:8](../src/decision-commands.ts#L8), [src/decision-commands.ts:11](../src/decision-commands.ts#L11), [src/decision-commands.ts:12](../src/decision-commands.ts#L12), [src/index.ts:514](../src/index.ts#L514), [src/index.ts:547](../src/index.ts#L547), [src/index.ts:548](../src/index.ts#L548) |
| `CommandHandlerContext.source_workspace_root` | 2026.7.25 | 2026.7.24 | [src/contract-explorer-commands.ts:7](../src/contract-explorer-commands.ts#L7) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [src/agent-context-commands.ts:26](../src/agent-context-commands.ts#L26), [src/contract-explorer-commands.ts:24](../src/contract-explorer-commands.ts#L24), [src/decision-commands.ts:22](../src/decision-commands.ts#L22), [src/index.ts:318](../src/index.ts#L318), [src/index.ts:391](../src/index.ts#L391), [src/index.ts:427](../src/index.ts#L427), [src/index.ts:497](../src/index.ts#L497) |
| `ExtensionApi.registerService` | 2026.5.1 | 2026.3.12 | [src/index.ts:586](../src/index.ts#L586) |
| `PmClient.get` | 2026.7.6 | 2026.7.5 | [src/idempotency-access.ts:83](../src/idempotency-access.ts#L83) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [src/services/pm-runner.ts:836](../src/services/pm-runner.ts#L836) |
| `PmClient.packageDescribe` | 2026.7.8 | 2026.7.7 | [src/services/pm-runner.ts:759](../src/services/pm-runner.ts#L759) |
| `PmClient.planDecision` | 2026.7.12 | 2026.7.11 | [src/services/decision-inbox.ts:176](../src/services/decision-inbox.ts#L176), [src/services/decision-inbox.ts:194](../src/services/decision-inbox.ts#L194) |
| `PmClient.planShow` | 2026.7.12 | 2026.7.11 | [src/services/decision-inbox.ts:140](../src/services/decision-inbox.ts#L140) |
| `PmClient.run` | 2026.7.6 | 2026.7.5 | [src/services/pm-runner.ts:1000](../src/services/pm-runner.ts#L1000) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.18 | `df41d0df1f499a531d6a2cba134defa369870b2fe4b414c0517ef85e7c51db0e` |
| 2026.5.24 | `9d28fff4b06405ea5691ee919ad646c86c0a416a5007ca8104b19251306262af` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.11 | `2376fbe884dd24b13896c12dd2c9f8c1e28a37988dabbb3a4cdacba4a39f2d94` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.16 | `9973500112359cdde17903322caa488c32b7176d4735a0b4eb36ff546bb76240` |
| 2026.7.17 | `79f28898694458f61b73ccef7c4f2438d83b4aea49ea30cf972ca39a03aa84f4` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.8.20 | `4a613893a4b1deffb92b12b2b6651a16b371cef2c2657dc4dcac52de41321156` |
| 2026.8.21 | `bbc0ccb9df0d7979563d384b778c30cb2858c9e63949d694475b776ec8c70aff` |

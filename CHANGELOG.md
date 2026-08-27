# Changelog

## Unreleased

### Security

- The identity gate deadlocks the one remediation its own failure message prescribes ([pm-web-1ggj](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-1ggj.toon))

## 2026.8.27 - 2026-08-27

### Fixed

- The changelog gate stamps an untagged version with the current date, so its verdict flips every midnight with no commit ([pm-web-kcs1](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-kcs1.toon))
- Certify pm-web complete tracker reads and refresh the package catalog ([pm-web-crdr](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-crdr.toon))
- Docstring corrections: filters, graph-canvas, crypto, board, pm routes, project-watcher, sse, mutation-event-watcher ([pm-web-oehb](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-oehb.toon))
- Fix release publish-before-protected-main-push ordering ([pm-web-8l6j](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-8l6j.toon))

## 2026.8.17 - 2026-08-17

### Fixed

- The package catalog could silently omit a fleet package, and had already drifted from pm-ops capabilities ([pm-web-yqmi](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-yqmi.toon))

## 2026.8.14 - 2026-08-14

### Fixed

- The pm CLI dependency was an unpinned range in a package whose production image installs without dev dependencies ([pm-web-swb5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-swb5.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- SW mutation queue: IndexedDB read failure indistinguishable from empty queue ([pm-web-zz37](https://github.com/unbraind/pm-web/blob/main/.agents/pm/bugs/pm-web-zz37.toon))

### Other

- Adopt canonical pm-ops docstring gate and reach 100% docstring coverage ([pm-web-mglt](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-mglt.toon))

## 2026.8.7 - 2026-08-07

### Fixed

- Serialize pm-web test schema bootstrap before parallel route suites ([pm-web-3u1v](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-3u1v.toon))

### Other

- Gate CI on strict tracked pm project health ([pm-web-yiym](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-yiym.toon))

## 2026.8.4 - 2026-08-04

### Fixed

- Absorb pm-cli 2026.8.3: realign in-process dispatch with the CLI envelope ([pm-web-3mn5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-3mn5.toon))

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-web-l6y1](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-l6y1.toon))

## 2026.7.31 - 2026-07-31

### Fixed

- Release commits discard the rebuilt dist, so the git-install path serves the previous version ([pm-web-vm5g](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-vm5g.toon))

## 2026.7.30 - 2026-07-30

### Fixed

- Daily release failed: the release workflow ran the real-Postgres coverage gate with no database service ([pm-web-sqg5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-sqg5.toon))

### Other

- Build the real-Postgres route harness and cover the pm-web access-control surface ([pm-web-dlbe](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-dlbe.toon))

## 2026.7.29 - 2026-07-29

### Added

- Run the test suite against TypeScript sources behind an uncheatable coverage gate ([pm-web-g6ac](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-g6ac.toon))
- Catalog every installable pm package including the authoring templates ([pm-web-xe0u](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-xe0u.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-web-tvj1](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-tvj1.toon))
- Type the browser client against the server routes so public/src carries zero any ([pm-web-cvh5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-cvh5.toon))

## 2026.7.28 - 2026-07-28

### Added

- Per-project package catalog so every pm package is installable from the web UI ([pm-web-28aw](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-28aw.toon))

### Fixed

- Require edit permission for package catalog mutations in pm-web ([pm-web-rknk](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-rknk.toon))

### Other

- Adopt pm-cli 2026.7.28 in the hosted web UI package ([pm-web-g7ed](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-g7ed.toon))

## 2026.7.27 - 2026-07-27

### Added

- Replace per-request pm processes with typed PmClient dispatch and cursor pagination ([pm-web-wyum](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-wyum.toon))

### Fixed

- web status/stop/doctor shadow the host-owned --json global and fail to register on pm-cli 2026.7.27 ([pm-web-snn2](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-snn2.toon))

### Other

- Move pm-web onto pm-cli 2026.7.26 and pm-changelog 2026.7.25 ([pm-web-orfk](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-orfk.toon))

## 2026.7.26 - 2026-07-26

### Added

- Full pm ecosystem production pass for pm-web ([pm-web-i98h](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-i98h.toon))
- Realtime mutation-event subscription replaces filesystem polling as the primary out-of-band change detector ([pm-web-vwaq](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-vwaq.toon))

### Other

- Enable governance duplicate-detection advisory mode and restore parent_reference=warn ([pm-web-0nc9](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-0nc9.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-web-hgx4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-hgx4.toon))
- project-watcher: bounded round-robin scan for projects beyond MAX_FILES_PER_PROJECT (8000) ([pm-web-acwm](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-acwm.toon))

## 2026.7.24 - 2026-07-24

### Added

- Cross-process real-time bus so pm-gpt/pm-mcp edits reach pm-web SSE clients (and scale across replicas) ([pm-web-2rek](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-2rek.toon))

### Fixed

- Hosted build: pm-web was un-redeployable — dedupe @unbrained/pm-cli to deps + align bundled pm-graph TS to ^7.0.2 ([pm-web-1h5b](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-1h5b.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-web-n1pm](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-n1pm.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-web-94so](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-94so.toon))

## 2026.7.18 - 2026-07-18

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-web-rwsr](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-rwsr.toon))

## 2026.7.17-1 - 2026-07-17

### Added

- Chinese (zh) locale for package-owned UI strings ([pm-web-t6v6](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-t6v6.toon))
- Spanish (es) locale for package-owned UI strings ([pm-web-2ut6](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-2ut6.toon))
- i18n plumbing + German locale for package-owned UI strings ([pm-web-y80b](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-y80b.toon))

## 2026.7.17 - 2026-07-16

### Added

- Point-in-time item view endpoint via SDK getItemAt ([pm-web-glqh](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-glqh.toon))

## 2026.7.13 - 2026-07-13

### Security

- Pin pm-web container dependencies and minimize build context ([pm-web-184g](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-184g.toon))
- Add generic self-hostable OIDC login ([pm-web-t03i](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-t03i.toon))

### Other

- Migrate hand-written public/sw.js and public/cookie-consent.js to TypeScript sources ([pm-web-qihk](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-qihk.toon))
- Make pm CLI execution non-blocking with bounded concurrency ([pm-web-ssma](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-ssma.toon))
- Separate public legal templates from hosted deployment notices ([pm-web-apu6](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-apu6.toon))

## 2026.7.10 - 2026-07-10

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-web-v1pr](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-v1pr.toon))

### Removed

- Remove GitHub runners from private pm-web repo ([pm-web-y28b](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-y28b.toon))

### Security

- Restore pm-web release pipeline (mistaken runner removal 6691d413) ([pm-web-yjb2](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-yjb2.toon))
- Remove hard-coded dev JWT fallback ([pm-web-hvkc](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-hvkc.toon))

### Other

- Ecosystem release readiness pass 2026-07-06 ([pm-web-f9r8](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-f9r8.toon))
- Align Node engine with pm CLI runtime ([pm-web-ndeb](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-ndeb.toon))
- Generate pm-web package declarations and refresh bundled graph toolchain ([pm-web-1xkj](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-1xkj.toon))
- Regenerate CHANGELOG after pm close item ([pm-web-0ww0](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-0ww0.toon))

## 2026.6.13-2 - 2026-06-13

### Fixed

- npm publish 403: package name unscoped pm-web rejected (too similar to pmweb) — restore @unbrained/pm-web ([pm-web-kkyo](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-kkyo.toon))

## 2026.6.13-1 - 2026-06-12

### Fixed

- Server prints false success and hangs on EADDRINUSE (Express 5 listen callback receives the error) ([pm-web-7s9b](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-7s9b.toon))

### Other

- Daily Release fails at changelog:check: generate step uses prepend/since-previous-tag but check expects replace/all-release-tags ([pm-web-5myg](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-5myg.toon))

## 2026.6.13 - 2026-06-12

### Fixed

- Fix Daily Release: runs-on self-hosted has no registered runner, switch to ubuntu-latest ([pm-web-rzmv](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-rzmv.toon))

### Other

- Full-cycle hardening wave: pm-web ([pm-web-3x0r](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-3x0r.toon))
- Align pm-web with pm CLI 2026.6.12 release readiness ([pm-web-gtdz](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-gtdz.toon))
- Restore self-hosted daily release automation ([pm-web-hgjp](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-hgjp.toon))

## 2026.6.9 - 2026-06-09

### Added

- Normalize board and search behavior for real pm data ([pm-web-hzb0](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-hzb0.toon))

### Removed

- Restore CI and Daily Release workflows removed by no-runner policy misapplication ([pm-web-2xlv](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-2xlv.toon))

### Other

- Harden web release readiness checks ([pm-web-d5ef](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-d5ef.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-web-9z1i](https://github.com/unbraind/pm-web/blob/main/.agents/pm/chores/pm-web-9z1i.toon))

## 2026.6.4 - 2026-06-04

### Added

- Add light/auto theme toggle, URL-state item filters, and iCal (.ics) calendar export ([pm-web-b6eo](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-b6eo.toon))

## 2026.6.2-1 - 2026-06-02

### Added

- Do NOT add the 'services' extension capability to pm-web ([pm-web-vyfp](https://github.com/unbraind/pm-web/blob/main/.agents/pm/decisions/pm-web-vyfp.toon))
- Deepen pm-web extension command surface (status/stop/doctor) + services-capability evaluation ([pm-web-7pxa](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-7pxa.toon))
- Add /healthz version + unit tests + README docs ([pm-web-edyj](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-edyj.toon))
- Introduce CommandError (numeric exitCode) for new handlers ([pm-web-9ycn](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-9ycn.toon))

### Other

- Implement 'pm web doctor' command ([pm-web-vyqb](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-vyqb.toon))
- Implement 'pm web stop' command + pidfile-on-detach ([pm-web-odwq](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-odwq.toon))
- Implement 'pm web status' command ([pm-web-8eqs](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-8eqs.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add kanban board + full-text search data endpoints (contracts-driven) ([pm-web-9sno](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-9sno.toon))

## 2026.5.30 - 2026-05-30

### Fixed

- Daily Release fails at changelog:check — version-format mismatch (padded tag vs npm version) ([pm-web-ysd5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-ysd5.toon))

### Other

- Keep pm-web published scoped as @unbrained/pm-web (not unscoped pm-web) ([pm-web-1qq4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/decisions/pm-web-1qq4.toon))

## 2026.5.29-1 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data + Postgres) ([pm-web-ul0n](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-ul0n.toon))

### Fixed

- Catalog npm link points to unpublished unscoped pm-web (404) ([pm-web-2wrz](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-2wrz.toon))
- Server hangs/cryptic error when DATABASE_URL is unset ([pm-web-onv4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-onv4.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-web-8u17](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-8u17.toon))

## 2026.5.29 - 2026-05-29

### Fixed

- Fix pm-web startup: drop private-infra DB host default + graceful Postgres-unreachable guidance ([pm-web-avpc](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-avpc.toon))

### Removed

- Remove obsolete notify-website-sync workflow (dispatched deleted companion deploy.yml -\> 422) ([pm-web-9m5w](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-9m5w.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-web-2s2i](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-2s2i.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-web-mc5h](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-mc5h.toon))

### Fixed

- Fix notify-website-sync: drop misleading source_repo alias ([pm-web-egz2](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-egz2.toon))

### Other

- Scope npm package as @unbrained/pm-web ([pm-web-m1lf](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-m1lf.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-web-hlh5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-hlh5.toon))

### Security

- Remove hardcoded personal email default from pm-web source ([pm-web-mvu4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-mvu4.toon))

### Other

- Release readiness hardening for pm-web ([pm-web-srg8](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-srg8.toon))

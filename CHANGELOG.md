# Changelog

## Unreleased

### Fixed

- Fix pm-web startup: drop private-infra DB host default + graceful Postgres-unreachable guidance ([pm-web-avpc](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-avpc.toon))

### Removed

- Remove obsolete notify-website-sync workflow \(dispatched deleted companion deploy.yml -\> 422\) ([pm-web-9m5w](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-9m5w.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-web-2s2i](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-2s2i.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-web-mc5h](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-mc5h.toon))

### Fixed

- Fix notify-website-sync: drop misleading source\_repo alias ([pm-web-egz2](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-egz2.toon))

### Other

- Scope npm package as @unbrained/pm-web ([pm-web-m1lf](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-m1lf.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-web-hlh5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-hlh5.toon))

### Security

- Remove hardcoded personal email default from pm-web source ([pm-web-mvu4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-mvu4.toon))

### Other

- Release readiness hardening for pm-web ([pm-web-srg8](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-srg8.toon))

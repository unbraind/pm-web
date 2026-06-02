# Changelog

## Unreleased

### Added

- Do NOT add the 'services' extension capability to pm-web ([pm-web-vyfp](https://github.com/unbraind/pm-web/blob/main/.agents/pm/decisions/pm-web-vyfp.toon))
- Deepen pm-web extension command surface \(status/stop/doctor\) + services-capability evaluation ([pm-web-7pxa](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-7pxa.toon))
- Add /healthz version + unit tests + README docs ([pm-web-edyj](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-edyj.toon))
- Introduce CommandError \(numeric exitCode\) for new handlers ([pm-web-9ycn](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-9ycn.toon))

### Other

- Implement 'pm web doctor' command ([pm-web-vyqb](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-vyqb.toon))
- Implement 'pm web stop' command + pidfile-on-detach ([pm-web-odwq](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-odwq.toon))
- Implement 'pm web status' command ([pm-web-8eqs](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-8eqs.toon))

## 2026.05.30 - 2026-05-30

### Fixed

- Daily Release fails at changelog:check — version-format mismatch \(padded tag vs npm version\) ([pm-web-ysd5](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-ysd5.toon))

### Other

- Keep pm-web published scoped as @unbrained/pm-web \(not unscoped pm-web\) ([pm-web-1qq4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/decisions/pm-web-1qq4.toon))
- Production-readiness audit 2026-05-28 ([pm-web-8u17](https://github.com/unbraind/pm-web/blob/main/.agents/pm/tasks/pm-web-8u17.toon))

## 2026.05.29-1 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data + Postgres\) ([pm-web-ul0n](https://github.com/unbraind/pm-web/blob/main/.agents/pm/features/pm-web-ul0n.toon))

### Fixed

- Catalog npm link points to unpublished unscoped pm-web \(404\) ([pm-web-2wrz](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-2wrz.toon))
- Server hangs/cryptic error when DATABASE\_URL is unset ([pm-web-onv4](https://github.com/unbraind/pm-web/blob/main/.agents/pm/issues/pm-web-onv4.toon))

## 2026.05.29 - 2026-05-29

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

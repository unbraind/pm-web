# Decision: Rename npm package to unscoped `pm-web`

- **Date:** 2026-07-05
- **Task:** pm-web-v9sq
- **Status:** Approved & in progress
- **Author:** codex (on behalf of maintainer approval)

## Context

`pm-web` is published on npm as the scoped package `@unbrained/pm-web`
(v2026.6.14). Every other package in the pm-cli fleet uses the unscoped
`pm-*` naming convention (`pm-changelog`, `pm-todos`, …). `manifest.json`
already declares `name: "pm-web"`, and the website ecosystem validator
flags the scoped name as a branding violation.

## Decision

Rename the published npm package from `@unbrained/pm-web` to the unscoped
`pm-web` to align with the rest of the fleet and clear the branding
violation. The maintainer has approved the rename.

## Scope of change

A repo-wide search found exactly **one** reference to the scoped name in
tracked source:

- `package.json` → `"name": "@unbrained/pm-web"` → `"name": "pm-web"`

No other references exist:
- `README.md` uses `pm install github.com/unbraind/pm-web` and generic
  `npm install` — no scoped install command or shields badge to update.
- `src/index.ts` already registers `name: "pm-web"` (unscoped).
- `.github/workflows/release.yml` reads the name dynamically via
  `node -p "require('./package.json').name"` and publishes with
  `--access public` (harmless for an unscoped package), so no workflow
  change is required.
- `manifest.json` already uses `name: "pm-web"`.

`package-lock.json` is regenerated to reflect the new name.

## What is NOT changed

- `dist/` build artifacts are left unstaged. The committed `dist/index.js`
  carried a stale version string (`2026.6.13-1`) that is independent of
  this rename; the daily release workflow rewrites `src/index.ts` and
  rebuilds `dist/` at release time, so committing a hand-rebuilt `dist/`
  here would inject an unrelated version bump.
- No `publishConfig` exists; the workflow's `--access public` flag is
  retained (no-op for unscoped packages, harmless).

## Release & deprecation plan

1. Merge this PR to `main`.
2. The daily release workflow auto-releases on changes and publishes the
   package under its new name `pm-web` to npm. We do **not** publish
   manually.
3. After `npm view pm-web version` confirms the unscoped package is live,
   deprecate the old name:
   `npm deprecate @unbrained/pm-web@* "Renamed to pm-web (unscoped). Run: npm install pm-web"`
4. The companion registry (`extensions/registry.json`) already uses
   `name: pm-web` and `pm install github.com/unbraind/pm-web --project`,
   so no registry change is required.

## Notes

- Confirmed `pm-web` (unscoped) is **free** on npm (404 as of 2026-07-05).
- Confirmed `@unbrained/pm-web` latest is `2026.6.14`.
- A prior commit `cc820a3 Restore scoped npm package name @unbrained/pm-web`
  shows an earlier rename attempt was reverted; this attempt completes it.

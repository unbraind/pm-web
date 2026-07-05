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

## ⛔ BLOCKED — npm name-similarity collision with `pmweb`

**Status update (2026-07-05): RENAME CANNOT PROCEED AS PLANNED.**

Although `pm-web` returns 404 on npm (so it is nominally "free"), a real
publish would be **rejected**. npm's official [New Package Moniker Rules]
strip all punctuation from a candidate name and compare it against existing
package names. `pm-web` → `pmweb`, and **`pmweb` already exists on npm**
(`pmweb@0.0.0`, a parked/squatter placeholder).

Publishing `pm-web` would fail at release time with:
> *"npm ERR! 403 Forbidden — pm-web is too similar to pmweb"*

This was caught by **two of four bot reviewers** on PR #20:
- **cubic** (P1): *"Using unscoped `pm-web` here can block publishing if
  npm's moniker-similarity check detects an existing
  punctuation-equivalent name (for example `pmweb`)."*
- **CodeRabbit**: *"The package name is no longer scoped, which causes a
  publish collision with the existing pmweb package."*

**Greptile** (5/5 "safe to merge") and CI **missed this** — neither checked
the registry for punctuation-equivalent sibling names. `npm publish --dry-run`
also passes because dry-run does not perform the server-side similarity check;
the rejection only surfaces on a real publish.

### Why we did not force it

The task constraint was explicit: *"If `pm-web` (unscoped) is somehow
already taken on npm, STOP and report — do not force."* A name blocked by
npm's similarity rule is effectively taken.

### Options for the maintainer (decision needed)

1. **File a name dispute with npm** to claim `pm-web` from the parked
   `pmweb` (npm support sometimes transfers parked `0.0.0` names). Slow
   and uncertain.
2. **Pick a different unscoped name** that has no punctuation-equivalent
   sibling, e.g. `pmwebui`, `pm-webui`, `pm-web-ui` (verify each first —
   `pmwebui` would collide with `pmwebui` only if it exists; must check).
   This would also require updating `manifest.json` and the companion
   registry, and breaks the strict `pm-web` branding.
3. **Keep the scoped `@unbrained/pm-web`** and instead adjust the website
   ecosystem validator to accept the scoped name as legitimate branding
   (the maintainer owns both the org and the fleet). Lowest risk.
4. **Stay scoped but under a personal/org scope the validator accepts**
   (if the validator's rule is configurable).

This is a maintainer decision; the agent is not choosing unilaterally.

### State left behind

- PR #20 opened with all CI + bot checks green, but is **NOT merged**
  (would break the daily release publish step).
- The branch `chore/rename-to-unscoped-pm-web` is pushed.
- The scoped `@unbrained/pm-web` is **NOT deprecated** (no new package
  was published).
- This decision record is updated with the finding.

[New Package Moniker Rules]: https://blog.npmjs.org/post/168978377570/new-package-moniker-rules.html

## Original notes (pre-finding, for history)

- Confirmed `pm-web` (unscoped) is **free** on npm (404 as of 2026-07-05)
  — *but blocked by the `pmweb` similarity rule (see above).*
- Confirmed `@unbrained/pm-web` latest is `2026.6.14`.
- A prior commit `cc820a3 Restore scoped npm package name @unbrained/pm-web`
  shows an earlier rename attempt was reverted; this attempt is also blocked.

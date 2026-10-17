# Triplicate review evidence

Tracker: `pm-web-i0td`. Companion phase: `pm-cli-website-z2kf`.

The public package consumes `pm-brand` as an exact-commit development dependency.
`npm run build:brand` copies the installed assets into ignored `public/brand/`;
the package's existing `public/` inclusion publishes them. Runtime dependencies
contain no Git dependency. Commit-addressed assets have a one-year immutable
cache lifetime. The stylesheet pointer is revalidated so upgrades select the
new commit. Optional fonts, their licenses, icons and logos are copied when
present in the pinned kit. No third-party font request is made.

The first commit isolates the build pipeline and CSS indirection. Its temporary
compatibility bridge retains exact legacy values so that the infrastructure
change can be checked independently of the chosen new identity. The following
commit replaces that bridge with aliases to the Triplicate contract.

Browser evidence uses synthetic users, one synthetic workspace and five
lifecycle records. The harness never opens a database or a real tracker.
Before screenshots come from the unchanged `54c694b` UI at 1440, 768 and 390
pixels in both system color schemes. The baseline has no board: its board
comparison shows the existing list. A live-arrival comparison likewise shows
the previous static list before the new signature exists.

To reproduce the matrix, install Chromium separately, set `CHROMIUM_PATH` to
its executable and `BRAND_SCREENSHOTS` to an external output directory, then
run `node scripts/brand-browser.ts`. Use `BRAND_ACCEPTANCE=1` for keyboard and
responsive assertions. `node scripts/brand-pixel-diff.ts BEFORE TOKENS`
compares the five main views across the complete migration matrix.

Build regression: the generated-assets tests pass against a real static HTTP
server. Restoring only the original static middleware fails the cache-header
assertion: expected `no-cache`, received `public, max-age=0`. Restore the
function after this deliberate behavioral revert.

The change does not deploy the hosted application. Review screenshots are on
the repository's `pr-screenshots` branch under the PR branch name.

Migration pixel comparison: 30/30 images passed. Maxima across widths/themes:

| View | Max channel delta (0–255) | Max changed pixels | Max changed area |
| --- | ---: | ---: | ---: |
| Sign-in | 27 | 28 | 0.00718% |
| Projects | 15 | 31 | 0.00795% |
| Items | 0 | 0 | 0% |
| Board baseline | 0 | 0 | 0% |
| Item detail | 0 | 0 | 0% |

The sparse glyph-edge differences stay below the declared antialiasing limit
(32 channel levels and 0.02% changed pixels); item views are pixel-identical.
The external evidence directory also contains the complete per-image JSON.

The restyle consumes the kit's self-hosted Archivo, Public Sans and Martian Mono,
its SVG mark, and its 192/512/maskable PWA icons. The generated manifest derives
its colors from the installed contract. Cookie notices take normal document
space; they cannot cover a form. The board keeps the same filters as the list.
Closed stamps appear only inside the closed item's detail sheet.

Focused styling checks: 41/41 asset, contrast, legal, localization and service
worker tests. The stronger browser audit checks painted text contrast and alpha,
Tab traversal of every action, focus rings and viewport width. It caught the
calendar's faded adjacent-month dates and a canvas Tab trap; both were fixed.
The live-arrival audit also exposes the old SSE list replacement, addressed in
the following in-place arrival commit.

Live arrivals refetch authoritative records and patch reserved readonly slots.
They preserve list order, focus, comment drafts, edit drafts and existing history
entries. Only authenticated other accounts, other sessions or known other authors
produce a copy. Legacy events with no identity refresh quietly. A changed item
uses canary, or rose when blocked, for 700 ms; its left border and the reserved
caption remain for five seconds. Reduced motion omits the duplicate entirely.
The accessible source remains present during the visual copy, and one polite
region announces the update. Saving a stale edit submits only fields changed
locally so untouched collaborator fields survive.

The real PostgreSQL/wire-SSE regression passes with authenticated display-name
attribution and the unnamed-member fallback. Reverting only `emitItemEvent`
causes the regression to fail on the missing author while retaining the legacy
item and user identity fields. The request body's author cannot override the
caption's authenticated identity.

Browser acceptance also opens every detail tab, expanded create fields, account
and project navigation, admin tabs, and the remaining routed screens. Each
visible action is reached with actual Tab input and checked for a focus ring.
Painted text, including alpha and ancestor surfaces, is tested for AA contrast;
all widths are checked for horizontal overflow. Arrival scenarios assert timing,
blocked tint, focus and geometry, own-echo suppression, partial draft writes,
non-displacing comment arrivals and reduced motion.

Local fleet verification sets `PM_FLEET_ROOT` to the canonical fleet directory.
The default parent of a package worktree is a partial worktree farm, which is
not the fleet oracle. Both live-catalog assertions pass against the canonical
inventory. The collaboration wire test retains its five-second propagation
deadline, beginning after the committed HTTP write while continuously reading
SSE; CLI execution time is covered separately by the capacity acceptance.

Initial browser matrix: 216 before/after PNGs, 300 screen/tab audits, 8,512 real
Tab stops, 1,917 painted contrast-pair checks and 36 live-arrival scenarios.
Every requested width/theme passes with no horizontal overflow, inaccessible
action, missing focus ring, overlapping cookie form or competing primary action.
A separate mid-arrival motion-preference switch restores the accessible source
immediately and hides the duplicate; reverting that CSS rule reproduces the
hidden source. All used `--pm-*` references exist in the pinned contract.

The round 1 pack dry run includes 357 files, 61 of them generated brand files, with all
three font files, mark artwork, PWA icons and licenses. Runtime Git dependencies:
zero. The final Node 22 image builds and its test tag is deleted afterward.
Strict tracker health accepts the append-only histories and configured merge
drivers; the existing non-blocking storage advisory is retained.

The two mobile themes were recaptured after visual review found an inherited
metadata column rule clipping a tag inside the reserved slot. Tags and status
now share a stable row. The replacement frames and their 100 audits are merged
into the complete matrix above.

Full local release attempts hit the unchanged 300-second catalog-consumer
fixture deadline under contention. These failed attempts are not acceptance.
The existing CI matrix runs both complete release commands with isolated Git
identity on each supported Node line; the PR records its exact-head results.
No functional assertion, coverage floor, duplication limit or capacity budget
has been relaxed. Both dependency installers use their normal script-enabled lifecycle.

Round 1 pins the held kit at `c64fb9da7937c2d239f67357cab325f6a9cff29a`.
Its committed exports and guarded preparation remove the install and CSS-parsing
fallbacks. The browser palette imports `tokens` from `pm-brand` and bundles the
public export. Clean installs and image builds run their normal lifecycle scripts.

Arrival captions sit directly under the affected sheet's mono strip with a
canary marker (rose for blocked changes). Slots exist before the event, including
board cards and detail sheets. One polite announcement remains available to
assistive technology. A closed detail sheet has a single rotated stamp; action
slots stay in keyboard order and explain why unavailable actions are disabled.
At 480 pixels and below, secondary item actions use one native disclosure.

The image builder includes only tracked tracker settings/schema and initializes
build-local Git so pm-web's canonical clone preparation can run normally.
Neither builder nor runtime disables dependency scripts. The Node 22 base npm
10 installation and complete image build pass; the test tag is removed afterward.
A fresh-cache Bun install retains the exact Git integrity in the npm lockfile.

Round 1 behavioral revert proofs rebuild the browser before each deliberate
rollback. Restoring only caption targeting to the old page/modal selector fails
on the changed row's empty caption. Restoring only the detail markup to chip plus
stamp fails on the unwanted closed chip. Both production functions are restored.
The nine focused asset/contrast/live-value tests and nine service-worker tests pass.

The reviewed round 1 matrix contains 140 fresh AFTER PNGs and preserves the
108 original BEFORE PNGs. It passes 332 screen/tab audits, 9,806 Tab stops,
2,167 painted contrast-pair checks and 42 live-update cases. List, board
and detail arrivals each have a 350 ms frame and a settled frame in every
width/theme. Mobile disclosure screenshots cover both themes at 390 pixels.

Local full npm attempts on Node 24 and 26 hit the existing 300-second catalog
consumer deadline under host contention. These attempts are failures. Complete
release acceptance is recorded for the final PR head in the GitHub matrix and
the screenshot branch release-gates receipt. No threshold or deadline changed.

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

Upstream install gap: the held kit's Git `prepare` runs merge installation in
an artifact directory without Git metadata. CI installs with scripts disabled
and explicitly runs this package's canonical prepare afterward. That Git
artifact also lacks compiled token exports; the build prefers those exports
when present and otherwise generates equivalent typed data from the installed
CSS. This fallback is generated output, never a second maintained palette.

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

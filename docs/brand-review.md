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
The npm-to-Bun migration retains the exact 40-character Git commit and every
registry checksum. Only the optional npm-generated Git tarball checksum is
omitted because Bun uses a different Git archive format. Lifecycle scripts
remain enabled; integrity verification is never disabled globally.

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

The CI installer uses Bun 1.4.3. A clean npm-to-Bun fixture reproduces
IntegrityCheckFailed with the optional Git archive checksum present; changing
only that entry and using a second fresh cache passes. Both installations run
normal lifecycle scripts. The corrected-lock Docker build passes and its tag
is removed. After dependency restoration, all 18 focused asset/contrast/live
and service-worker tests pass together. Rendered sources are unchanged.

Round 2 addresses the six unresolved review findings against the current source.
Handled SSE events reconcile authoritative filtered membership and board columns,
reusing patched row elements and leaving detail drafts intact. Direct-body graph
dialogs use the shared keyboard lifecycle and are removed on Escape. Confirmation
prompts supply their dialog's accessible name. Graph nodes use all five lifecycle
styles, normalize the hyphenated working-state alias, strike canceled labels and
use neutral paper/rule/graphite for draft or custom statuses. Shape, abbreviation,
label pill and text preserve the node opacity.

Closed and canceled sheets retain the Close panel's Delete action and expose
Delete and Reopen beside Use as template. Start, Pause and Claim are hidden
in those states; Release and Update remain available. Reopen writes the open status
through the normal update endpoint. Empty list captions have zero height. An
arrival shares the mono strip line on the right at desktop/tablet widths and may
wrap inside its own row on narrow screens. Board and detail attribution remain
inside their affected sheets.

`scripts/brand-browser-regressions.ts` exercises filter exit and entry with a
focused comment draft, board relocation and counts, repeated graph-dialog Escape
and reopen with working controls, accessible confirmation names, finished-item
Delete/Reopen, contract graph styles and draw opacity, and all five compact empty
rows. `BRAND_REGRESSION_ONLY` selects one regression or `all` in the fixture
browser harness. Each regression runs against rebuilt production modules.

The final round 2 pin is `7ad0970d96a20c24b8dbd9e0dcd1efeb8b4d5cc1`,
the current held kit main. It includes the previously verified assets unchanged
plus release-automation fixes. The dependency update retains every registry
checksum and the existing optional-Git-archive-checksum omission for Bun
compatibility. Runtime dependencies contain no Git dependency.

All seven focused behavioral reverts exit with a failure after rebuilding: the
filtered row fails to leave, Escape retains a graph dialog, the confirmation
prompt has no accessible name, the hyphenated working state receives white
instead of canary wash, filtered drawing loses its alpha, the disabled Close
tab hides Delete, and an empty row caption reserves 28 px. Production functions
are restored after every probe. The restored seven-case suite also passes via
`pm test`; the width/theme matrix repeats every case with fixture data.

The completed round 2 matrix contains 146 fresh AFTER PNGs and preserves the
108 original BEFORE PNGs. It passes 338 screen/tab audits, 9,872 real Tab stops,
2,251 painted contrast-pair checks, 42 live-update cases and 42 reviewed
regressions across all six width/theme combinations. Confirmation dialogs are
now captured in every combination. All requested list, arrival, board,
closed-detail and graph frames are fresh. The package dry run still contains
357 files, including 61 generated brand files and three fonts, and no runtime
Git dependency. The image build passes and its test tag is removed.

The final closed-action rule hides only Start, Pause and Claim. Release remains
available for finished items. A supplemental behavioral revert restores only
its old disabled rule and fails the closed-action availability check; production
is restored and rebuilt. The browser matrix is recaptured for this final rule.
The pinned CLI also accepts Release after Close in a real scratch tracker.
The restored linked browser suite, lint, zero-duplication gate, pack dry run
and Docker build/removal pass with this final rule.

Action rows wrap without shrinking their buttons. The closed-action regression
also checks sheet bounds, text clipping and overlapping button rectangles.
Restoring only the former action-row CSS fails at 390 px on clipped actions;
restoring the fix passes. This ninth probe serves the reverted CSS directly.

Reconciliation retains the order of existing rows and appends newly matching
rows. A reversed authoritative fixture response during a title arrival must
preserve row order and focus. Removing only the order-preservation step fails
with reversed row IDs; production is restored and rebuilt. This tenth probe
covers non-displacing arrivals alongside status-filter and board membership.

Earlier local round 2 full npm and Bun attempts, before the final kit pin,
each ran 666 tests: 663 passed,
2 failed, 1 canceled, 0 skipped and 0 todo. Both hit the existing catalog
consumer's 300-second deadline and then `spawn ENOTDIR` in its source variant.
The npm attempt also reproduced the tracked spawn-overlap scheduling assertion
(`pm-web-fhob`); Bun reproduced the tracked 2,000-item graph budget failure
(`pm-web-hqqp`), at 10,691 ms versus 10,000 ms. `pm-web-qdhx` contains the
catalog/startup follow-up evidence. Statement/line coverage was 91.76% and
92.01%, below the unchanged 92.07% floor. These local attempts are failures,
not acceptance. Final-head npm/Bun acceptance is recorded separately in the PR
and the screenshot branch's release receipt. No server runtime, server test,
coverage scope, threshold or deadline changed in this review round.

Item status mode uses lifecycle borders. Type/tag modes and facet/external
lanes retain their category outlines. The drawing regression spans all three
modes and lanes; restoring only unconditional lifecycle borders fails its
outline assertion. Unknown statuses, including prototype-named values, resolve
to neutral graphite in both initial and repaint color selection. Restoring only
the palette's own-property guard raises the former non-token lookup error.
These eleventh and twelfth probes are restored and rebuilt, with final source
hashes checked after restoration.

Round 3 reviews every unresolved finding against the diff from main and blame
on synced source head `58957d9`. All eleven are in scope:

| Finding at reviewed line | Provenance and decision | Browser regression |
| --- | --- | --- |
| app.ts:572 | `23910ff` introduced the handled-arrival early return; fix active graph/activity/stats/plan refresh alongside detail patching | `round3-active-view` |
| modals.ts:31 | `aa8563e` added opener storage; preserve it across repeated opens and clear it on close | `round3-opener` |
| live-copy.ts:129 | PR-created field patcher; rebuild escaped list tag chips, including empty lists | `round3-tags` |
| dedupe.ts:33 | `a248a06` switched to shared rows; suppress badges for string and object members lacking status | `round3-dedupe` |
| graph-canvas.ts:490 | `aa8563e` introduced the synchronous loop; move unchanged physics into a coalesced module worker | `round3-settle` |
| graph-canvas.ts:1519 | `aa8563e` reset label alpha; retain edge opacity for background and text | `round3-edge-opacity` |
| graph-canvas.ts:1941 | The hint predates the PR but `aa8563e` changed Tab behavior; update the painted hint | `round3-tab-hint` |
| graph.ts:1164 | `aa8563e` changed the palette; task/epic/story legend entries use canvas carbon | `round3-legend` |
| graph.ts:1734 | Direct removals predate the PR, while `23910ff` added showModal focus capture; quick correctness fix across Close, Cancel and successful submission | `round3-dependency-close` |
| items.ts:674 | `23910ff` added the insufficient guard; sequence requests and suppress stale errors too | `round3-stale` |
| plan.ts:292 | `a248a06` changed the selected surface to sheet; restore distinct stamp wash/ink and clear both on deselection | `round3-plan` |

The synchronous baseline uses an actual GraphCanvas with 2,000 synthetic nodes
and 1,999 dependency edges in Chromium: `reheat()` blocks for 24,256.8 ms.
The final worker version returns in 0.1 ms and completes all 180 steps in
59,488 ms under concurrent acceptance load while input tasks run. An earlier
worker run completed in 35,285.9 ms. Control requests across event-loop tasks coalesce to one
real worker after a 75 ms debounce. Intermediate positions never paint; the final computed positions
publish together. Data replacement, layout change, node drag and teardown
cancel pending work. The worker and shared physics module are precached for
offline use. This fixes main-thread responsiveness; the unchanged quadratic
calculation still takes substantial background time at this scale.

Successful dependency mutations retain the full graph refresh, then transfer
focus to the replacement opener with the same id. The shared close helper restores the opener for all six
Close/Cancel/submit paths. The Ctrl+K test repeats open/open/Escape twice.

`scripts/brand-browser-reverts.ts` copies public sources into an isolated build,
restores only the relevant declaration(s) from `58957d9`, rebuilds TypeScript
and the brand module, and runs the corresponding production-browser case.
Each failure must be an assertion or UI wait failure; compilation/process
errors do not count. Source hashes prove the production functions stay intact.
No thread resolve or reopen operation is part of this workflow. No review finding is deferred. The pre-existing quadratic background algorithm
is tracked separately in `pm-web-68ig` with the measured scenario and a spatial
approximation design sketch.

The completed round 3 browser matrix passes 362 screen/keyboard audits,
10,858 actual Tab stops, 2,495 painted contrast checks, 60 new review cases,
42 prior review cases and 42 live-update cases. It captures 30 fresh AFTER
frames for graph, type legend, updated tags, dedupe and selected plans across
1440/768/390 and light/dark. All other AFTER frames and every original BEFORE
frame are preserved. A supplemental final-submit test repeats all six dialog
close paths in all six width/theme combinations after restoring the full reload.
The final-source linked eleven-case suite and all eleven independent reverts
pass their acceptance rules. The package dry run includes 363 files, including
the worker and shared physics modules; the Docker build passes and its test
image is removed. Production dependency audit reports zero vulnerabilities.

Exact executable head `3eb50e71d9766f415666dda639c2d5279e56c37b` passes
[CI run 39027377588](https://github.com/unbraind/pm-web/actions/runs/39027377588):
all four npm/Bun release gates across Node 22 and 26. Each gate passes 666/666
unit/integration tests, 2/2 capacity cases and all four packed consumers, with
zero failures, cancellations, skips or todos. Measured server-source coverage
minima are 92.51% statements/lines, 81.48% branches and 95.22% functions.
Both CodeQL checks pass. Neutral/skipped reviewer results are not approvals.

The completed local worktree npm attempt is a failure: 655 passed, 10 failed,
1 canceled and no skipped/todo tests out of 666. Statements/lines are 91.67%,
branches 81.20% and functions 95.48%. Catalog consumer/startup and process exit
or JSON deadlines, partial sibling-fleet assumptions, server graph wall time
and a reset collaboration connection are recorded under `pm-web-qdhx`,
`pm-web-4p94` and `pm-web-hqqp`. Observer/privacy cases stopped at fixture
startup deadlines. The independent standalone Bun profile uses its own test storage. Its final
counts and the final-head CI receipt are published
in the [round 3 release receipt](https://github.com/unbraind/pm-web/blob/pr-screenshots/brand/triplicate-tokens-and-restyle/round3-release-gates.json).
This standalone profile uses the suite's intended committed-snapshot oracle.
No server runtime, server test, coverage scope, floor or deadline changed.

The standalone local Bun attempt also finishes its 666 tests red: 660 passed,
5 failed, 1 canceled and no skipped/todo tests. It passes the standalone catalog
structural checks and reproduces consumer/startup deadlines, server graph wall
time, fatal-output child timing and a reset collaboration connection. These
local attempts provide failure evidence; the four clean-runner CI gates provide
release acceptance. The final receipt keeps each profile and outcome separate.

Round 4 verifies all seven unresolved threads from the review of `147ba52`.
The newest review contains seven inline findings and no outside-diff or nitpick
sections. The review-input receipt preserves every unresolved thread, including
all comments, plus the complete newest review body.

| Review thread | Fix and regression |
| --- | --- |
| `discussion_r4302676333` | Account button uses `nav.accountActions` in all four shipped locales; `round4-locale` checks the actual accessible name without changing its icon. |
| `discussion_r4302676340` and issue #218 | Dragging writes rendered coordinates and clears velocity while physics stays paused; `round4-drag` uses real mouse and single-touch input, cancels pending settling, retains released positions, and checks panning, click selection and keyboard navigation. |
| `discussion_r4302676344` | Force `setData` starts/restarts cancellable settling and fits after the initial worker result. `round4-settle` checks replacement termination, stale-result rejection and hierarchical cancellation. An empty graph cannot consume the first fit, and an early switch to hierarchical layout fits synchronously. The older large-graph cancellation assertion now checks termination rather than requiring no replacement work. |
| `discussion_r4302676348` | Theme-scoped token values and node colors are cached. `round4-palette` measures zero recolors and zero CSS property lookups over 20 steady frames, with one invalidation for theme and mode changes. |
| `discussion_r4302676352` | A real pinned-CLI scratch tracker proves explicit empty tags and description are supported. PATCH forwards those two empty arguments; a real HTTP/PostgreSQL/CLI regression proves clearing and preservation of omitted fields. |
| `discussion_r4302676354` | The contrast audit composites complete CSS opacity groups from the text outward. `round4-opacity` checks both white ink in a faded black container and an opaque white child inside a faded black parent; both paint 3.98:1 and fail AA. |
| `discussion_r4302676364` | The wire regression selects authenticated route events by item and author, even after three additional watcher-style facts arrive. |

The nine isolated revert probes restore only account binding, drag assignments,
automatic settling, delayed fit, recoloring, resolved-token caching, opacity
auditing, clear forwarding or SSE event selection. Each compiles first, then
must fail a behavioral assertion. Production source hashes are verified after
all probes. Source behavior remains static between explicit layout requests;
background physics continues in the existing cancellable worker.

Main is merged through `dc7d2d3`. The held kit's main remains the existing exact
pin `7ad0970d96a20c24b8dbd9e0dcd1efeb8b4d5cc1`; no open brand PR is consumed.
Round 4 screenshots cover account actions, the settled project graph and the
item-detail graph at 1440/768/390 in both themes. Detail-graph captures scroll
the graph itself into view after the keyboard/contrast audit.

Final-source round 4 verification passes 42 keyboard/contrast audits, 778 actual
Tab stops, 255 painted text-pair checks and 30 review cases. All nine independent
revert probes compile and fail on their intended behavioral assertions; the
complete suite exits successfully and all production hashes match.

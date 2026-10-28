# pm-web

Full web UI for [pm-cli](https://github.com/unbraind/pm-cli) — browse, create, update, search, dedupe-audit, validate and manage pm projects in the browser.

Features user auth, multi-project support, sharing, groups, GitHub import/sync, admin-only management, local Ollama semantic search configuration, and pm-graph/Neo4j relationship graphs. Hosted at **pm-web.unbrained.dev** or self-host via Docker.

---

## Quick Start (Self-Hosted)

pm-web requires a reachable **PostgreSQL** database for accounts, project metadata
and sharing, plus a writable `PROJECTS_ROOT` for plain-directory trackers. Provide
`DATABASE_URL`, or `POSTGRES_HOST` and `POSTGRES_DB` with optional
`POSTGRES_PORT` (default `5432`), `POSTGRES_USER` and `POSTGRES_PASSWORD`.
PostgreSQL URLs may supply `host` in the query, including a Unix socket directory.
Credentialed empty-host URLs, bare socket paths (`/socket-directory database`),
and `socket:/socket-directory?db=database` are also supported by the driver.
Repeated `host` query parameters use the driver's last-value precedence.
An empty `DATABASE_URL` uses the discrete settings. A URL may omit the database
path to use the PostgreSQL driver's defaults. Empty optional numeric environment
settings use their documented defaults; nonempty invalid values are rejected.
Production also requires `JWT_SECRET`. Startup validates settings before binding
and names missing or invalid settings without printing credentials or connection
strings. The database user needs permission to create and alter the packaged schema.

### Without git

The item APIs read and write a plain-directory pm tracker through the SDK.
Creating, reading, updating, listing, searching and validating items do not need a
git repository or the git executable. PostgreSQL is still required by the web
server. Real-time presence and event replay also work with a plain tracker and
no git executable. GitHub import/sync additionally needs GitHub credentials and access;
Git-based operations such as worktree commands and changelog generation from tags
need a git repository.

### Docker

```bash
docker build -t pm-web .
docker run -p 4000:4000 -e DATABASE_URL=postgres://... pm-web
```

### Node.js

```bash
git clone https://github.com/unbraind/pm-web.git
cd pm-web
npm install
npm run build

# Set environment variables
export PORT=4000
export DATABASE_URL=postgres://user:pass@localhost:5432/pmweb
export JWT_SECRET=change-me
export OLLAMA_BASE_URL=http://localhost:11434
export PM_OLLAMA_MODEL=qwen3-embedding:0.6b
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=change-me

npm start
```

Open http://localhost:4000 in your browser.

---

## Installation as pm Package

For the public package, initialize a tracker in a plain project directory and
activate the pinned registry release. npm installs runtime dependencies before
activation; no git repository is required.

```bash
npx -y @unbrained/pm-cli@2026.10.21 init --defaults --agent-guidance skip
npx -y @unbrained/pm-cli@2026.10.21 install npm:@unbrained/pm-web@2026.10.21 --project
```

With Bun, use `bunx` instead of `npx -y` for both commands.
The explicit `npm:` source selects the scoped public registry package.
PostgreSQL configuration is required to start the server; package activation alone
does not establish database readiness.

GitHub-source activation alone does not install runtime dependencies. It requires
built `dist/` output and every `package.json` runtime dependency (including `pg`)
resolvable from the activated module graph. A fresh source-only project lacks
these dependencies and activation fails. Use the registry route above for fresh
projects; source development needs the dependency installation and build described
in the Node.js section before local activation.

The package repository is at **github.com/unbraind/pm-web**.

### Commands

| Command | Description |
|---|---|
| `pm web` | Start the pm-web server (foreground) |
| `pm web --port 8080` | Start on a custom port |
| `pm web --detach` | Start the server in the background (tracked via a pidfile) |
| `pm web status` | Report whether a server is reachable (probes `/healthz`); `--json` supported |
| `pm web stop` | Stop a server previously started with `--detach`; `--json` supported |
| `pm web doctor` | Preflight diagnostics (Node, runtime deps, database, port, pm, workspace); `--json` supported |

#### Detached startup

`pm web --detach` prints `started` only after its child binds and `/healthz`
reports healthy. The default deadline is 30 seconds; set
`--startup-timeout <milliseconds>` or `PM_WEB_STARTUP_TIMEOUT_MS` (1–300000).
If the child exits or the deadline expires, the command exits nonzero, terminates
the child, reports the pidfile state and its last ten redacted log lines, and
leaves no stale pidfile. Child logs are retained beside the pidfile as
`pm-web-<port>.pid.log` (replaced on each start, private file permissions).
This raw log grows for the child's lifetime without automatic rotation; see
[detached log retention](docs/startup-readiness.md#detached-log-retention) for
its location, sensitive contents and cleanup/rotation requirements.

#### `pm web status`

Probes `http://localhost:<port>/healthz` and reports `up`/`down`, the responding
port, and the server version. Never errors when the server is down — it returns a
structured `down` result. The port is resolved from `--port`, then `PORT`, then
the default `4000`.

```bash
pm web status                 # human-readable
pm web status --port 8080 --json
```

#### `pm web stop`

Stops a server started with `pm web --detach`. The detached PID is recorded in a
pidfile (under `PM_WEB_STATE_DIR` if set, otherwise the OS temp dir, keyed by
port). `pm web stop` reads the pidfile, sends `SIGTERM`, and clears the pidfile.
If nothing is running it reports `not_running` gracefully and cleans up any stale
pidfile.

```bash
pm web stop                   # stops the server on the default port
pm web stop --port 8080 --json
```

#### `pm web doctor`

Runs preflight checks before starting the server: Node version (>= 22.18.0), whether
runtime dependencies (express, etc.) are installed, whether the target port is
free, whether `pm` is on `PATH`, and whether the workspace is initialized.
The `database` check reports configuration, reachability and schema version
(expected revision 1). Missing configuration, connection failure or a missing or
incompatible schema yields a clear failing line and overall `ok: false`. Doctor
is read-only; start `pm web` to apply the packaged schema migrations when the
schema is missing or older. A newer schema requires a compatible pm-web release.
Startup and packaged SQL preserve the highest recorded schema revision.
Returns an overall `ok` boolean. The `port_available` check is informational (a
busy port may just be a server you already started) and does not gate `ok`.

```bash
pm web doctor
pm web doctor --json
```

> Note: the `services` extension capability is intentionally **not** declared.
> The pm SDK's `registerService` only overrides one of eight fixed core services
> (e.g. `output_format`), which would alter core output for unrelated commands;
> the server lifecycle is exposed safely through the commands above instead.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Unless `POSTGRES_HOST` + `POSTGRES_DB` are set | PostgreSQL connection string; alternative to the discrete settings below |
| `POSTGRES_HOST` / `POSTGRES_DB` | Unless `DATABASE_URL` is set | PostgreSQL host and database; set both for discrete configuration |
| `POSTGRES_PORT` | No | Discrete PostgreSQL port (default: `5432`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | No | Optional discrete PostgreSQL credentials |
| `JWT_SECRET` | In production | Secret for signing JWT tokens; an unset value uses a random development secret outside production |
| `PM_WEB_SECRET_KEY` | Recommended | At-rest encryption key for saved GitHub PATs. Falls back to `JWT_SECRET`; use at least 32 characters |
| `PM_WEB_BOOTSTRAP_ADMIN_EMAIL` | Recommended | Email of the user account to auto-promote to admin on schema init. Leave unset to skip auto-promotion (manage admins via the admin UI). |
| `PORT` | No | Server port (default: 4000) |
| `PM_WEB_STARTUP_TIMEOUT_MS` | No | Detached health deadline (default: 30000 ms; `--startup-timeout` takes precedence) |
| `PM_WEB_STATE_DIR` | No | Directory for the `--detach` pidfile used by `pm web stop` (default: OS temp dir) |
| `PROJECTS_ROOT` | No | Host-mounted root for persistent pm workspaces (default: `/app/projects`) |
| `PM_WEB_PM_CONCURRENCY` | No | Maximum concurrent child processes for CLI-only fallback commands (default: `8`); fallback commands for one workspace always serialize |
| `PM_WEB_PM_CLIENT_CACHE_MAX` | No | Maximum number of least-recently-used workspace `PmClient` instances retained per server process (default: `256`) |
| `PM_CLI_BIN` | No | Explicit pm CLI executable path (default: packaged CLI, then `pm` from `PATH`) |
| `PM_WEB_DB_POOL_MAX` | No | PostgreSQL pool size including one dedicated realtime listener (default: `20`, minimum: `2`) |
| `NODE_ENV` | No | `production` enables caching |
| `PM_WEB_TRUST_PROXY` | Behind a proxy | Reverse-proxy hops to trust for the client address (`1` for a single proxy such as Caddy), a comma-separated IP/subnet allowlist, or `false`/`0`. **Defaults to `false`** — a direct deployment must not trust `X-Forwarded-For`, or a caller can rotate that header to draw a fresh rate-limit bucket per request. Set it only when a proxy really does sit in front, otherwise the per-IP limits enforce nothing. |
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | No | Local Ollama endpoint for semantic pm search |
| `PM_OLLAMA_MODEL` | No | Embedding model for new projects, default `qwen3-embedding:0.6b` |
| `NEO4J_URI` | No | Neo4j Bolt URI for graph sync |
| `NEO4J_USER` / `NEO4J_USERNAME` | No | Neo4j username |
| `NEO4J_PASSWORD` | No | Neo4j password |
| `PM_WEB_LEGAL_DIR` | Production | Absolute path to a complete, private, operator-reviewed legal-page overlay; see `docs/LEGAL_DEPLOYMENT_BOUNDARY.md` |
| `OIDC_ISSUER` | With OIDC | Provider issuer URL; incomplete or invalid OIDC settings fail startup in production and are soft-disabled outside production |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | With OIDC | OIDC confidential client credentials |
| `OIDC_REDIRECT_URI` | With OIDC | Exact HTTPS callback URL ending in `/api/auth/oidc/callback` in production |
| `OIDC_COOKIE_SECRET` | With OIDC | Dedicated secret for signed, short-lived login state; at least 32 characters in production |
| `OIDC_SCOPES` | No | Requested scopes (default: `openid profile email`) |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | No | Reject identities without a provider-verified email when `true` |

New pm-web projects configure local Ollama search automatically and install the `pm-graph` package into the project workspace (from npm, via the per-project package catalog). Graph GET/HEAD requests only read the installed export model or the built-in fallback and never install or activate extensions. Editors can choose **Enable pm-graph** in the graph view, which calls `POST /api/projects/:projectId/pm/graph/provision` with CSRF protection; viewers keep access to the fallback graph and cannot provision. Provisioning retries are idempotent. Neo4j graph rows are scoped per pm-web project so syncing one project does not overwrite another.

The Packages view also lists [pm-jev](https://github.com/unbraind/pm-jev#readme),
with `commands`, `hooks` and `schema` capabilities and links to its documentation,
repository and
[issue tracker](https://github.com/unbraind/pm-jev/issues). It is shown as
**unreleased**, with installation disabled: the registry answered 404 when the
fleet snapshot was refreshed. Its local default uses Ollama with
`tev1:4b`; the optional hosted TypeSafe provider requires `TYPESAFE_API_KEY` and
explicit `jev.allow_external: true`. Its manifest requires pm CLI 2026.10.5.

Catalog completeness uses a committed registry-backed fleet snapshot in CI.
Live discovery validates manifest identity against npm package identity and the
canonical public repository, excludes the host/CLI by identity, and collapses
equivalent sibling worktrees. Missing, invalid, or conflicting metadata fails
the gate. To refresh, set `PM_FLEET_ROOT` to a fleet directory and run
`npm run fleet:snapshot`, then `node --test test/catalog.test.ts` with the same
variable. See [catalog acceptance evidence](docs/catalog-pm-jev.md).

The SDK upgrade retains these catalog guarantees; see
[SDK and catalog certification](docs/sdk-update-automation.md).

The Packages view covers all 25 public fleet identities with verified descriptions,
capabilities, command paths and links. Published extensions support project
installation, activation and documented command execution. Unpublished extensions
show an explanation instead of an Install button; the independent native
`pm-rust` CLI links to native setup and has no npm install spec. See the
[fleet package catalog and HTTP acceptance](docs/fleet-package-catalog.md).

Comments Audit and Normalize require `pm-governance-audit`; Reindex (including
keyword mode) requires `pm-search-advanced`. Both ship as optional bundled
aliases with the pinned CLI. Owners and editors can install or enable them in
**Packages** for each project. Existing projects are never provisioned automatically.
Unavailable actions show a disabled control and package guidance; viewers see
guidance to ask an owner or editor, without an install action.

`GET /api/projects/:projectId/extensions` includes `maintenance` availability and
`canManagePackages`. Each action reports `available`, `provider`, `hint`, and an
editor-only `installAction` pointing to the existing project package install API.
Maintenance routes refuse missing providers with HTTP 424 and
`code: "provider_unavailable"` in the usual JSON error envelope. Command ownership
comes from the SDK package view, cached per project for five seconds and invalidated
after package mutations. A failed capability read refuses execution with HTTP 503.
The extensions list still returns HTTP 200 with package rows and role-aware controls,
plus `capabilities: { status: "unavailable", error: { code: "capabilities_unavailable",
message } }`; `maintenance` is omitted so no action advertises stale availability.
The Packages view displays a non-blocking warning and retains install/activation
controls for owners and editors. Maintenance views keep actions unavailable until
capability reads recover. Healthy reads report `capabilities: { status: "available" }`.
Existing view-only mutation refusals remain HTTP 403.

Saved GitHub personal access tokens are encrypted at rest before they are written to PostgreSQL. Existing plaintext tokens from older installs still work when read, and are replaced with encrypted values the next time the user saves a token.

Latency-bounded native pm operations run through the typed `PmClient` SDK in the
server process, with SDK cursor contracts and search-tuning helpers used by the
list/search API. Commands without an SDK action, maintenance commands,
extension-specific output, and potentially long-running search, bulk-update,
upgrade, acceptance-test, validation, health, and garbage-collection operations
retain an asynchronous child-process fallback with bounded concurrency;
requests for the same workspace serialize on that fallback in addition to pm's
storage locks. Calls that supply stdin or an explicit timeout also use this
fallback because the SDK action contract has no cancellable stdin/timeout
primitive. The current pm SDK serializes activation-backed `PmClient` calls
within each Node process, so high-throughput installations should run multiple
pm-web replicas behind a shared PostgreSQL realtime bus. Independent replicas
converge through PostgreSQL notifications and the mutation-event watcher.
When the PostgreSQL listener reconnects, it invalidates the workspace and
extension catalog of each locally connected project so viewers, including the
Packages view, reload authorized state that may have changed while the listener
was disconnected. These recovery signals contain no item content and stay
local to the recovering process; PostgreSQL notifications are transient and
are not a durable event replay mechanism.

Whole-project graph, board, local search, iCalendar, and export reads
use the SDK's high-level `listAllComplete` operation. pm-web accepts those rows
only after the shared SDK certificate agrees. Since pm CLI 2026.8.31, the SDK
certifies the source counters, omission receipt, output receipt, and truncation
disclosure itself, so pm-web keeps just one supplemental check: it refuses an
`output_budget_exceeded` disclosure, which the SDK still accepts even though it
means the rows may be short of the whole corpus. The public `/pm/list-all`
HTTP compatibility route remains deliberately paginated for interactive clients,
but invokes canonical `list --all` internally; consumers that need the whole
workspace must use a complete-read endpoint rather than assembling a page as if
it were the corpus. The standalone server exact-pins its pm CLI/SDK in
`package.json`. The extension manifest declares a separate supported-host minimum;
packed acceptance exercises that minimum and the current SDK host under npm and
native Bun. Dependency-only updates preserve the minimum unless those checks
require a deliberate compatibility change. See [SDK update automation](docs/sdk-update-automation.md).
Commands that render their own text or JSON (`web status`, `web stop`, and
`web doctor`) return the public SDK output-suppression marker, so the host never
appends a second payload to stdout.

Optional OIDC uses Authorization Code flow with PKCE, provider discovery/JWKS,
signed state cookies, and issuer/subject identity mapping. It is disabled when
no OIDC variables are present and production startup fails closed on partial or
unsafe configuration. Password login remains available.

The public package ships operator-neutral legal placeholders only. A hosted
deployment must mount all reviewed pages privately through `PM_WEB_LEGAL_DIR`;
the server refuses partial overlays. See [the legal deployment boundary](docs/LEGAL_DEPLOYMENT_BOUNDARY.md).

---

## Architecture

- **Backend**: Express.js with PostgreSQL
- **Frontend**: Single-page app in `public/`
- **Auth**: JWT-based user authentication
- **API**: RESTful API at `/api/*`

### API Routes

| Route | Description |
|---|---|
| `/api/auth` | Authentication (login, register) |
| `/api/projects` | Project CRUD |
| `/api/projects/:id/pm` | PM item operations |
| `/api/projects/:id/pm/history/:itemId` | Paginated item activity summaries |
| `/api/groups` | Group management |
| `/api/projects/:id/shares` | Sharing |
| `/api/projects/:id/github` | GitHub integration |

`GET /api/projects/:projectId/pm/history/:itemId?limit=50` returns
`{ history, order: "oldest_first", has_more, next_cursor }`. Each history row
contains `index`, `timestamp`, `action`, `author` and an optional recorded `message`. Pages contain the latest
matching entries in chronological stream order, ending with the latest operation
(including close). The History panel displays each page newest first. Select
**Load older history** to append earlier entries. A live update resets the panel
and its cursor to the latest page.

`limit` defaults to 50 and accepts integers from 1 to 100. Pass the opaque
`next_cursor` back as `cursor` to read an older page; stop when `has_more` is
false. Each response has at most `limit` patch-free rows, with timestamp strings
bounded to 64 characters, operation/author strings to 128 characters each and
messages to 512 characters. The route requests `history --full --diff --limit N`
explicitly through the existing authorized project runner, then converts it to
the browser row shape without patches or diff values. The same-snapshot diff
supplies physical indices on older hosts while full entries preserve messages. Upstream
`order` is honored; older hosts without it are treated as oldest first. No
projection or display order depends on pm defaults.

Supported pm versions do not expose a backwards cursor on the item-history
query. Older API pages therefore re-read the necessary latest suffix with pm's
limit before returning only the selected bounded page. Appends preserve the
cursor boundary. Every older page proves the complete physical interval from
the same suffix response, rather than trusting a separate head probe.
Compaction, a changed boundary, or concurrent appends that push required rows
out of that suffix return 409 and ask the caller to restart. An incomplete
read never reports the end of history. This bounds the HTTP payload; it does
not promise constant tracker read cost for deep pages. Existing project membership checks apply to
every page, and these reads work in a plain tracker without git.

History refusals include `error`, `code` and `remedy`: invalid limits/cursors
return 400, missing history returns 404, a stale cursor returns 409, unsupported
host output returns 502, and unavailable history returns 503. Existing missing
project/access responses retain their authorization behavior. The panel shows
read failures with recovery guidance rather than an empty-history success.

Run `JWT_SECRET=synthetic-history-verification-secret node scripts/item-history-browser.ts`
after `npm run build` to verify desktop/mobile detail, pagination and live-copy
behavior. Set `CHROMIUM_PATH` when Chromium is installed separately. Screenshots
are written to the ignored `artifacts/item-history/item-history-1440.png` and
`artifacts/item-history/item-history-390.png` (or `HISTORY_SCREENSHOTS`).

---

## License

MIT

## Release Automation

CI runs type checking, exact Node 22.18.0 and current-Node matrices, real
PostgreSQL integration tests, the configured coverage gate, complete docstring
coverage, production dependency audit, package packing, fresh packed `npx` and
`bunx` install-and-command acceptance, immutable workflow-action checks, and
pm-changelog validation. The daily release
workflow publishes at most once when commits exist after the latest release tag
and uses pm-changelog for both `CHANGELOG.md` and GitHub release notes.

Browser evidence builds use complete dependency trees and the checked-out commit
for both push and pull-request baselines. See [browser baseline fixtures](docs/browser-baselines.md)
for local checks, isolated revert builds and Git prerequisites.

The current package is **not** approved for a new release: exact all-source
100/100/100/100 coverage remains open in
[`pm-web-9ulj`](.agents/pm/epics/pm-web-9ulj.toon) and
[`pm-web-ulgy`](.agents/pm/tasks/pm-web-ulgy.toon), while reachable-history
privacy authorization is tracked in
[`pm-web-priv`](.agents/pm/issues/pm-web-priv.toon) and
[GitHub issue #96](https://github.com/unbraind/pm-web/issues/96). Passing the
configured gate is evidence for the measured source set, not those independent
release approvals.

## New data endpoints (kanban board & search)

The pm data API exposes board and search views through the certified
complete-read contract described above. The board also uses the workspace's
live `pm contracts` statuses for its columns:

- `GET /api/projects/:projectId/pm/board` — items grouped into kanban columns by
  the workspace's runtime statuses (unlisted statuses fall into `(other)`).
- `GET /api/projects/:projectId/pm/search?q=<text>` — case-insensitive full-text
  search over id, title, tags and body.
- `GET /api/projects/:projectId/pm/schema` — runtime types/statuses (existing).
- `GET /api/projects/:projectId/pm/graph` — complete observational graph matching
  the pinned pm-graph default export; see [graph export fidelity](docs/GRAPH_READS.md).
- `GET /api/projects/:projectId/pm/calendar.ics` — RFC 5545 iCalendar feed of
  item deadlines (see below).

The pure grouping/search helpers live in `src/board.ts` and are unit-tested
independently of the database.

## UI features

### Theme (dark / light / auto)

The web UI supports three themes — **dark** (default), **light**, and **auto**
(follows the OS `prefers-color-scheme`). Toggle with the button in the top nav
or the `t` keyboard shortcut; the choice is persisted to `localStorage`. The
palette is driven entirely by CSS variables (`public/styles.css`); the toggle
logic lives in `public/src/theme.ts`.

### Shareable filtered views

The Items view mirrors its filters into the URL query string, so a filtered
view is shareable and bookmarkable:

```
/items?status=open&type=Feature&priority=1&assignee=alice&tag=release
```

Filterable dimensions: `status`, `type`, `priority`, `sprint`, `release`,
`assignee`, `tag`. Opening such a URL restores the filters; use the **Copy
link** button to copy the current filtered view. The pure (de)serialization
helpers live in `public/src/filters.ts` and are unit-tested.

### Calendar export (iCal / .ics)

`GET /api/projects/:projectId/pm/calendar.ics` returns an RFC 5545 `VCALENDAR`
with a `VEVENT` per item that has a deadline, suitable for **subscribing** in
Google Calendar, Outlook, or Apple Calendar. Date-only deadlines become all-day
events; items without a deadline are skipped. Use the **Export .ics** button on
the Calendar view to download, or subscribe to the feed URL. Because calendar
clients cannot send cookies, the feed also accepts the JWT via a `?token=<jwt>`
query parameter (in addition to the usual `Authorization: Bearer` header /
cookie). The pure generator lives in `src/ical.ts` and is unit-tested.

### Keyboard shortcuts

Press `?` for the in-app shortcuts overlay. Highlights: `Ctrl/⌘+K` global
search, `/` focus search, `n`/`c` new item, `t` cycle theme, `a` activity,
`g i` items, `g g` graph, `g s` search, `g c` calendar, `Esc` close modal.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` from a clone wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

The publish-attestation gate combines the canonical pm-ops auditor with fail-closed
checks for unresolved shell indirection. Readable scalar commands with literal
arguments and attested
function bodies pass; aliases, argument forwarding and other unsupported dynamic
publish paths fail even when an attested sibling exists. See
[the gate's supported syntax and regression evidence](docs/publish-attestation.md).

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.


### Offline mutation identity and recovery

Each service-worker write outside `/api/auth` gets an `Idempotency-Key` and
captures its originating account before its first network attempt. If that
response is lost, the queued record keeps the same key, body and account.
Every replay sends `X-PM-Expected-Account`; the server refuses a different or
missing account with 409 before executing or claiming a key, and the worker
keeps the record. The session is resent when a worker first controls the page or changes;
session writes and explicit adoption extend the worker event lifetime.

The SPA displays blocked offline records. For unknown-owner records, the
signed-in user may click **These changes are mine — adopt for my signed-in
account** after reviewing the listed paths. The recovery message carries the
approving account and adoption verifies it against the current server session.
Adoption and flush share one operation chain. Adoption reads and updates
ownership in one IndexedDB transaction, preserves any existing key and assigns
only missing keys, then retries the queue.
Records owned by another account remain blocked until that account signs in.
Auth routes always use live responses and are never keyed or queued; legacy
auth records remain blocked. Deleted or unknown token accounts bypass keying
and receive the route's normal authentication outcome. Retention cleanup runs
before key claims so a cleanup failure leaves the request retryable.

API rate limits apply before idempotency, including to replay attempts. Explicit
pre-mutation refusals (425 and 429) release the intent and are never replayed.
Handlers may call `markIdempotencyPreCommitFailure` only when they can prove
no mutation committed. Group creation does so on connection acquisition failure
or a successful rollback before any COMMIT attempt. A later rollback cannot
prove that an attempted COMMIT failed. Proven pre-commit 5xx failures release
the claim, allowing the same key to retry. Every other 5xx and premature response
close settles into terminal `outcome_unknown`, returning 409 with
`PM_IDEMPOTENCY_OUTCOME_UNKNOWN` on retries without re-executing. Live duplicates
wait up to `PM_WEB_IDEMPOTENCY_WAIT_MS` (default 30 seconds), then receive 409
with `PM_IDEMPOTENCY_IN_FLIGHT`. After `PM_WEB_IDEMPOTENCY_PENDING_TIMEOUT_MS`
(default five minutes), pending rows settle as unknown on duplicate lookup or
the next retention sweep, including intents stranded by process termination.
Outcome persistence failures are caught and logged without request contents.

The worker durably marks unknown outcomes and three consecutive 5xx responses
as **needs attention**, then stops automatic attempts for that record. Replays
preserve FIFO within each owner's workspace; later records in other workspaces
may continue. Paths under `/projects/<id>/` define a workspace, including legacy
records. Account-level paths are barriers: they wait for earlier unresolved
owned work and block all later owned work until resolved. Other accounts have
separate ordering. Network or local persistence failures stop the flush.

The recovery notice offers the originating owner **Retry as a new request**
and **Discard**. Retrying requires a confirmation that the original might
already have committed; it assigns a fresh key at the same queue position,
then resumes ordered replay. Each new request is deduplicated separately:
the user's approved retry can duplicate an unknown original commit. Discard
removes only the queued record and does not undo any server commit. Recovery
verifies the approving account against the server and updates IndexedDB in a
single transaction. The keyboard-accessible **Dismiss** control hides the
notice until the blocked record set changes; dismissing preserves all records.

Completed responses and terminal unknown outcomes are retained for
`PM_WEB_IDEMPOTENCY_RETENTION_MS` (default seven days) from settlement.
Deduplication is bounded by that window; a retry after expiry may execute again.
Cleanup uses a partial `updated_at` index and runs at most once per minute per
guard instance. Pending intents are settled before retention can remove them.

### Real-time operational visibility

The server emits one JSON line per operational event to stdout. `LOG_LEVEL`
accepts `debug`, `info` (default), `warn`, `error`, or `silent`; invalid values
fall back to `info`. No log shipping or telemetry configuration is required.
Every line has `timestamp`, `level`, and `event`:

| Event | Additional fields |
| --- | --- |
| `request` | `method`, `route`, `status`, `duration_ms`, `request_id`, `user_hash` |
| `sse_connect` | `project_hash`, `user_hash` |
| `sse_disconnect` | `project_hash`, `reason`, `duration_ms` |
| `sse_broadcast` | `project_hash`, `event_type`, `recipient_count` |
| `watcher_sweep` | `completed`, `duration_ms`, `files_scanned`, `changes_detected`, `errors` |
| Error events, including `unhandled_error` | `name`, redacted `message`, sanitized `stack` locations |
| `server_started` | `port` |

Request routes are registered templates such as
`/api/projects/:projectId/pm/update/:itemId`. Static responses and pre-routing
failures use `/unmatched`; router-level failures use the mount template plus
`/unmatched`. Raw paths, query strings, headers, cookies, bodies, item content,
user ids and email addresses are excluded. Unknown methods and SSE event types
use fixed labels. The server generates `X-Request-Id`; incoming ids are ignored.
`/healthz` request lines are suppressed. Streaming request durations end when
the connection closes; an interrupted response has log status `499`.

User and project pseudonyms use HMAC-SHA256 with separate domains. Set
`LOG_HMAC_SECRET` to a server-only random secret of at least 32 bytes for stable
pseudonyms across replicas/restarts. Otherwise the server uses `JWT_SECRET`,
or a random per-process secret when neither is configured. Rotating the secret
changes pseudonyms. Treat pseudonyms as restricted operational metadata.
Free-form error messages can embed SQL values, tokens or request content, so
error logs replace their text, whitelist error names, and retain allowlisted server module names and stack
line/column locations. They never serialize error properties or request data.

`/healthz` exposes a `realtime` object containing aggregate, process-local
counters only: `sse_clients`, `sse_connections_total`,
`sse_disconnections_total`, `broadcasts_total`, `watcher_last_sweep_at`,
`watcher_last_sweep_ms`, `watcher_changes_total`, and `watcher_errors_total`.
These values are read on every health request even when database/mount probes
are cached. Counters reset on restart and are not cluster totals. Broadcasts
count local delivery attempts (including zero-recipient project events), plus
presence broadcasts; the recipient count is the number of targeted clients.
Disconnects count once, with `client_closed`, `max_age`, `replaced`, `attach_failed`,
`slow_or_unauthorized`, or `server_shutdown` as the reason.

The filesystem watcher reports completion of each bounded timer tick, including
idle ticks with no subscribers. `files_scanned` counts file stat attempts in that
tick; large project scans can span several ticks. `changes_detected` counts
completed project signature changes, including changes suppressed as already
announced. Missing optional item directories and files that vanish during a
scan are normal; other filesystem errors are reported. The service answers
HTTP 503 with `ok: false`, `status: "degraded"` and
`dependencies.project_watcher.ok: false` after **three** missed sweep intervals
(default interval 15 seconds, stale after 45 seconds), or if the last tick
reported errors. Startup has the same three-interval grace; disabling the
watcher also reports degraded. A healthy sweep restores health. Freshness is a
scheduler signal, not proof that all projects or mutation subscriptions are
healthy. The counters expose no tenant identifiers or per-user data, so they
extend the existing health endpoint without requiring an operator token.

The real-server regression in `test/observable-realtime.test.ts` uses the test
PostgreSQL harness and a temporary projects root. It connects through the
production SSE route, writes with a separate pinned pm CLI process, requires a
filesystem-origin event within five seconds, and checks live counter changes.
The mutation watcher is disabled for this case so it cannot mask a broken
filesystem watcher-to-broadcast link. A separate real-server privacy case checks
stdout against synthetic credentials, ids, cookies, query and item-content
sentinels during a successful item update and a malformed JSON request.

For reproducible mixed HTTP/CLI load measurements against the disposable test
database, see the [collaboration capacity harness](docs/capacity.md). It starts
the built production server, records per-subscriber loss and duplicates plus
delivery latency and resource counters, and caps its ladder at 3000 subscribers.
See [project event delivery and resume](docs/realtime-fanout.md) for shared frames,
bounded slow-viewer queues, authorization and `Last-Event-ID` recovery.

### Triplicate assets and browser review

The held `pm-brand` release is pinned by exact Git commit as a development
dependency. Install with `npm ci`; the kit's guarded preparation supports Git
artifacts. Runtime consumers install the packed package without a Git dependency.

`npm run build` copies tokens, self-hosted fonts and licenses, mark artwork and
PWA icons into ignored, published `public/brand/`. Graph and calendar import
`tokens` from `pm-brand` through the browser palette bundle, with CSS variable
resolution for the active theme. There is no application-owned palette or font CDN.

See [brand review evidence](docs/brand-review.md) for the screenshot matrix,
pixel comparison, accessibility checks and behavioral revert proof.

## Human-agent decision inbox

Open **Decision inbox** in a selected project to compare pending requests, their
alternatives and evidence. Editors can approve an alternative or acknowledge
that they have read the evidence. View-only collaborators can read requests;
server-side permission checks reject their writes. A reason is required for
every response. Refresh after a conflict and inspect the new evidence before
submitting again. The browser preserves unsent reasoning when live activity
arrives.

An approval records the selected alternative in the plan's audited decision log.
It does not run code, approve plan execution, review code, resolve review findings,
complete plan steps or close tasks. An acknowledgment leaves the request pending.
Both response and listing receipts explicitly report `codeReview: false` and
`taskCompletion: false`. Independent review evidence still belongs to `pm-review`.

The extension exposes three commands. JSON and the default compact TOON use the
same typed result. List pages default to 20 rows, allow 1–50, and emit at most
16 KiB of JSON; `nextOffset` resumes pages shortened by either bound. `total`
counts pending requests across a certified complete tracker read. No raw tracker
items or audit histories are emitted in the inbox projection.

```sh
pm web inbox --limit 10 --json
pm web inbox --offset 10
pm web inbox request --input '{"planId":"demo-plan","question":"Which storage?","alternatives":["Local files","Shared database"],"evidence":"See docs/storage-comparison.md"}' --json
pm web inbox respond --input '{"planId":"demo-plan","requestId":"REQUEST_ID","revision":"REVISION_FROM_INBOX","action":"approve","alternative":1,"reason":"Remote collaborators need coordinated access."}' --json
```

Use an existing Plan id and the request id/revision returned by the inbox.
Alternatives use zero-based indexes. `action: "acknowledge"` omits `alternative`
and requires a reason. `PM_AUTHOR` or `--actor` identifies local CLI mutations;
local filesystem access grants CLI editing capability. HTTP derives the author
and capability from the authenticated session and current project membership,
never from request-body attribution.

The package exports `listDecisionInbox`, `requestDecision`, `respondToDecision`,
`DecisionInboxError` and their input/result types from its main entrypoint. See
[the executable SDK example](examples/decision-inbox.ts) and
[the inbox contract and validation report](docs/decision-inbox.md).
Embedding applications must provide an authenticated `DecisionActor`; the SDK's
capability parameter is an integration boundary, not an authentication service.

HTTP endpoints live under `/api/projects/:projectId/pm/decision-inbox`:
`GET ?limit=20&offset=0`, `POST /requests`, and `POST /responses`. Mutations require
the normal session, CSRF token and edit permission. Typed refusal payloads carry
`code` and `remedy`: `invalid_input` (400), `view_only` (403), `not_found` (404),
`revision_conflict` or `already_answered` (409), and `unavailable` or
`invalid_record` (503). Stored-record failures identify the Plan to inspect;
blank or repeated pagination values are invalid input. The CLI maps unavailable
dependencies and invalid stored records to `DEPENDENCY_FAILED`, preserving
`USAGE`, `NOT_FOUND` and `CONFLICT` for caller-input and revision refusals.

### Without git

Inbox reads, requests, acknowledgments and approvals work in ordinary initialized
tracker directories, without a Git executable or a repository. The inbox needs
no database when used through its SDK or CLI; the web server uses PostgreSQL for
accounts and project sharing. GitHub synchronization and repository provenance
still need their own repository/provider prerequisites. The public-data and
screenshot evidence scripts use Git only to extract committed baseline fixtures;
it is not on the inbox runtime path.

## Agent context workspace views

Open **Agent context** to inspect an authorized agent question, served context receipts and unresolved evidence gaps. Each packet requires explicit audience consent and an exact revision. Project sharing alone grants no packet access; revocation clears open packet views through realtime invalidation and bounded fallback checks, and blocks future retrieval. The UI preserves the API's omission reasons and remedies. Use the typed `AgentContextClient` or `pm web agent-context` for compact TOON/JSON access. See [the contract and CLI examples](docs/agent-context.md) and [typed SDK example](examples/agent-context.ts).

Agent context commands work from a plain tracker without git, contacting an explicitly selected authenticated pm-web server. The server uses its existing PostgreSQL database. Source receipts remain owned by core output sessions and pm-context; this view stores metadata rather than raw context, inference, or memory.

Content-bearing keyed responses recheck current permissions and resource visibility. Successful deletes and other previously successful mutations whose content is no longer readable return only status and identifiers to the original principal, so lost responses cannot wedge offline work. Own queued deletes also settle on terminal 404/410 with a visible notice. Every SSE connection immediately revalidates the displayed packet, including reconnections after backoff. See the [78-route replay authorization audit](docs/idempotency-replay.md).

## Backend contract explorer

Select **Backend contracts** to inspect the selected project's live SDK operations,
provider availability and input schemas. Missing providers keep review controls
disabled. The review form produces an unexecuted input preview; it never applies
changes. SDK adapters normalize directory, Postgres and remote contract readers.

```sh
pm web contracts --limit 10 --json
pm web contracts --action delete --input '{"id":"demo-1"}' --json
```

Use `exploreContracts`, `reviewContract` and `ContractExplorerClient` from the public
SDK. Pagination defaults to 20 operations (maximum 50), with explicit continuation.
See [availability, typed refusals and HTTP routes](docs/contract-explorer.md) and the
[SDK example](examples/contract-explorer.ts).

### Without git

Backend inspection and input previews work in plain initialized trackers with no
Git executable. An operation advertised by a package may still need Git when
executed separately; the explorer only reads its contract.

## Authorized resume change packets

After reviewing an authorized question and its publisher-selected items, admit a
baseline with `pm web agent-context resume`. On reconnect, pass the last accepted
`--cursor` to retrieve only selected changes with explicit missed-event,
completeness and byte-budget receipts. The typed `AgentContextClient.resume`
and Agent context UI use the same endpoint. Revoked access blocks future reads
and clears managed packet views; changed or missing history requires
reorientation. No second context store is created. See
[the resume contract and CLI examples](docs/resume-packets.md) and
[typed SDK example](examples/resume-packets.ts).

### Without git

Resume admission, catch-up and native TOON/JSON commands work in plain trackers
without a Git executable. The HTTP server requires its normal PostgreSQL
configuration and current project authorization.

## Permission impact previews

Before changing an existing user or group share, project owners can inspect which caller-visible context packets, pending decisions and known core agent operations would lose access. The sharing screen previews removal before confirmation. `pm web permission-impact --url https://pm.example.test --project <uuid> --share <uuid> --permission view --json` returns bounded counts and identities; omit `--json` for TOON. Set `PM_WEB_TOKEN` from your authenticated session. Preview changes no roles, packets or hosted configuration; unknown capabilities stay disabled.

Use the typed `PermissionImpactClient.preview` SDK, [example](examples/permission-impact.ts), and [contract and refusals](docs/permission-impact.md). These previews work without Git, including when no Git executable is installed.

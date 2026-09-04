# pm-web

Full web UI for [pm-cli](https://github.com/unbraind/pm-cli) — browse, create, update, search, dedupe-audit, validate and manage pm projects in the browser.

Features user auth, multi-project support, sharing, groups, GitHub import/sync, admin-only management, local Ollama semantic search configuration, and pm-graph/Neo4j relationship graphs. Hosted at **pm-web.unbrained.dev** or self-host via Docker.

---

## Quick Start (Self-Hosted)

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

```bash
pm install github.com/unbraind/pm-web --global
```

The package repository is at **github.com/unbraind/pm-web**.

### Commands

| Command | Description |
|---|---|
| `pm web` | Start the pm-web server (foreground) |
| `pm web --port 8080` | Start on a custom port |
| `pm web --detach` | Start the server in the background (tracked via a pidfile) |
| `pm web status` | Report whether a server is reachable (probes `/healthz`); `--json` supported |
| `pm web stop` | Stop a server previously started with `--detach`; `--json` supported |
| `pm web doctor` | Preflight diagnostics (Node, runtime deps, port, pm, workspace); `--json` supported |

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
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens |
| `PM_WEB_SECRET_KEY` | Recommended | At-rest encryption key for saved GitHub PATs. Falls back to `JWT_SECRET`; use at least 32 characters |
| `PM_WEB_BOOTSTRAP_ADMIN_EMAIL` | Recommended | Email of the user account to auto-promote to admin on schema init. Leave unset to skip auto-promotion (manage admins via the admin UI). |
| `PORT` | No | Server port (default: 4000) |
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
| `OIDC_ISSUER` | No | Provider issuer URL; setting any OIDC variable enables strict configuration validation |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | With OIDC | OIDC confidential client credentials |
| `OIDC_REDIRECT_URI` | With OIDC | Exact HTTPS callback URL ending in `/api/auth/oidc/callback` in production |
| `OIDC_COOKIE_SECRET` | With OIDC | Dedicated secret for signed, short-lived login state; at least 32 characters in production |
| `OIDC_SCOPES` | No | Requested scopes (default: `openid profile email`) |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | No | Reject identities without a provider-verified email when `true` |

New pm-web projects configure local Ollama search automatically and install the `pm-graph` package into the project workspace (from npm, via the per-project package catalog). Neo4j graph rows are scoped per pm-web project so syncing one project does not overwrite another.

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

Whole-project graph fallback, board, local search, iCalendar, and export reads
use the SDK's high-level `listAllComplete` operation. pm-web accepts those rows
only after the shared SDK certificate agrees. Since pm CLI 2026.8.31, the SDK
certifies the source counters, omission receipt, output receipt, and truncation
disclosure itself, so pm-web keeps just one supplemental check: it refuses an
`output_budget_exceeded` disclosure, which the SDK still accepts even though it
means the rows may be short of the whole corpus. The public `/pm/list-all`
HTTP compatibility route remains deliberately paginated for interactive clients,
but invokes canonical `list --all` internally; consumers that need the whole
workspace must use a complete-read endpoint rather than assembling a page as if
it were the corpus. The standalone server exact-pins pm CLI/SDK 2026.9.4, and
the extension manifest refuses older hosts through the same compatibility floor.
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
| `/api/groups` | Group management |
| `/api/projects/:id/shares` | Sharing |
| `/api/projects/:id/github` | GitHub integration |

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
- `GET /api/projects/:projectId/pm/graph` — dependency graph (existing).
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
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

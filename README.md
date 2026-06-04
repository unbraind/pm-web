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

Runs preflight checks before starting the server: Node version (>= 20), whether
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
| `NODE_ENV` | No | `production` enables caching |
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | No | Local Ollama endpoint for semantic pm search |
| `PM_OLLAMA_MODEL` | No | Embedding model for new projects, default `qwen3-embedding:0.6b` |
| `NEO4J_URI` | No | Neo4j Bolt URI for graph sync |
| `NEO4J_USER` / `NEO4J_USERNAME` | No | Neo4j username |
| `NEO4J_PASSWORD` | No | Neo4j password |
| `PM_GRAPH_EXTENSION_PATH` | No | Bundled pm-graph extension path, default `extensions/pm-graph` |

New pm-web projects configure local Ollama search automatically and install the bundled `pm-graph` extension into the project workspace. Neo4j graph rows are scoped per pm-web project so syncing one project does not overwrite another.

Saved GitHub personal access tokens are encrypted at rest before they are written to PostgreSQL. Existing plaintext tokens from older installs still work when read, and are replaced with encrypted values the next time the user saves a token.

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

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## New data endpoints (kanban board & search)

The pm data API now exposes board and search views, both driven by the
workspace's live `pm contracts` schema (so they reflect the installed pm CLI +
extensions):

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

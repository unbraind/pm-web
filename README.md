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

The package repository is at **github.com/unbraind/pm-web** (private while pre-release).

### Commands

| Command | Description |
|---|---|
| `pm web` | Start the pm-web server |
| `pm web --port 8080` | Start on a custom port |

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens |
| `PM_WEB_SECRET_KEY` | Recommended | At-rest encryption key for saved GitHub PATs. Falls back to `JWT_SECRET`; use at least 32 characters |
| `PORT` | No | Server port (default: 4000) |
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

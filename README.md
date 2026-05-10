# pm-web

Full web UI for [pm-cli](https://github.com/unbraind/pm-cli) — browse, create, update, search, dedupe-audit, validate and manage pm projects in the browser.

Features user auth, multi-project support, sharing & groups. Hosted at **pm-web.unbrained.dev** or self-host via Docker.

---

## Quick Start (Self-Hosted)

### Docker

```bash
docker build -t pm-web .
docker run -p 4000:4000 -e DATABASE_URL=postgres://... pm-web
```

### Node.js

```bash
git clone https://github.com/unbraind/pm-cli-web.git
cd pm-cli-web
npm install
npm run build

# Set environment variables
export PORT=4000
export DATABASE_URL=postgres://user:pass@localhost:5432/pmweb

npm start
```

Open http://localhost:4000 in your browser.

---

## Installation as pm Extension

```bash
pm extension install github.com/unbraind/pm-cli-web --global
```

### Commands

| Command | Description |
|---|---|
| `pm web` | Start the pm-web server |
| `pm web --port 8080` | Start on a custom port |

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 4000) |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens |
| `NODE_ENV` | No | `production` enables caching |

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

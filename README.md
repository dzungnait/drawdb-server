This is a simple server that serves as the backend for drawDB. It has 2 functions:

1. Send bug reports via email
2. Handle interfacing with the GitHub REST API

### Getting Started

Set up the environment variables by following `.env.sample`

```bash
git clone https://github.com/drawdb-io/drawdb-server.git
cd drawdb-server
npm install
npm start
```

### Docker Compose run in dev

```bash
docker compose up -d
```
## Accounts

With `DATABASE_URL` set, the server also provides accounts: email + password
sign-in, optional Google/GitHub sign-in, email verification and password
reset. Migrations in `migrations/` run automatically on start.

Run the tests against a disposable Postgres:

```bash
docker run -d --name drawdb-pg -e POSTGRES_USER=drawdb -e POSTGRES_PASSWORD=drawdb -e POSTGRES_DB=drawdb -p 55432:5432 postgres:16-alpine
docker exec drawdb-pg psql -U drawdb -c "create database drawdb_test"
npm test
```

### Deployment

Session cookies work best when the app and the API share a site. Two setups:

- **Same origin (recommended).** Run the frontend image with
  `API_PROXY_TARGET=<url of this server>` and `VITE_BACKEND_URL=/api`; nginx
  forwards `/api/*` here. Set `PUBLIC_API_URL=https://<app domain>/api`,
  `CLIENT_URLS=https://<app domain>`, `COOKIE_SAMESITE=lax`. On Railway, point
  `API_PROXY_TARGET` at the private address
  (`http://<service>.railway.internal:<PORT>`) and use `TRUST_PROXY=2`.
- **Separate sites** (e.g. two `*.up.railway.app` domains): set
  `COOKIE_SAMESITE=none`. Browsers that block third-party cookies (Safari)
  will not keep the session, so prefer a custom domain or the proxy above.

Self-hosted with Docker: `docker compose -f compose.prod.yaml --env-file .env up -d --build`.

### OAuth

A provider is enabled once both its client ID and secret are set. Register
`${PUBLIC_API_URL}/auth/oauth/google/callback` (Google Cloud Console →
OAuth client, type "Web application") or
`${PUBLIC_API_URL}/auth/oauth/github/callback` (GitHub → Settings →
Developer settings → OAuth Apps) as the callback URL.

### Live collaboration

People editing the same diagram see each other's changes, cursors and selections as they happen. It runs over Socket.IO on the same port as the API, at `/socket.io` (behind the frontend's nginx: `/api/socket.io`, which already forwards WebSocket upgrades). Any other proxy in front needs WebSocket upgrades enabled.

- While a diagram is open, the server keeps it in memory, applies everyone's edits in order and saves them every few seconds (and on shutdown). Editors connected live don't send whole-diagram saves.
- Edits are small operations (set a table's name, insert a field...), so changes to different things never overwrite each other; for the same value the last one to reach the server wins, and deleting something wins over editing it.
- Access is checked like the REST API: editors edit, viewers and view links watch. Removing someone, turning a link off or moving the diagram to the trash disconnects them right away.

Run a single instance: open diagrams live in that process's memory. (Several instances would need every editor of a diagram routed to the same one.)

### Teams

Anyone can create a team (they become its admin) and add people by email; addresses without an account get an invitation that turns into membership when they sign up, like diagram invitations. Admins manage members and can rename or delete the team; a team always keeps at least one admin.

A diagram's owner can share it with any team they're in, as editor or viewer. Everyone in the team gets that access (the best of it and any personal share counts), and it ends as soon as they leave the team or the share is removed, also for people with the diagram open. Diagrams still belong to a person: deleting a team only removes the access it gave.

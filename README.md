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

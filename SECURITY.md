# Security

## Model

EODView is a **single-user** app. It has no user accounts; it protects what matters as follows:

- **EODHD API key** — stays on the server (`server/data/config.json`, mode 0600, or `EODHD_API_KEY`). It is never sent
  to the browser, logged, or included in error messages.
- **Admin routes** (`/api/config`, `/api/tokens`, universe jobs/markets) — only loopback callers with a loopback
  `Host` and no proxy headers, or `Authorization: Bearer $EODVIEW_ADMIN_TOKEN` when that is set.
- **Agent API** (`/api/v1`, `/mcp`) — read-only; loopback callers or bearer tokens (stored as SHA-256 hashes,
  constant-time compare), per-token rate limits and a separate daily EODHD credit budget.
- **Cross-site requests** — `/ws` upgrades and state-changing `/api` requests from foreign origins are rejected;
  JSON bodies must be `application/json`.
- **Screener SQL** — every column is whitelisted and every value is a bound parameter.

Everything else (charts, watchlists, alerts, drawings, screener) is open to anyone who can reach the server.

## Running it on the internet

Put an authenticating proxy in front and tell the app it is proxied:

- Use Cloudflare Access (see [deploy/README.md](deploy/README.md)), an identity-aware proxy, or equivalent.
- Set `EODVIEW_ADMIN_TOKEN` and `EODVIEW_API_REQUIRE_TOKEN=1`. A reverse proxy on the same machine forwards requests
  from `127.0.0.1`; without these settings, those requests look local.
- Set `EODVIEW_ALLOWED_ORIGINS=https://your-host` if the public origin differs from the `Host` header the app sees.

## Secrets in this repository

None are committed. Deployment secrets live in Google Secret Manager, and local configuration lives in
`deploy/.env.local` and `server/data/`. Both are gitignored.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on GitHub rather than a public issue.

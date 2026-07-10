# YouYu Traffic Worker

Cloudflare Workers + D1 backend for YouYu client traffic reports.

## Deploy

```powershell
cd cloudflare/youyu-traffic
npx wrangler d1 create youyu_traffic
```

Copy the returned `database_id` into `wrangler.toml`, then run:

```powershell
npx wrangler d1 execute youyu_traffic --remote --file=./schema.sql
npx wrangler secret put REGISTRATION_PASSPHRASE
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Existing D1 databases should apply the migrations they have not run yet, in order:

```powershell
npx wrangler d1 execute youyu_traffic --remote --file=./migrations/2026-07-03-add-remote-subscription-url.sql
npx wrangler d1 execute youyu_traffic --remote --file=./migrations/2026-07-08-security-and-idempotency.sql
npx wrangler d1 execute youyu_traffic --remote --file=./migrations/2026-07-11-retention-cleanup.sql
```

Use your own private value for `REGISTRATION_PASSPHRASE`.

After deploy, put the Worker URL into:

```text
resources/traffic-api-url.txt
```

Then rebuild the Windows installers.

## Admin APIs

```http
GET /api/admin/users
Authorization: Bearer <ADMIN_TOKEN>
```

```http
GET /api/admin/users/<userId>/traffic
Authorization: Bearer <ADMIN_TOKEN>
```

```http
GET /api/admin/config
POST /api/admin/config
Authorization: Bearer <ADMIN_TOKEN>
```

`POST /api/admin/config` and per-user config accept `subscriptionUrl`. Leave it empty to avoid a remote subscription override.

```http
GET /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config/reset
Authorization: Bearer <ADMIN_TOKEN>
```

```http
GET /api/admin/anomalies
Authorization: Bearer <ADMIN_TOKEN>
```

```http
POST /api/admin/maintenance
Authorization: Bearer <ADMIN_TOKEN>
```

## Data retention

The Worker runs D1 maintenance every six hours through the Cron Trigger in `wrangler.toml`.
It keeps `traffic_reports` for 90 days as the idempotency audit window and removes only expired
`rate_limits` rows. Daily traffic totals in `traffic_daily` are not deleted. Report deletion is
bounded to 20 batches of 500 rows per table and invocation so a backlog cannot monopolize one Worker run.

The authenticated `POST /api/admin/maintenance` endpoint runs the same bounded cleanup on demand.
Use it after deploying the retention migration when an older database has a large backlog.

Run the Worker maintenance tests with Node.js 24 or newer:

```powershell
node --import tsx --test test/*.test.mjs
```

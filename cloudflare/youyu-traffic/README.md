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

For an existing D1 database, inspect the schema and migration plan first:

```powershell
node migrations/apply.mjs --remote --check
node migrations/apply.mjs --remote --dry-run
```

`--check` is read-only and exits with an error when any required Worker table, column, index, primary key, or unique
constraint is missing.
`--dry-run` prints the planned work without changing D1 schema or data. After reviewing the plan, apply it explicitly:

```powershell
node migrations/apply.mjs --remote --apply
```

Use `--local` instead of `--remote` for the local Wrangler database. The runner uses Wrangler's D1 commands, adds
`subscription_url` only when an existing table is missing it, applies the idempotent table/index migrations, and
validates the complete Worker schema. It refuses to write when the base `users`, `devices`, or `traffic_daily` schema
is incomplete or when a critical primary-key/unique constraint has drifted; initialize that database with `schema.sql`
first. Re-running it preserves existing subscription values.
It does not deploy the Worker.

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
Config request bodies are limited to 64 KiB. `directRules` and `proxyRules` accept at most 256 entries of 160 characters
each; invalid recognized fields are rejected instead of being silently ignored.

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

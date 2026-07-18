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
repairable columns only when an existing table is missing them, applies the idempotent table/index/data migrations,
and validates the complete Worker schema. It refuses to write when the base `users`, `devices`, or `traffic_daily`
schema is incomplete or when a critical primary-key/unique constraint has drifted; initialize that database with
`schema.sql` first. Re-running it preserves existing subscription values.
It does not deploy the Worker.

Use your own private value for `REGISTRATION_PASSPHRASE`.

`REGISTRATION_PASSPHRASE` is the authorization boundary for team profile selection. A client with the valid shared
passphrase may register a new name, attach another installation to an existing name, or move the current installation
to another existing name. The random `deviceKey` identifies an installation across local app-data resets without using
a hardware fingerprint; `deviceSeed` remains the independent request-signing secret. Older clients without a
`deviceKey` remain supported. The existing user's D1 identity, remote configuration, cumulative traffic totals, and
current-day traffic totals are reused.
Names are not separate credentials, so distribute this passphrase only to trusted team members and rotate it if it is
exposed. Repeating activation with the same device key or device seed and normalized name is idempotent.

The production Worker is exposed through the `youyu-api.fishknowsss.com` Custom Domain declared in `wrangler.toml`.
Cloudflare manages its DNS record and certificate; the existing `workers.dev` address remains available for legacy
diagnostics. After deploy, put the production Custom Domain URL into:

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

`POST /api/admin/config` and per-user config accept only `enabled`, `subscriptionUrl`, and `ruleProfile`. Supported
profiles are `ruleset` (智能规则) and `subscription` (机场规则). Leave the subscription empty to avoid a remote
subscription override. Config request bodies are limited to 64 KiB; removed controls are rejected instead of being
silently stored. Built-in direct/proxy protections remain client-owned, and traffic anomaly detection uses the fixed
1 GiB threshold. Compatibility responses still contain empty `directRules` / `proxyRules` arrays for older clients.

```http
GET /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config/reset
Authorization: Bearer <ADMIN_TOKEN>
```

User records can be previewed and merged through the authenticated admin page or these APIs:

```http
GET /api/admin/users/<sourceUserId>/merge-preview?targetUserId=<targetUserId>
POST /api/admin/users/<sourceUserId>/merge
Authorization: Bearer <ADMIN_TOKEN>
```

The merge keeps the source name as an alias, moves its devices and traffic to the canonical target, and keeps already
registered source devices working. When both users have different overrides, the POST body must explicitly choose
`keep_target`, `use_source`, or `reset_to_global`; the operation is audited and idempotent. The user list reports a
logical device count while retaining the raw registration-row count for audit purposes.

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

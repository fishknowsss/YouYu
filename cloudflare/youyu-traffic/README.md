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

Existing D1 databases created before remote subscription support need this one-time migration:

```powershell
npx wrangler d1 execute youyu_traffic --remote --file=./migrations/2026-07-03-add-remote-subscription-url.sql
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

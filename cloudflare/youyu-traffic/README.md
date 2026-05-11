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

Use `yaoyaoba118` for `REGISTRATION_PASSPHRASE`.

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

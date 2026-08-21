# YouYu Traffic Worker

Cloudflare Workers + D1 backend for YouYu client traffic reports.

## Production deployment

Routine production changes use `.github/workflows/deploy-worker.yml`. The workflow has no automatic trigger: it accepts
only `workflow_dispatch`, requires an exact lowercase 40-character `commit_sha`, and requires the dispatcher to set
`confirm_production`. It must be dispatched from `main`, and the requested SHA must equal the exact `main` commit that
defines that workflow run. Both jobs check out and verify that commit instead of deploying a moving branch tip.

The `prepare` job has read-only repository permissions and no deployment environment or secret access. It runs repository
hygiene, Worker tests, Worker typecheck, and the existing Wrangler dry-run build. The `deploy` job cannot start until the
`production-worker` GitHub Environment approves it. Configure that environment outside the repository with required
reviewers and least-privilege `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` values; store only those secret names in
workflow source, never their values. After required reviewers and environment protections are active, define the
non-secret environment variable `YOUYU_WORKER_DEPLOY_ENABLED=enabled`; the deploy job fails closed before any remote
operation when that marker is absent or different. Cloudflare credentials are injected only into the individual remote
schema/migration/deploy steps, not into the preparation job, smoke request, audit step, or the deploy job as a whole.
Restrict the Environment deployment branch policy to `main` so a branch cannot replace the workflow-side checks.

After approval, the protected job performs this fixed sequence against the same commit:

1. read-only remote schema check (recorded even when pending migrations make it non-green);
2. remote migration dry-run;
3. explicit remote migration apply;
4. post-apply schema check;
5. Worker deploy;
6. bounded HTTPS smoke request to `https://youyu-api.fishknowsss.com/`;
7. a secret-free `$GITHUB_STEP_SUMMARY` audit with commit, actor, run/attempt, environment, and precheck outcome.

The workflow does not upload Wrangler output, environment dumps, D1 rows, or raw failure logs as artifacts. D1 migration
files are designed to be repeatable, but the runner uses multiple remote commands rather than one database-wide
transaction; an authorized operator must have a reviewed recovery plan before approving production apply.

A failed dry-run, apply, post-check, deploy, or smoke stops the workflow. Dispatching the workflow, configuring its
protected environment, and approving production are operational actions; local development and CI validation do not do
any of them automatically.

For local or pre-review inspection, use the migration runner explicitly:

```powershell
node cloudflare/youyu-traffic/migrations/apply.mjs --remote --check
node cloudflare/youyu-traffic/migrations/apply.mjs --remote --dry-run
```

`--check` is read-only and exits with an error when any required Worker table, column, index, primary key, or unique
constraint is missing. `--dry-run` prints the planned work without changing D1 schema or data. `--apply` is deliberately
reserved for the approved production job (or a separately authorized recovery) and does not deploy the Worker.

Use `--local` instead of `--remote` for the local Wrangler database. The runner uses Wrangler's D1 commands, adds
repairable columns only when an existing table is missing them, applies the idempotent table/index/data migrations,
and validates the complete Worker schema. It refuses to write when the base `users`, `devices`, or `traffic_daily`
schema is incomplete or when a critical primary-key/unique constraint has drifted; initialize a new local database with
`schema.sql` first. Re-running it preserves existing subscription values, administrator-edited traffic limits,
subscription-period starts, and expiry times.

A first-time Cloudflare account/database bootstrap remains a separate, explicitly authorized operation. Do not place
`REGISTRATION_PASSPHRASE`, `ADMIN_TOKEN`, Cloudflare tokens, or their values in this repository, workflow inputs, logs,
or job summaries.

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

The browser admin keeps `ADMIN_TOKEN` only in the current page's JavaScript closure. It clears the password input
before requests settle and never writes the token to web storage, URLs, rendered markup, or logs. The page loads its
script as a same-origin static asset under a CSP that disallows inline scripts.

All JSON write endpoints require an `application/json` media type, reject unknown fields, preflight declared body
sizes, and enforce the same byte limit while streaming UTF-8. Error responses use the stable
`{ error, code, requestId }` envelope and repeat `requestId` in `x-request-id`; JSON responses are non-cacheable.

```http
GET /api/admin/users
Authorization: Bearer <ADMIN_TOKEN>
```

```http
GET /api/admin/users/<userId>/traffic
Authorization: Bearer <ADMIN_TOKEN>
```

`/api/admin/users`, `/api/admin/users/<userId>/traffic`, and `/api/admin/anomalies` accept `limit` (1–200) and
`offset` (0–1,000,000). Each response includes `page.limit`, `page.offset`, `page.returned`, `page.hasMore`, and
`page.nextOffset`. The admin page follows these bounded pages instead of relying on silently truncated SQL results;
it fails explicitly if one view would exceed its 5,000-row in-memory safety limit.

Each user-list item also includes `latestAppVersion` and `appVersionReportedAt`. They come from the most recently
seen device row that has a non-empty version, populated by activation, authenticated `GET /api/config`, or authenticated
traffic reporting. They are inventory metadata, not a live-online signal. New desktop builds label internal and
no-pet channels as `-IN` and `-NO`; older clients can legitimately report an unlabelled version string.

Each user-list item also includes `notice`. It is `null` when the user has no notice row; otherwise it contains the
current `revision`, `enabled`, `tone`, `expiresAt`, `acknowledgedCount`, and `deviceCount`. `acknowledgedCount` is the
number of device rows that have acknowledged the current revision. The admin page uses this for the compact `已读`
column (`1/2` or `—`).

```http
GET /api/admin/config
POST /api/admin/config
Authorization: Bearer <ADMIN_TOKEN>
```

`POST /api/admin/config` accepts `enabled`, `canEditManagedConfig`, `subscriptionUrl`, `ruleProfile`,
`preferredRegion`, and `regionFallback`; per-user config accepts the same managed settings except
`canEditManagedConfig`, which uses its separate permission endpoint. Supported profiles are `ruleset` (智能规则) and
`subscription` (机场规则). Supported regions are `auto`, `jp`, `hk`, `tw`, `sg`, `us`, and `kr`; `regionFallback` is
`global` (try other healthy regions and notify) or `strict` (do not cross regions). The global defaults are `jp`,
`global`, and permission to edit managed config. A per-user `null` clears that field's override so it inherits the
global value. Leave the subscription empty to avoid a remote subscription override.
Config request bodies are limited to 64 KiB; removed controls are rejected instead of being silently stored. Built-in
direct/proxy protections remain client-owned, and traffic anomaly detection uses the fixed 1 GiB threshold.
Compatibility responses still contain empty `directRules` / `proxyRules` arrays for older clients.

Authenticated clients can save the two settings exposed in professional mode through the same signed config endpoint:

```http
POST /api/config
Content-Type: application/json
X-YouYu-Timestamp: <milliseconds>
X-YouYu-Signature: <device HMAC>

{ "userId": "...", "deviceId": "...", "requestId": "<uuid>", "subscriptionUrl": "https://...", "ruleProfile": "subscription" }
```

New clients also send the same UUID in `X-YouYu-Request-Id`; it is covered by the body-bound device signature. The
Worker retains the completed result for 10 minutes, so a timeout retry with the same signed request returns the same
state with `alreadyApplied: true` instead of advancing the config version or repeating the write. Reusing an ID with a
different signed payload conflicts. Older clients that omit `requestId` remain accepted during the compatibility
window and keep the existing last-writer-wins behavior.

The Worker only accepts `subscriptionUrl` and `ruleProfile`; status, region policy, and other admin-owned fields cannot
be changed by a client. Client writes follow the global
`canEditManagedConfig` policy, which defaults to allowed. The user drawer can keep following that global value or set
an explicit per-user exception through the authenticated endpoint:

```http
POST /api/admin/users/<userId>/config-permission
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{ "canEditManagedConfig": false }
```

The per-user value accepts `true`, `false`, or `null`; `null` restores inheritance. Signed `GET /api/config` responses
include the effective `config.canEditManagedConfig` capability, so the desktop can disable managed-setting edits even
when its hidden professional mode is open. Revoking the capability blocks later client writes without silently
deleting an existing config override; resetting that user's config remains a separate admin action. A differing value becomes a per-user
override immediately, so the admin user drawer reports `单独配置`. A value equal to the current global value clears
that field's override. Resetting the user to `跟随全局` removes the override, and the next automatic or manual client
sync applies the current global config. Concurrent admin and client actions use the order in which D1 successfully
commits them; the last successful write is authoritative. The client write compares its desired values with the
current global row inside the same SQL statement, avoiding a stale global snapshot. Client responses include
`configSource` as `global` or
`user`, allowing the desktop UI to show the same ownership that the Worker and Mihomo runtime actually use.

The subscription traffic period is an admin-only dashboard setting and is never included in client or per-user remote
configuration responses:

```http
GET /api/admin/traffic-limit
POST /api/admin/traffic-limit
Authorization: Bearer <ADMIN_TOKEN>
```

`POST /api/admin/traffic-limit` accepts `trafficLimitBytes`, `trafficPeriodStartedAt`, `trafficExpiresAt`, or any
combination of those fields. The limit must be a positive safe integer. Both timestamps must be complete ISO 8601
values with `Z` or an explicit offset, are stored in UTC, and the start must be earlier than the expiry.
Traffic-period limits and timestamps are administrator-owned live state. Values recorded in repository history are
examples only and must not be treated as the current production period; inspect the authenticated endpoint immediately
before an authorized operational change.

The response sums trusted `traffic_reports` whose server receipt time is at or after the configured start and before
the configured expiry, across active, unmerged users. Changing the start opens a new reporting period without deleting
or rewriting historical daily totals. Because desktop clients report about every two minutes, a start placed between
two reports can include the first report interval that crosses the boundary. Remaining traffic never goes below zero,
usage percentage is capped at 100%, and the dashboard has no overage state because the upstream subscription enforces
its own hard limit.

The overview traffic chart uses authenticated aggregate data:

```http
GET /api/admin/traffic-trend?range=hour|day|month
Authorization: Bearer <ADMIN_TOKEN>
```

`hour` returns Shanghai-time hourly buckets for the current day from trusted server receipt times in
`traffic_reports`; `day` returns the latest 30 calendar days and `month` returns the latest 12 calendar months from
`traffic_daily`. Missing buckets are filled with zero and all ranges include only active, unmerged users.

```http
GET /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config
POST /api/admin/users/<userId>/config/reset
Authorization: Bearer <ADMIN_TOKEN>
```

Administrators can correct a displayed user name without changing the stable user or device IDs:

```http
GET /api/admin/users/<userId>/profile
POST /api/admin/users/<userId>/profile
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{ "name": "corrected name", "requestId": "<uuid>" }
```

The rename is audited and idempotent by `requestId`. Both the old and new normalized names remain aliases of the same
canonical user, so an older client cannot recreate a duplicate account under the old spelling. A name already owned
by another canonical user is rejected. The signed client config response includes the canonical profile; the client
updates its local display name only when `profile.userId` still matches its current verified identity. For a device
whose server-side user was merged, the response keeps the request's verified alias ID in `profile.userId` while using
the canonical target name, so existing installations can accept the corrected display name without changing IDs.

The same admin view can manage one revisioned, plain-text notice per user, or fan the same notice out to selected
users:

```http
GET /api/admin/users/<userId>/notice
POST /api/admin/users/<userId>/notice
POST /api/admin/users/<userId>/notice/reset
POST /api/admin/notices/broadcast
POST /api/admin/notices/reset
Authorization: Bearer ***
Content-Type: application/json

{ "enabled": true, "message": "今晚维护", "tone": "warning", "durationMinutes": 10, "requestId": "<uuid>" }
```

`GET /api/admin/users/<userId>/notice` also returns `acknowledgements`, `acknowledgedCount`, and `deviceCount`. Each
acknowledgement row is a device with `deviceId`, `deviceName`, `lastSeenAt`, and `acknowledgedAt` (`null` when unread).

`POST /api/admin/notices/broadcast` accepts `userIds` (1–200 unique UUIDs), `message`, `tone`, `durationMinutes`, and
`requestId`. It writes the same enabled notice to each selected user through the existing per-user notice slot, so
current 1.7.x clients receive it without an app update. Duplicate IDs are ignored. The Worker persists one result per
target: eligible users are sent independently, while unknown, merged, or inactive users are reported as failures
without rolling back successful targets. A retry with the same payload processes only prior failures; completed
targets do not advance their revision or repeat side effects. A changed payload conflicts. The response reports the
persisted `sent` and `alreadyApplied` counts, the `failed` target list, and per-user results.

`POST /api/admin/notices/reset` accepts `{ "userIds": [...], "requestId": "<uuid>" }` and uses the same persisted
per-target retry semantics when stopping delivery for multiple users.

Messages are limited to 500 characters and are data only: no HTML, link, command, or rich-content field is accepted.
Only `info` and `warning` tones are supported. `durationMinutes` defaults to 10, must be an integer multiple of 5
from 5 through 10,080 (7 days), and is converted to `expiresAt` by the Worker clock. The old `expiresAt` input field
is rejected. Each new save advances the revision and clears stale acknowledgements.
Active, unexpired notices are returned only to the selected user's devices. A device acknowledges its current revision
through signed `POST /api/notices/acknowledge`; the Worker verifies the existing per-device HMAC before storing the
acknowledgement. Retrying the same `requestId` with identical data returns the original result without advancing the
revision or resetting the server-calculated expiry; reusing that ID with different data returns a conflict. A fresh
request ID deliberately restarts the duration and advances the revision so the new content appears again. The reset
route stops delivery without relying on client state.

User records can be previewed and merged through the authenticated admin page or these APIs:

```http
GET /api/admin/users/<sourceUserId>/merge-preview?targetUserId=<targetUserId>
POST /api/admin/users/<sourceUserId>/merge
Authorization: Bearer <ADMIN_TOKEN>
```

The merge keeps every source name alias, moves its devices and traffic to the canonical target, and keeps already
registered source devices working. If the target has no notice, the source notice and matching device acknowledgements
move with its devices together with its recorded duration; otherwise the target notice wins and source acknowledgements cannot suppress it. Notice and
configuration fingerprints are checked inside the merge batch so a concurrent admin edit aborts safely. When both users
have different overrides, the POST body must explicitly choose
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
It keeps the detailed `traffic_reports` audit rows for 90 days and removes expired `rate_limits` and
`device_request_nonces` rows in bounded batches.
The compact `traffic_report_dedup` proof (report id, canonical traffic-mutation hash, traffic date, and anomaly bit)
is retained permanently, so a response-lost retry cannot be counted again after the audit row expires. Reusing a
report id with a different device, byte delta, or normalized report timestamp is rejected. Mergeable user aliases and
`appVersion` metadata are deliberately excluded from the hash so a legitimate delayed retry remains compatible after
a merge or app update. Daily traffic totals in `traffic_daily` are not deleted. Report
deletion is bounded to 20 batches of 500 rows per table and invocation so a backlog cannot monopolize one Worker run.
`traffic_daily` remains the permanent historical aggregate. The current subscription-period calculation uses the
detailed `traffic_reports`; the configured monthly period therefore remains fully covered by the 90-day audit-row
retention window.

Exact deduplication has a deliberate storage tradeoff: UUID v4 report ids are unordered, so one high-water mark cannot
prove that an arbitrary old id was already accepted. Only reports with a non-zero traffic mutation receive a permanent
proof; zero-traffic heartbeats update device presence and return current totals without reserving their report id. At
the current two-minute client interval the theoretical worst case is still 720 proof rows per device per day (262,800
per year) when every interval contains traffic, while an idle device adds none. New rows keep only the four proof fields
above and use a `WITHOUT ROWID` table. Columns prefixed with `legacy_` exist only to backfill pre-migration audit rows
and are cleared when such a row is first retried. Each maintenance response exposes row count, estimated payload
bytes, oldest/newest traffic date, and configured budgets for the permanent proof table. The current warning budgets
are 5,000,000 rows or 1 GiB estimated payload; crossing either emits the structured
`traffic_report_dedup_capacity_warning` event. Maintenance never deletes `traffic_report_dedup` rows.

A compatible future evolution can add an additive per-device sequence state and capability-negotiated dual protocol.
Sequence-capable reports must retain the current payload-hash conflict rule, while UUID report IDs and permanent
tombstones continue to serve legacy clients. Tombstone retirement is deferred until legacy traffic is observably gone
and sequence-state backfill has been verified; this phase performs no dedup cleanup.

The authenticated `POST /api/admin/maintenance` endpoint runs the same bounded cleanup on demand.
Use it after deploying the retention migration when an older database has a large backlog.

## Deferred protocol compatibility designs

Shared-passphrase registration is unchanged in this phase. A future additive flow can issue short-lived, single-use
invite tokens bound to the approved user and `deviceKey` identity, record approval/revocation audit events, and rotate
overlapping passphrase identifiers without changing existing long-lived device credentials. The legacy registration
path must remain available until capable clients have completed the migration.

Configuration remains server-ordered last-writer-wins in this phase. A future optional `revision` / `expectedRevision`
contract can let capable clients receive a conflict with the current revision, while legacy requests continue through
the existing behavior. Revision enforcement must not become mandatory until old clients have aged out.

Run the complete Worker test suite with Node.js 24 or newer:

```powershell
node --import tsx --test test/*.test.mjs
```

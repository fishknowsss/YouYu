import { adminPage } from './adminPage';
import { ADMIN_SCRIPT } from './adminScript';
import { ADMIN_STYLES } from './adminStyles';

export interface Env {
  DB: D1Database;
  REGISTRATION_PASSPHRASE: string;
  ADMIN_TOKEN?: string;
}

type ActivateInput = {
  name?: string;
  passphrase?: string;
  deviceSeed?: string;
  deviceKey?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
};

type TrafficReportInput = {
  reportId?: string;
  userId?: string;
  deviceId?: string;
  uploadDelta?: number;
  downloadDelta?: number;
  reportedAt?: string;
  appVersion?: string;
};

type TrafficReportDedupRow = {
  payloadHash: string | null;
  trafficDate: string;
  anomaly: number;
  legacyDeviceId: string | null;
  legacyUploadDelta: number | null;
  legacyDownloadDelta: number | null;
  legacyReportedAt: string | null;
};

type TrafficReportAuditRow = {
  deviceId: string;
  uploadDelta: number;
  downloadDelta: number;
  reportedAt: string;
  trafficDate: string;
};

type TrafficSummary = {
  date: string;
  totalUpload: number;
  totalDownload: number;
  deviceTotalUpload: number;
  deviceTotalDownload: number;
  todayUpload: number;
  todayDownload: number;
  updatedAt: string;
};

type RemoteConfigInput = {
  enabled?: boolean | null;
  subscriptionUrl?: string | null;
  ruleProfile?: string | null;
  preferredRegion?: string | null;
  regionFallback?: string | null;
};

type ClientConfigUpdateInput = {
  userId?: unknown;
  deviceId?: unknown;
  subscriptionUrl?: unknown;
  ruleProfile?: unknown;
};

type UserProfileInput = {
  name?: unknown;
  requestId?: unknown;
};

type UserNoticeInput = {
  enabled?: unknown;
  message?: unknown;
  tone?: unknown;
  durationMinutes?: unknown;
  requestId?: unknown;
};

type UserNoticeAcknowledgementInput = {
  userId?: unknown;
  deviceId?: unknown;
  revision?: unknown;
};

type AdminTrafficLimitInput = {
  trafficLimitBytes?: unknown;
  trafficExpiresAt?: unknown;
};

type AdminTrafficLimitRow = {
  trafficLimitBytes?: number | null;
  trafficExpiresAt?: string | null;
  uploadBytes?: number | null;
  downloadBytes?: number | null;
};

type AdminTrafficLimitSummary = {
  trafficLimitBytes: number;
  trafficExpiresAt: string;
  uploadBytes: number;
  downloadBytes: number;
  usedBytes: number;
  remainingBytes: number;
  exceededBytes: number;
  usagePercent: number;
};

type AdminTrafficTrendRange = 'hour' | 'day' | 'month';

type AdminTrafficTrendRow = {
  bucket?: string | null;
  uploadBytes?: number | null;
  downloadBytes?: number | null;
};

type AdminTrafficTrendPoint = {
  key: string;
  label: string;
  uploadBytes: number;
  downloadBytes: number;
};

type RemoteConfigRow = {
  version?: number;
  enabled?: number | null;
  subscription_url?: string | null;
  rule_profile?: string | null;
  preferred_region?: string | null;
  region_fallback?: string | null;
  preferred_node?: string | null;
  preferred_strategy?: string | null;
  direct_rules?: string | null;
  proxy_rules?: string | null;
  anomaly_threshold_bytes?: number | null;
  updated_at?: string | null;
};

type UserRemoteConfigRow = {
  enabled?: number | null;
  subscription_url?: string | null;
  rule_profile?: string | null;
  preferred_region?: string | null;
  region_fallback?: string | null;
  preferred_node?: string | null;
  preferred_strategy?: string | null;
  direct_rules?: string | null;
  proxy_rules?: string | null;
  updated_at?: string | null;
};

type EffectiveDeviceConfigRow = RemoteConfigRow & {
  user_enabled?: number | null;
  user_subscription_url?: string | null;
  user_rule_profile?: string | null;
  user_preferred_region?: string | null;
  user_region_fallback?: string | null;
  user_updated_at?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  profile_updated_at?: string | null;
  notice_revision?: number | null;
  notice_enabled?: number | null;
  notice_message?: string | null;
  notice_tone?: string | null;
  notice_expires_at?: string | null;
  notice_updated_at?: string | null;
  notice_acknowledged_at?: string | null;
};

type RemoteControlConfig = {
  version: number;
  enabled: boolean;
  configSource: 'global' | 'user';
  subscriptionUrl?: string;
  ruleProfile?: string;
  preferredRegion: 'auto' | 'jp' | 'hk' | 'tw' | 'sg' | 'us' | 'kr';
  regionFallback: 'strict' | 'global';
  directRules: string[];
  proxyRules: string[];
  anomalyThresholdBytes: number;
  updatedAt: string;
};

type RemoteUserProfile = {
  userId: string;
  name: string;
  updatedAt: string;
};

type RemoteUserNotice = {
  revision: number;
  message: string;
  tone: 'info' | 'warning';
  expiresAt: string;
  updatedAt: string;
};

type EffectiveClientState = {
  config: RemoteControlConfig;
  profile: RemoteUserProfile;
  notice?: RemoteUserNotice;
};

type UserMergeInput = {
  targetUserId?: string;
  configResolution?: 'keep_target' | 'use_source' | 'reset_to_global';
  requestId?: string;
};

type AdminPagination = {
  limit: number;
  offset: number;
};

const TRAFFIC_REPORT_RETENTION_DAYS = 90;
const RETENTION_DELETE_BATCH_SIZE = 500;
const RETENTION_MAX_REPORT_BATCHES = 20;
const ADMIN_COLLECTION_MAX_PAGE_SIZE = 200;
const ADMIN_COLLECTION_MAX_OFFSET = 1_000_000;
const ADMIN_USERS_DEFAULT_PAGE_SIZE = 200;
const ADMIN_TRAFFIC_DEFAULT_PAGE_SIZE = 60;
const ADMIN_ANOMALIES_DEFAULT_PAGE_SIZE = 100;
const JSON_REQUEST_MAX_BODY_BYTES = 16 * 1024;
const ADMIN_CONFIG_MAX_BODY_BYTES = 64 * 1024;
const ACTIVATION_MAX_NAME_LENGTH = 80;
const USER_NOTICE_MAX_MESSAGE_LENGTH = 500;
const ACTIVATION_MAX_DEVICE_NAME_LENGTH = 120;
const ACTIVATION_MAX_PLATFORM_LENGTH = 32;
const ACTIVATION_MAX_APP_VERSION_LENGTH = 64;
const USER_NOTICE_DEFAULT_DURATION_MINUTES = 10;
const USER_NOTICE_MIN_DURATION_MINUTES = 5;
const USER_NOTICE_DURATION_STEP_MINUTES = 5;
const USER_NOTICE_MAX_DURATION_MINUTES = 7 * 24 * 60;
const TRAFFIC_TIME_ZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
const ANOMALY_THRESHOLD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TRAFFIC_LIMIT_BYTES = 3148 * 1024 * 1024 * 1024;
const DEFAULT_TRAFFIC_EXPIRES_AT = '2026-08-11T20:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RetentionCleanupResult = {
  cutoff: string;
  deletedReportRows: number;
  deletedRateLimitRows: number;
  reportBatchLimitReached: boolean;
  rateLimitBatchLimitReached: boolean;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let response: Response;
    let errorCode: string | undefined;
    try {
      response = await dispatchRequest(request, env, url);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'internal error';
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      errorCode = code;
      response = json({ error: message, code, requestId }, status);
    }
    const finalized = withRequestId(response, requestId);
    logRequestTelemetry(request, url, finalized.status, requestId, Date.now() - startedAt, errorCode);
    return finalized;
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      cleanupExpiredData(env, controller.scheduledTime).catch((error) => {
        console.error({
          event: 'retention_cleanup_error',
          scheduledTime: controller.scheduledTime,
          errorCode: 'D1_MAINTENANCE_FAILED'
        });
        throw error;
      })
    );
  }
};

async function dispatchRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return optionsResponse();
  if (request.method === 'POST' && url.pathname === '/api/activate') return activate(request, env);
  if (request.method === 'POST' && url.pathname === '/api/traffic/report') return reportTraffic(request, env);
  if (request.method === 'POST' && url.pathname === '/api/notices/acknowledge') {
    return acknowledgeUserNotice(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return getClientConfig(request, env);
  if (request.method === 'POST' && url.pathname === '/api/config') return updateClientConfig(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/users') {
    await requireAdmin(request, env);
    return listUsers(env, parseAdminPagination(url, ADMIN_USERS_DEFAULT_PAGE_SIZE));
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/config') {
    await requireAdmin(request, env);
    return getAdminConfig(env);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/config') {
    await requireAdmin(request, env);
    return updateAdminConfig(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/traffic-limit') {
    await requireAdmin(request, env);
    return getAdminTrafficLimit(env);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/traffic-limit') {
    await requireAdmin(request, env);
    return updateAdminTrafficLimit(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/traffic-trend') {
    await requireAdmin(request, env);
    return getAdminTrafficTrend(env, url.searchParams.get('range'));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/config/sync-users') {
    await requireAdmin(request, env);
    await requireEmptyBody(request);
    return syncGlobalConfigToUsers(env);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/maintenance') {
    await requireAdmin(request, env);
    await requireEmptyBody(request);
    return json({ ok: true, cleanup: await cleanupExpiredData(env) });
  }
  if (request.method === 'GET' && url.pathname === '/admin/assets/app.css') {
    return staticAsset(ADMIN_STYLES, 'text/css; charset=utf-8');
  }
  if (request.method === 'GET' && url.pathname === '/admin/assets/app.js') {
    return staticAsset(ADMIN_SCRIPT, 'text/javascript; charset=utf-8');
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
    return new Response(adminPage(), {
      headers: {
        'cache-control': 'no-store, no-transform',
        'content-security-policy':
          "default-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
        'content-type': 'text/html; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      }
    });
  }
  const userTrafficMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/traffic$/);
  if (request.method === 'GET' && userTrafficMatch) {
    await requireAdmin(request, env);
    return getUserTraffic(env, userTrafficMatch[1], parseAdminPagination(url, ADMIN_TRAFFIC_DEFAULT_PAGE_SIZE));
  }
  const userProfileMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/profile$/);
  if (userProfileMatch) {
    await requireAdmin(request, env);
    if (request.method === 'GET') return getAdminUserProfile(env, userProfileMatch[1]);
    if (request.method === 'POST') return updateAdminUserProfile(request, env, userProfileMatch[1]);
  }
  const userNoticeMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/notice$/);
  if (userNoticeMatch) {
    await requireAdmin(request, env);
    if (request.method === 'GET') return getAdminUserNotice(env, userNoticeMatch[1]);
    if (request.method === 'POST') return updateAdminUserNotice(request, env, userNoticeMatch[1]);
  }
  const userNoticeResetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/notice\/reset$/);
  if (request.method === 'POST' && userNoticeResetMatch) {
    await requireAdmin(request, env);
    await requireEmptyBody(request);
    return resetAdminUserNotice(env, userNoticeResetMatch[1]);
  }
  const userMergePreviewMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/merge-preview$/);
  if (request.method === 'GET' && userMergePreviewMatch) {
    await requireAdmin(request, env);
    return previewAdminUserMerge(request, env, userMergePreviewMatch[1]);
  }
  const userMergeMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/merge$/);
  if (request.method === 'POST' && userMergeMatch) {
    await requireAdmin(request, env);
    return mergeAdminUser(request, env, userMergeMatch[1]);
  }
  const userConfigMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config$/);
  if (userConfigMatch) {
    await requireAdmin(request, env);
    if (request.method === 'GET') return getAdminUserConfig(env, userConfigMatch[1]);
    if (request.method === 'POST') return updateAdminUserConfig(request, env, userConfigMatch[1]);
  }
  const userConfigResetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config\/reset$/);
  if (request.method === 'POST' && userConfigResetMatch) {
    await requireAdmin(request, env);
    await requireEmptyBody(request);
    return resetAdminUserConfig(env, userConfigResetMatch[1]);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/anomalies') {
    await requireAdmin(request, env);
    return listAnomalies(env, parseAdminPagination(url, ADMIN_ANOMALIES_DEFAULT_PAGE_SIZE));
  }
  throw new HttpError(404, 'not found');
}

async function activate(request: Request, env: Env): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES)) as ActivateInput;
  assertOnlyFields(
    input,
    ['name', 'passphrase', 'deviceSeed', 'deviceKey', 'deviceName', 'platform', 'appVersion'],
    'unsupported activation field'
  );
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new HttpError(400, 'missing name');
  if (!isBoundedText(name, ACTIVATION_MAX_NAME_LENGTH)) throw new HttpError(400, 'invalid name');

  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new HttpError(400, 'invalid name');

  if (input.passphrase !== undefined && typeof input.passphrase !== 'string') {
    throw new HttpError(400, 'invalid passphrase');
  }
  const passphrase = typeof input.passphrase === 'string' ? input.passphrase.trim() : '';
  if (passphrase && !isBoundedText(passphrase, 512)) throw new HttpError(400, 'invalid passphrase');
  const deviceSeed = typeof input.deviceSeed === 'string' ? input.deviceSeed.trim() : '';
  if (!deviceSeed) throw new HttpError(400, 'missing device');
  if (!isUuid(deviceSeed)) throw new HttpError(400, 'invalid device');
  const deviceKey = typeof input.deviceKey === 'string' ? input.deviceKey.trim().toLowerCase() : '';
  if (deviceKey && !isUuid(deviceKey)) throw new HttpError(400, 'invalid device key');

  const deviceName = normalizeActivationText(
    input.deviceName,
    ACTIVATION_MAX_DEVICE_NAME_LENGTH,
    'invalid device name'
  );
  const platform = normalizeActivationText(input.platform, ACTIVATION_MAX_PLATFORM_LENGTH, 'invalid platform');
  if (platform && !/^[A-Za-z0-9._-]+$/.test(platform)) throw new HttpError(400, 'invalid platform');
  const appVersion = parseAppVersion(input.appVersion);

  const now = new Date().toISOString();

  const expectedPassphrase = env.REGISTRATION_PASSPHRASE?.trim();
  if (!expectedPassphrase) {
    throw new HttpError(503, 'registration disabled');
  }
  const clientIp = getClientIp(request);
  const rateLimitKey = `activate:${clientIp}:${normalizedName || 'unknown'}`;
  const ipRateLimitKey = `activate:${clientIp}`;
  await Promise.all([
    consumeRateLimitAttempt(env, rateLimitKey, 8, 15 * 60 * 1000),
    consumeRateLimitAttempt(env, ipRateLimitKey, 24, 15 * 60 * 1000)
  ]);
  if (!constantTimeEqual(passphrase, expectedPassphrase)) {
    throw new HttpError(403, 'invalid passphrase');
  }
  await Promise.all([clearRateLimit(env, rateLimitKey), clearRateLimit(env, ipRateLimitKey)]);

  const proposedUserId = crypto.randomUUID();
  const proposedDeviceId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, name, normalized_name, status, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM user_name_aliases WHERE normalized_name = ?
       )`
    ).bind(proposedUserId, name, normalizedName, 'active', now, normalizedName),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_name_aliases (normalized_name, user_id, created_at)
       SELECT users.normalized_name, COALESCE(users.merged_into_user_id, users.id), ?
       FROM users
       WHERE users.normalized_name = ?`
    ).bind(now, normalizedName),
    env.DB.prepare(
      `INSERT OR IGNORE INTO devices
         (id, user_id, device_seed, device_key, device_name, platform, app_version, first_seen_at, last_seen_at)
       SELECT ?, canonical.id, ?, ?, ?, ?, ?, ?, ?
       FROM user_name_aliases names
       INNER JOIN users requested ON requested.id = names.user_id
       INNER JOIN users canonical ON canonical.id = COALESCE(requested.merged_into_user_id, requested.id)
       WHERE names.normalized_name = ? AND canonical.status = 'active'`
    ).bind(proposedDeviceId, deviceSeed, deviceKey || null, deviceName, platform, appVersion, now, now, normalizedName),
    env.DB.prepare(
      `UPDATE devices
       SET user_id = (
             SELECT canonical.id
             FROM user_name_aliases names
             INNER JOIN users requested ON requested.id = names.user_id
             INNER JOIN users canonical ON canonical.id = COALESCE(requested.merged_into_user_id, requested.id)
             WHERE names.normalized_name = ? AND canonical.status = 'active'
           ),
           device_seed = ?,
           device_key = COALESCE(?, device_key),
           device_name = ?, platform = ?, app_version = ?, last_seen_at = ?
       WHERE id = COALESCE(
         (SELECT id FROM devices WHERE device_key = ?),
         (SELECT id FROM devices WHERE device_seed = ?)
       )`
    ).bind(
      normalizedName,
      deviceSeed,
      deviceKey || null,
      deviceName,
      platform,
      appVersion,
      now,
      deviceKey || null,
      deviceSeed
    )
  ]);

  const registration = await env.DB.prepare(
    `SELECT canonical.id AS userId, canonical.name, devices.id AS deviceId
     FROM user_name_aliases names
     INNER JOIN users requested ON requested.id = names.user_id
     INNER JOIN users canonical ON canonical.id = COALESCE(requested.merged_into_user_id, requested.id)
     INNER JOIN devices ON devices.user_id = canonical.id
     WHERE names.normalized_name = ? AND devices.device_seed = ?`
  )
    .bind(normalizedName, deviceSeed)
    .first<{ userId: string; name: string; deviceId: string }>();
  if (!registration) throw new HttpError(409, 'registration conflict');

  const traffic = await getTrafficSummary(env, registration.deviceId, toTrafficDateKey(new Date(now)));

  return json({
    userId: registration.userId,
    deviceId: registration.deviceId,
    name: registration.name,
    traffic
  });
}

async function getClientConfig(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId')?.trim() ?? '';
  const deviceId = url.searchParams.get('deviceId')?.trim() ?? '';
  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');

  if (url.searchParams.getAll('appVersion').length > 1) throw new HttpError(400, 'invalid app version');
  const appVersion = parseAppVersion(url.searchParams.get('appVersion'));
  const canonicalUserId = await verifyDeviceRequest(request, env, userId, deviceId, '');
  await updateDeviceVersionHeartbeat(env, canonicalUserId, deviceId, appVersion);
  const state = await getEffectiveClientStateForDevice(env, deviceId);
  return json({
    config: state.config,
    profile: { ...state.profile, userId },
    ...(state.notice ? { notice: state.notice } : {})
  });
}

async function updateClientConfig(request: Request, env: Env): Promise<Response> {
  await requireJsonMediaType(request);
  const bodyText = await readRequestTextWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES);
  const parsed = safeParseJson(bodyText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid json');
  const input = parsed as ClientConfigUpdateInput;
  assertOnlyFields(input, ['userId', 'deviceId', 'subscriptionUrl', 'ruleProfile'], 'unsupported client config field');
  const userId = cleanOptional(input.userId);
  const deviceId = cleanOptional(input.deviceId);
  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');
  if (!hasOwnField(input, 'subscriptionUrl') && !hasOwnField(input, 'ruleProfile')) {
    throw new HttpError(400, 'missing client config');
  }

  const canonicalUserId = await verifyDeviceRequest(request, env, userId, deviceId, bodyText);
  const global = await getGlobalRemoteConfig(env);
  const columns: string[] = [];
  const bindings: unknown[] = [];
  if (hasOwnField(input, 'subscriptionUrl')) {
    const desired = parseNullableSubscriptionUrl(input.subscriptionUrl);
    columns.push('subscription_url');
    bindings.push(desired === (global.subscriptionUrl ?? null) ? null : desired);
  }
  if (hasOwnField(input, 'ruleProfile')) {
    const desired = parseNullableConfigChoice(input.ruleProfile, ['ruleset', 'subscription'], 'invalid rule profile');
    if (!desired) throw new HttpError(400, 'invalid rule profile');
    columns.push('rule_profile');
    bindings.push(desired === global.ruleProfile ? null : desired);
  }

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO user_remote_config (user_id, ${columns.join(', ')}, updated_at)
     SELECT users.id, ${columns.map(() => '?').join(', ')}, ?
     FROM users
     WHERE users.id = ? AND users.status = 'active' AND users.merged_into_user_id IS NULL
     ON CONFLICT(user_id) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(', ')},
       updated_at = excluded.updated_at`
  )
    .bind(...bindings, now, canonicalUserId)
    .run();
  if (getD1Changes(result) === 0) throw new HttpError(409, 'device state changed');

  await env.DB.prepare(
    `DELETE FROM user_remote_config
     WHERE user_id = ?
       AND enabled IS NULL
       AND subscription_url IS NULL
       AND rule_profile IS NULL
       AND preferred_region IS NULL
       AND region_fallback IS NULL
       AND preferred_node IS NULL
       AND preferred_strategy IS NULL
       AND direct_rules IS NULL
       AND proxy_rules IS NULL`
  )
    .bind(canonicalUserId)
    .run();

  const state = await getEffectiveClientStateForDevice(env, deviceId);
  return json({
    config: state.config,
    profile: { ...state.profile, userId },
    ...(state.notice ? { notice: state.notice } : {})
  });
}

async function updateDeviceVersionHeartbeat(
  env: Env,
  userId: string,
  deviceId: string,
  appVersion: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const heartbeat = await env.DB.prepare(
    `UPDATE devices
     SET last_seen_at = ?, app_version = COALESCE(?, app_version)
     WHERE id = ?
       AND user_id = ?
       AND EXISTS (
         SELECT 1 FROM users
         WHERE users.id = devices.user_id
           AND users.status = 'active'
           AND users.merged_into_user_id IS NULL
       )`
  )
    .bind(now, appVersion, deviceId, userId)
    .run();
  if (getD1Changes(heartbeat) === 0) throw new HttpError(409, 'device state changed');
}

async function getAdminConfig(env: Env): Promise<Response> {
  return json({ config: await getGlobalRemoteConfig(env) });
}

async function updateAdminConfig(request: Request, env: Env): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as RemoteConfigInput;
  assertSupportedRemoteConfigInput(input);
  const assignments: string[] = [];
  const bindings: unknown[] = [];
  const assign = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
    bindings.push(value);
  };

  if (hasOwnField(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'invalid enabled');
    assign('enabled', input.enabled ? 1 : 0);
  }
  if (hasOwnField(input, 'subscriptionUrl')) {
    assign('subscription_url', parseNullableSubscriptionUrl(input.subscriptionUrl));
  }
  if (hasOwnField(input, 'ruleProfile')) {
    assign(
      'rule_profile',
      parseNullableConfigChoice(input.ruleProfile, ['ruleset', 'subscription'], 'invalid rule profile')
    );
  }
  if (hasOwnField(input, 'preferredRegion')) {
    assign(
      'preferred_region',
      parseNullableConfigChoice(
        input.preferredRegion,
        ['auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr'],
        'invalid preferred region'
      ) ?? 'jp'
    );
  }
  if (hasOwnField(input, 'regionFallback')) {
    assign(
      'region_fallback',
      parseNullableConfigChoice(input.regionFallback, ['strict', 'global'], 'invalid region fallback') ?? 'global'
    );
  }

  if (assignments.length === 0) return json({ config: await getGlobalRemoteConfig(env) });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO remote_config
       (id, version, enabled, subscription_url, rule_profile, preferred_region, region_fallback, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
     VALUES (1, 1, 1, NULL, NULL, 'jp', 'global', NULL, NULL, '[]', '[]', 1073741824, ?)`
  )
    .bind(now)
    .run();

  assignments.push('version = version + 1', 'updated_at = ?');
  bindings.push(now);
  await env.DB.prepare(`UPDATE remote_config SET ${assignments.join(', ')} WHERE id = 1`)
    .bind(...bindings)
    .run();

  return json({ config: await getGlobalRemoteConfig(env) });
}

async function getAdminTrafficLimit(env: Env): Promise<Response> {
  return json(await getAdminTrafficLimitSummary(env));
}

async function updateAdminTrafficLimit(request: Request, env: Env): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as AdminTrafficLimitInput;
  if (Object.keys(input).some((field) => field !== 'trafficLimitBytes' && field !== 'trafficExpiresAt')) {
    throw new HttpError(400, 'unsupported traffic limit field');
  }
  const updatesLimit = hasOwnField(input, 'trafficLimitBytes');
  const updatesExpiry = hasOwnField(input, 'trafficExpiresAt');
  if (!updatesLimit && !updatesExpiry) throw new HttpError(400, 'invalid traffic limit');
  const current = await getAdminTrafficLimitSummary(env);
  const trafficLimitBytes = updatesLimit ? parseTrafficLimitBytes(input.trafficLimitBytes) : current.trafficLimitBytes;
  const trafficExpiresAt = updatesExpiry ? parseTrafficExpiresAt(input.trafficExpiresAt) : current.trafficExpiresAt;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO admin_settings (id, traffic_limit_bytes, traffic_expires_at, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       traffic_limit_bytes = excluded.traffic_limit_bytes,
       traffic_expires_at = excluded.traffic_expires_at,
       updated_at = excluded.updated_at`
  )
    .bind(trafficLimitBytes, trafficExpiresAt, now)
    .run();

  return json(await getAdminTrafficLimitSummary(env));
}

async function getAdminUserConfig(env: Env, userId: string): Promise<Response> {
  await requireKnownUser(env, userId);
  const override = await getUserRemoteConfig(env, userId);
  const effective = await getEffectiveRemoteConfig(env, userId);
  await requireKnownUser(env, userId);
  return json({
    override,
    effective
  });
}

async function updateAdminUserConfig(request: Request, env: Env, userId: string): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as RemoteConfigInput;
  assertSupportedRemoteConfigInput(input);
  const columns: string[] = [];
  const bindings: unknown[] = [];
  const assign = (column: string, value: unknown): void => {
    columns.push(column);
    bindings.push(value);
  };

  if (hasOwnField(input, 'enabled')) {
    if (input.enabled !== null && typeof input.enabled !== 'boolean') throw new HttpError(400, 'invalid enabled');
    assign('enabled', typeof input.enabled === 'boolean' ? (input.enabled ? 1 : 0) : null);
  }
  if (hasOwnField(input, 'subscriptionUrl')) {
    assign('subscription_url', parseNullableSubscriptionUrl(input.subscriptionUrl));
  }
  if (hasOwnField(input, 'ruleProfile')) {
    assign(
      'rule_profile',
      parseNullableConfigChoice(input.ruleProfile, ['ruleset', 'subscription'], 'invalid rule profile')
    );
  }
  if (hasOwnField(input, 'preferredRegion')) {
    assign(
      'preferred_region',
      parseNullableConfigChoice(
        input.preferredRegion,
        ['auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr'],
        'invalid preferred region'
      )
    );
  }
  if (hasOwnField(input, 'regionFallback')) {
    assign(
      'region_fallback',
      parseNullableConfigChoice(input.regionFallback, ['strict', 'global'], 'invalid region fallback')
    );
  }

  if (columns.length > 0) {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `INSERT INTO user_remote_config (user_id, ${columns.join(', ')}, updated_at)
       SELECT users.id, ${columns.map(() => '?').join(', ')}, ?
       FROM users
       WHERE users.id = ? AND users.status = 'active' AND users.merged_into_user_id IS NULL
       ON CONFLICT(user_id) DO UPDATE SET
         ${columns.map((column) => `${column} = excluded.${column}`).join(', ')},
         updated_at = excluded.updated_at`
    )
      .bind(...bindings, now, userId)
      .run();
    if (getD1Changes(result) === 0) throw new HttpError(404, 'unknown user');
  } else {
    await requireKnownUser(env, userId);
  }

  const override = await getUserRemoteConfig(env, userId);
  const effective = await getEffectiveRemoteConfig(env, userId);
  await requireKnownUser(env, userId);
  return json({ override, effective });
}

async function syncGlobalConfigToUsers(env: Env): Promise<Response> {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS count FROM user_remote_config').first<{ count: number }>();
  await env.DB.prepare('DELETE FROM user_remote_config').run();
  return json({
    ok: true,
    clearedUsers: existing?.count ?? 0,
    config: await getGlobalRemoteConfig(env)
  });
}

async function resetAdminUserConfig(env: Env, userId: string): Promise<Response> {
  await requireKnownUser(env, userId);
  await env.DB.prepare(
    `DELETE FROM user_remote_config
       WHERE user_id = ?
         AND EXISTS (
           SELECT 1 FROM users
           WHERE id = ? AND status = 'active' AND merged_into_user_id IS NULL
         )`
  )
    .bind(userId, userId)
    .run();
  const effective = await getEffectiveRemoteConfig(env, userId);
  await requireKnownUser(env, userId);
  return json({
    override: null,
    effective
  });
}

type AdminUserProfileRow = {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: string;
  updatedAt: string;
};

type AdminUserProfileAuditRow = {
  requestId: string;
  userId: string;
  newName: string;
  newNormalizedName: string;
};

type AdminUserNoticeRow = {
  revision: number;
  enabled: number;
  message: string;
  tone: string;
  expiresAt: string;
  updatedAt: string;
  durationMinutes: number | null;
};

type AdminUserNoticeAuditRow = {
  requestId: string;
  userId: string;
  revision: number;
  enabled: number;
  message: string;
  tone: string;
  durationMinutes: number;
  expiresAt: string;
  updatedAt: string;
};

async function getAdminUserProfile(env: Env, userId: string): Promise<Response> {
  return json({ user: toAdminUserProfile(await requireAdminUserProfile(env, userId)) });
}

async function updateAdminUserProfile(request: Request, env: Env, userId: string): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as UserProfileInput;
  assertOnlyFields(input, ['name', 'requestId'], 'unsupported profile field');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || !isBoundedText(name, ACTIVATION_MAX_NAME_LENGTH)) throw new HttpError(400, 'invalid name');
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new HttpError(400, 'invalid name');
  const requestId =
    typeof input.requestId === 'string' && input.requestId.trim()
      ? input.requestId.trim().toLowerCase()
      : crypto.randomUUID();
  if (!isUuid(requestId)) throw new HttpError(400, 'invalid request id');

  const recovered = await recoverAdminUserProfileUpdate(env, userId, name, normalizedName, requestId);
  if (recovered) return recovered;

  const current = await requireAdminUserProfile(env, userId);
  if (current.name === name && current.normalizedName === normalizedName) {
    return json({
      ok: true,
      alreadyApplied: true,
      requestId,
      user: toAdminUserProfile(current)
    });
  }
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const auditGuard = 'EXISTS (SELECT 1 FROM user_profile_audit WHERE id = ?)';
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_profile_audit
           (id, request_id, user_id, old_name, new_name, old_normalized_name, new_normalized_name, renamed_at)
         SELECT ?, ?, users.id, users.name, ?, users.normalized_name, ?, ?
         FROM users
         WHERE users.id = ?
           AND users.status = 'active'
           AND users.merged_into_user_id IS NULL
           AND users.name = ?
           AND users.normalized_name = ?
           AND NOT EXISTS (
             SELECT 1 FROM users occupied
             WHERE occupied.normalized_name = ? AND occupied.id <> users.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_name_aliases occupied
             WHERE occupied.normalized_name = ? AND occupied.user_id <> users.id
           )`
      ).bind(
        auditId,
        requestId,
        name,
        normalizedName,
        now,
        userId,
        current.name,
        current.normalizedName,
        normalizedName,
        normalizedName
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_name_aliases (normalized_name, user_id, created_at)
         SELECT ?, ?, ? WHERE ${auditGuard}`
      ).bind(current.normalizedName, userId, now, auditId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_name_aliases (normalized_name, user_id, created_at)
         SELECT ?, ?, ? WHERE ${auditGuard}`
      ).bind(normalizedName, userId, now, auditId),
      env.DB.prepare(
        `UPDATE users SET name = ?, normalized_name = ?
         WHERE id = ? AND ${auditGuard}`
      ).bind(name, normalizedName, userId, auditId)
    ]);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const recoveredAfterConflict = await recoverAdminUserProfileUpdate(env, userId, name, normalizedName, requestId);
      if (recoveredAfterConflict) return recoveredAfterConflict;
      throw new HttpError(409, 'name conflict');
    }
    throw error;
  }

  const committed = await env.DB.prepare('SELECT id FROM user_profile_audit WHERE id = ? AND user_id = ?')
    .bind(auditId, userId)
    .first<{ id: string }>();
  if (!committed) {
    const recoveredAfterBatch = await recoverAdminUserProfileUpdate(env, userId, name, normalizedName, requestId);
    if (recoveredAfterBatch) return recoveredAfterBatch;
    const occupied = await findNameOwner(env, normalizedName);
    if (occupied && occupied !== userId) throw new HttpError(409, 'name conflict');
    throw new HttpError(409, 'profile state changed');
  }

  return json({
    ok: true,
    alreadyApplied: false,
    requestId,
    user: toAdminUserProfile(await requireAdminUserProfile(env, userId))
  });
}

async function recoverAdminUserProfileUpdate(
  env: Env,
  userId: string,
  name: string,
  normalizedName: string,
  requestId: string
): Promise<Response | null> {
  const audit = await env.DB.prepare(
    `SELECT request_id AS requestId, user_id AS userId, new_name AS newName,
            new_normalized_name AS newNormalizedName
     FROM user_profile_audit WHERE request_id = ?`
  )
    .bind(requestId)
    .first<AdminUserProfileAuditRow>();
  if (!audit) return null;
  if (audit.userId !== userId || audit.newName !== name || audit.newNormalizedName !== normalizedName) {
    throw new HttpError(409, 'profile request conflict');
  }
  return json({
    ok: true,
    alreadyApplied: true,
    requestId,
    user: toAdminUserProfile(await requireAdminUserProfile(env, userId))
  });
}

async function findNameOwner(env: Env, normalizedName: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id AS userId FROM user_name_aliases WHERE normalized_name = ?
     UNION ALL
     SELECT id AS userId FROM users WHERE normalized_name = ?
     LIMIT 1`
  )
    .bind(normalizedName, normalizedName)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}

async function requireAdminUserProfile(env: Env, userId: string): Promise<AdminUserProfileRow> {
  const row = await env.DB.prepare(
    `SELECT
       users.id,
       users.name,
       users.normalized_name AS normalizedName,
       users.created_at AS createdAt,
       COALESCE((
         SELECT renamed_at FROM user_profile_audit
         WHERE user_id = users.id
         ORDER BY renamed_at DESC
         LIMIT 1
       ), users.created_at) AS updatedAt
     FROM users
     WHERE users.id = ? AND users.status = 'active' AND users.merged_into_user_id IS NULL`
  )
    .bind(userId)
    .first<AdminUserProfileRow>();
  if (!row) throw new HttpError(404, 'unknown user');
  return row;
}

function toAdminUserProfile(row: AdminUserProfileRow): Pick<AdminUserProfileRow, 'id' | 'name' | 'updatedAt'> {
  return { id: row.id, name: row.name, updatedAt: row.updatedAt };
}

async function getAdminUserNotice(env: Env, userId: string): Promise<Response> {
  await requireKnownUser(env, userId);
  return json({ notice: await getAdminUserNoticeRow(env, userId) });
}

async function updateAdminUserNotice(request: Request, env: Env, userId: string): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as UserNoticeInput;
  assertOnlyFields(input, ['enabled', 'message', 'tone', 'durationMinutes', 'requestId'], 'unsupported notice field');
  if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'invalid notice enabled');
  const message = parseNoticeMessage(input.message);
  const tone = parseNoticeTone(input.tone);
  const durationMinutes = parseNoticeDurationMinutes(input.durationMinutes);
  const requestId = parseOptionalRequestId(input.requestId);
  const recovered = await recoverAdminUserNoticeUpdate(env, userId, {
    enabled: input.enabled,
    message,
    tone,
    durationMinutes,
    requestId
  });
  if (recovered) return recovered;

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + durationMinutes * 60 * 1000).toISOString();
  const auditId = crypto.randomUUID();
  const auditGuard = 'EXISTS (SELECT 1 FROM user_notice_audit WHERE id = ?)';

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_notice_audit
           (id, request_id, user_id, revision, enabled, message, tone, duration_minutes, expires_at, updated_at)
         SELECT ?, ?, users.id, 1, ?, ?, ?, ?, ?, ?
         FROM users
         WHERE users.id = ? AND users.status = 'active' AND users.merged_into_user_id IS NULL`
      ).bind(auditId, requestId, input.enabled ? 1 : 0, message, tone, durationMinutes, expiresAt, now, userId),
      env.DB.prepare(
        `INSERT INTO user_notices (user_id, revision, enabled, message, tone, expires_at, updated_at)
         SELECT users.id, 1, ?, ?, ?, ?, ?
         FROM users
         WHERE users.id = ?
           AND users.status = 'active'
           AND users.merged_into_user_id IS NULL
           AND ${auditGuard}
         ON CONFLICT(user_id) DO UPDATE SET
           revision = user_notices.revision + 1,
           enabled = excluded.enabled,
           message = excluded.message,
           tone = excluded.tone,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      ).bind(input.enabled ? 1 : 0, message, tone, expiresAt, now, userId, auditId),
      env.DB.prepare(
        `UPDATE user_notice_audit
         SET revision = (SELECT revision FROM user_notices WHERE user_id = ?)
         WHERE id = ?
           AND user_id = ?
           AND EXISTS (SELECT 1 FROM user_notices WHERE user_id = ?)`
      ).bind(userId, auditId, userId, userId),
      env.DB.prepare(
        `DELETE FROM user_notice_acknowledgements
         WHERE user_id = ?
           AND revision <> COALESCE((SELECT revision FROM user_notices WHERE user_id = ?), -1)`
      ).bind(userId, userId)
    ]);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const recoveredAfterConflict = await recoverAdminUserNoticeUpdate(env, userId, {
        enabled: input.enabled,
        message,
        tone,
        durationMinutes,
        requestId
      });
      if (recoveredAfterConflict) return recoveredAfterConflict;
    }
    throw error;
  }

  const committed = await getAdminUserNoticeAuditById(env, auditId, userId);
  if (!committed) {
    await requireKnownUser(env, userId);
    throw new HttpError(409, 'notice state changed');
  }
  return json({
    ok: true,
    alreadyApplied: false,
    requestId,
    notice: toAdminUserNotice(committed)
  });
}

async function recoverAdminUserNoticeUpdate(
  env: Env,
  userId: string,
  expected: {
    enabled: boolean;
    message: string;
    tone: 'info' | 'warning';
    durationMinutes: number;
    requestId: string;
  }
): Promise<Response | null> {
  const audit = await env.DB.prepare(
    `SELECT
       request_id AS requestId,
       user_id AS userId,
       revision,
       enabled,
       message,
       tone,
       duration_minutes AS durationMinutes,
       expires_at AS expiresAt,
       updated_at AS updatedAt
     FROM user_notice_audit
     WHERE request_id = ?`
  )
    .bind(expected.requestId)
    .first<AdminUserNoticeAuditRow>();
  if (!audit) return null;
  if (
    audit.userId !== userId ||
    (audit.enabled === 1) !== expected.enabled ||
    audit.message !== expected.message ||
    audit.tone !== expected.tone ||
    audit.durationMinutes !== expected.durationMinutes
  ) {
    throw new HttpError(409, 'notice request conflict');
  }
  return json({
    ok: true,
    alreadyApplied: true,
    requestId: expected.requestId,
    notice: toAdminUserNotice(audit)
  });
}

async function getAdminUserNoticeAuditById(
  env: Env,
  auditId: string,
  userId: string
): Promise<AdminUserNoticeAuditRow | null> {
  return env.DB.prepare(
    `SELECT
       request_id AS requestId,
       user_id AS userId,
       revision,
       enabled,
       message,
       tone,
       duration_minutes AS durationMinutes,
       expires_at AS expiresAt,
       updated_at AS updatedAt
     FROM user_notice_audit
     WHERE id = ? AND user_id = ?`
  )
    .bind(auditId, userId)
    .first<AdminUserNoticeAuditRow>();
}

async function resetAdminUserNotice(env: Env, userId: string): Promise<Response> {
  await requireKnownUser(env, userId);
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE user_notices
       SET revision = revision + 1, enabled = 0, updated_at = ?
       WHERE user_id = ?`
    ).bind(now, userId),
    env.DB.prepare('DELETE FROM user_notice_acknowledgements WHERE user_id = ?').bind(userId)
  ]);
  return json({ ok: true, cleared: getD1Changes(results[0]) > 0, notice: await getAdminUserNoticeRow(env, userId) });
}

async function getAdminUserNoticeRow(
  env: Env,
  userId: string
): Promise<(RemoteUserNotice & { enabled: boolean; durationMinutes: number }) | null> {
  const row = await env.DB.prepare(
    `SELECT
       user_notices.revision,
       user_notices.enabled,
       user_notices.message,
       user_notices.tone,
       user_notices.expires_at AS expiresAt,
       user_notices.updated_at AS updatedAt,
       user_notice_audit.duration_minutes AS durationMinutes
     FROM user_notices
     LEFT JOIN user_notice_audit
       ON user_notice_audit.user_id = user_notices.user_id
      AND user_notice_audit.revision = user_notices.revision
     WHERE user_notices.user_id = ?`
  )
    .bind(userId)
    .first<AdminUserNoticeRow>();
  if (!row) return null;
  return toAdminUserNotice(row);
}

function toAdminUserNotice(
  row: Pick<
    AdminUserNoticeRow,
    'revision' | 'enabled' | 'message' | 'tone' | 'expiresAt' | 'updatedAt' | 'durationMinutes'
  >
): RemoteUserNotice & { enabled: boolean; durationMinutes: number } {
  return {
    revision: row.revision,
    enabled: row.enabled === 1,
    message: row.message,
    tone: row.tone === 'warning' ? 'warning' : 'info',
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    durationMinutes: normalizeStoredNoticeDurationMinutes(row.durationMinutes)
  };
}

type AdminMergeUserRow = {
  id: string;
  name: string;
  status: string;
  mergedIntoUserId: string | null;
};

type AdminMergeConfigRow = {
  enabled: number | null;
  subscriptionUrl: string | null;
  ruleProfile: string | null;
  preferredRegion: string | null;
  regionFallback: string | null;
  updatedAt: string;
};

type AdminMergeAuditRow = {
  requestId: string;
  sourceUserId: string;
  targetUserId: string;
  configResolution: string;
  mergedAt: string;
};

type AdminMergeNoticeRow = {
  revision: number;
  enabled: number;
  message: string;
  tone: string;
  expiresAt: string;
  updatedAt: string;
};

async function previewAdminUserMerge(request: Request, env: Env, sourceUserId: string): Promise<Response> {
  const targetUserId = new URL(request.url).searchParams.get('targetUserId')?.trim() ?? '';
  const context = await getAdminUserMergeContext(env, sourceUserId, targetUserId);
  return json({
    source: context.source,
    target: context.target,
    config: {
      conflict: context.configConflict,
      sourceHasOverride: Boolean(context.sourceConfig),
      targetHasOverride: Boolean(context.targetConfig),
      recommendedResolution: context.recommendedResolution
    }
  });
}

async function mergeAdminUser(request: Request, env: Env, sourceUserId: string): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as UserMergeInput;
  assertOnlyFields(input, ['targetUserId', 'configResolution', 'requestId'], 'unsupported merge field');
  const targetUserId = typeof input.targetUserId === 'string' ? input.targetUserId.trim().toLowerCase() : '';
  if (!targetUserId || !isUuid(targetUserId)) throw new HttpError(400, 'invalid target user');
  const requestId =
    typeof input.requestId === 'string' && input.requestId.trim()
      ? input.requestId.trim().toLowerCase()
      : crypto.randomUUID();
  if (!isUuid(requestId)) throw new HttpError(400, 'invalid request id');
  const allowedResolutions = new Set(['keep_target', 'use_source', 'reset_to_global']);
  if (input.configResolution !== undefined && !allowedResolutions.has(input.configResolution)) {
    throw new HttpError(400, 'invalid config resolution');
  }

  const recoveredAtEntry = await recoverAdminUserMerge(env, sourceUserId, targetUserId, requestId);
  if (recoveredAtEntry) return recoveredAtEntry;

  const existingSource = await getAdminMergeUser(env, sourceUserId);
  if (!existingSource) throw new HttpError(404, 'unknown user');
  if (existingSource.mergedIntoUserId) {
    const recoveredAfterSourceRead = await recoverAdminUserMerge(env, sourceUserId, targetUserId, requestId);
    if (recoveredAfterSourceRead) return recoveredAfterSourceRead;
    if (existingSource.mergedIntoUserId !== targetUserId) throw new HttpError(409, 'user already merged');
    return json({
      ok: true,
      alreadyMerged: true,
      sourceUserId,
      targetUserId,
      requestId,
      configResolution: input.configResolution ?? 'keep_target'
    });
  }

  let context: Awaited<ReturnType<typeof getAdminUserMergeContext>>;
  try {
    context = await getAdminUserMergeContext(env, sourceUserId, targetUserId);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 409)) {
      const recoveredAfterContextRead = await recoverAdminUserMerge(env, sourceUserId, targetUserId, requestId);
      if (recoveredAfterContextRead) return recoveredAfterContextRead;
    }
    throw error;
  }
  if (context.configConflict && !input.configResolution) throw new HttpError(409, 'config conflict');
  const configResolution = input.configResolution ?? context.recommendedResolution;
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const auditGuard = 'EXISTS (SELECT 1 FROM user_merge_audit WHERE id = ?)';
  const statements = [
    env.DB.prepare(
      `INSERT INTO user_merge_audit
         (id, request_id, source_user_id, target_user_id, source_name, target_name, config_resolution, merged_at)
       SELECT ?, ?, source.id, target.id, source.name, target.name, ?, ?
       FROM users source
       INNER JOIN users target ON target.id = ?
       WHERE source.id = ?
         AND source.status = 'active'
         AND source.merged_into_user_id IS NULL
         AND target.status = 'active'
         AND target.merged_into_user_id IS NULL
         AND COALESCE((
           SELECT json_array(enabled, subscription_url, rule_profile, preferred_region, region_fallback, updated_at)
           FROM user_remote_config
           WHERE user_id = source.id
         ), '') = ?
          AND COALESCE((
            SELECT json_array(enabled, subscription_url, rule_profile, preferred_region, region_fallback, updated_at)
            FROM user_remote_config
            WHERE user_id = target.id
          ), '') = ?
          AND COALESCE((
            SELECT json_array(revision, enabled, message, tone, expires_at, updated_at)
            FROM user_notices
            WHERE user_id = source.id
          ), '') = ?
          AND COALESCE((
            SELECT json_array(revision, enabled, message, tone, expires_at, updated_at)
            FROM user_notices
            WHERE user_id = target.id
          ), '') = ?`
    ).bind(
      auditId,
      requestId,
      configResolution,
      now,
      context.target.id,
      context.source.id,
      getAdminMergeConfigFingerprint(context.sourceConfig),
      getAdminMergeConfigFingerprint(context.targetConfig),
      getAdminMergeNoticeFingerprint(context.sourceNotice),
      getAdminMergeNoticeFingerprint(context.targetNotice)
    ),
    env.DB.prepare(
      `INSERT INTO traffic_daily (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       SELECT ?, device_id, date, upload_bytes, download_bytes, updated_at
       FROM traffic_daily
       WHERE user_id = ? AND ${auditGuard}
       ON CONFLICT(user_id, device_id, date) DO UPDATE SET
         upload_bytes = traffic_daily.upload_bytes + excluded.upload_bytes,
         download_bytes = traffic_daily.download_bytes + excluded.download_bytes,
         updated_at = CASE
           WHEN excluded.updated_at > traffic_daily.updated_at THEN excluded.updated_at
           ELSE traffic_daily.updated_at
         END`
    ).bind(context.target.id, context.source.id, auditId),
    env.DB.prepare(`DELETE FROM traffic_daily WHERE user_id = ? AND ${auditGuard}`).bind(context.source.id, auditId),
    env.DB.prepare(`UPDATE traffic_reports SET user_id = ? WHERE user_id = ? AND ${auditGuard}`).bind(
      context.target.id,
      context.source.id,
      auditId
    ),
    env.DB.prepare(`UPDATE traffic_anomalies SET user_id = ? WHERE user_id = ? AND ${auditGuard}`).bind(
      context.target.id,
      context.source.id,
      auditId
    ),
    env.DB.prepare(`UPDATE devices SET user_id = ? WHERE user_id = ? AND ${auditGuard}`).bind(
      context.target.id,
      context.source.id,
      auditId
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_name_aliases (normalized_name, user_id, created_at)
       SELECT normalized_name, ?, ? FROM users WHERE id = ? AND ${auditGuard}`
    ).bind(context.target.id, now, context.source.id, auditId),
    env.DB.prepare(`UPDATE user_name_aliases SET user_id = ? WHERE user_id = ? AND ${auditGuard}`).bind(
      context.target.id,
      context.source.id,
      auditId
    )
  ];

  if (context.sourceNotice && !context.targetNotice) {
    const transferredNoticeAuditId = crypto.randomUUID();
    const transferredNoticeRequestId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_notices (user_id, revision, enabled, message, tone, expires_at, updated_at)
         SELECT ?, revision, enabled, message, tone, expires_at, updated_at
          FROM user_notices
          WHERE user_id = ? AND ${auditGuard}`
      ).bind(context.target.id, context.source.id, auditId),
      env.DB.prepare(
        `INSERT INTO user_notice_audit
           (id, request_id, user_id, revision, enabled, message, tone, duration_minutes, expires_at, updated_at)
         SELECT ?, ?, ?, source_audit.revision, source_audit.enabled, source_audit.message, source_audit.tone,
                source_audit.duration_minutes, source_audit.expires_at, source_audit.updated_at
         FROM user_notice_audit source_audit
         INNER JOIN user_notices source_notice
           ON source_notice.user_id = source_audit.user_id
          AND source_notice.revision = source_audit.revision
         WHERE source_audit.user_id = ? AND ${auditGuard}`
      ).bind(transferredNoticeAuditId, transferredNoticeRequestId, context.target.id, context.source.id, auditId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_notice_acknowledgements (user_id, revision, device_id, acknowledged_at)
         SELECT ?, revision, device_id, acknowledged_at
         FROM user_notice_acknowledgements
         WHERE user_id = ? AND ${auditGuard}`
      ).bind(context.target.id, context.source.id, auditId)
    );
  }
  statements.push(
    env.DB.prepare(`DELETE FROM user_notice_acknowledgements WHERE user_id = ? AND ${auditGuard}`).bind(
      context.source.id,
      auditId
    ),
    env.DB.prepare(`DELETE FROM user_notices WHERE user_id = ? AND ${auditGuard}`).bind(context.source.id, auditId)
  );

  if (configResolution === 'use_source') {
    if (context.sourceConfig) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO user_remote_config
             (user_id, enabled, subscription_url, rule_profile, preferred_region, region_fallback, preferred_node, preferred_strategy, direct_rules, proxy_rules, updated_at)
           SELECT ?, enabled, subscription_url, rule_profile, preferred_region, region_fallback, NULL, NULL, NULL, NULL, ?
           FROM user_remote_config
           WHERE user_id = ? AND ${auditGuard}
           ON CONFLICT(user_id) DO UPDATE SET
             enabled = excluded.enabled,
             subscription_url = excluded.subscription_url,
             rule_profile = excluded.rule_profile,
             preferred_region = excluded.preferred_region,
             region_fallback = excluded.region_fallback,
             preferred_node = NULL,
             preferred_strategy = NULL,
             direct_rules = NULL,
             proxy_rules = NULL,
             updated_at = excluded.updated_at`
        ).bind(context.target.id, now, context.source.id, auditId)
      );
    } else {
      statements.push(
        env.DB.prepare(`DELETE FROM user_remote_config WHERE user_id = ? AND ${auditGuard}`).bind(
          context.target.id,
          auditId
        )
      );
    }
  } else if (configResolution === 'reset_to_global') {
    statements.push(
      env.DB.prepare(`DELETE FROM user_remote_config WHERE user_id = ? AND ${auditGuard}`).bind(
        context.target.id,
        auditId
      )
    );
  }

  statements.push(
    env.DB.prepare(`DELETE FROM user_remote_config WHERE user_id = ? AND ${auditGuard}`).bind(
      context.source.id,
      auditId
    ),
    env.DB.prepare(`UPDATE users SET merged_into_user_id = ? WHERE merged_into_user_id = ? AND ${auditGuard}`).bind(
      context.target.id,
      context.source.id,
      auditId
    ),
    env.DB.prepare(
      `UPDATE users
       SET status = 'merged', merged_into_user_id = ?
       WHERE id = ? AND status = 'active' AND merged_into_user_id IS NULL AND ${auditGuard}`
    ).bind(context.target.id, context.source.id, auditId)
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const recoveredAfterConflict = await recoverAdminUserMerge(env, sourceUserId, targetUserId, requestId);
      if (recoveredAfterConflict) return recoveredAfterConflict;
      throw new HttpError(409, 'merge state changed');
    }
    throw error;
  }

  const committedAudit = await env.DB.prepare(
    'SELECT id FROM user_merge_audit WHERE id = ? AND source_user_id = ? AND target_user_id = ?'
  )
    .bind(auditId, context.source.id, context.target.id)
    .first<{ id: string }>();
  if (!committedAudit) {
    const recoveredAfterBatch = await recoverAdminUserMerge(env, sourceUserId, targetUserId, requestId);
    if (recoveredAfterBatch) return recoveredAfterBatch;
    throw new HttpError(409, 'merge state changed');
  }

  return json({
    ok: true,
    sourceUserId: context.source.id,
    targetUserId: context.target.id,
    requestId,
    configResolution,
    mergedAt: now
  });
}

async function getAdminUserMergeContext(env: Env, sourceUserId: string, targetUserId: string) {
  if (!isUuid(sourceUserId) || !isUuid(targetUserId)) throw new HttpError(400, 'invalid user');
  if (sourceUserId === targetUserId) throw new HttpError(400, 'same user');
  const [source, target, sourceConfig, targetConfig, sourceNotice, targetNotice] = await Promise.all([
    getAdminMergeUser(env, sourceUserId),
    getAdminMergeUser(env, targetUserId),
    getAdminMergeConfig(env, sourceUserId),
    getAdminMergeConfig(env, targetUserId),
    getAdminMergeNotice(env, sourceUserId),
    getAdminMergeNotice(env, targetUserId)
  ]);
  if (!source || source.status !== 'active' || source.mergedIntoUserId) throw new HttpError(404, 'unknown user');
  if (!target || target.status !== 'active' || target.mergedIntoUserId) throw new HttpError(404, 'unknown target user');
  const configConflict = Boolean(sourceConfig && targetConfig && !sameAdminMergeConfig(sourceConfig, targetConfig));
  const recommendedResolution: NonNullable<UserMergeInput['configResolution']> =
    sourceConfig && !targetConfig ? 'use_source' : 'keep_target';
  return {
    source,
    target,
    sourceConfig,
    targetConfig,
    sourceNotice,
    targetNotice,
    configConflict,
    recommendedResolution
  };
}

async function getAdminMergeUser(env: Env, userId: string): Promise<AdminMergeUserRow | null> {
  return env.DB.prepare(
    `SELECT id, name, status, merged_into_user_id AS mergedIntoUserId
     FROM users
     WHERE id = ?`
  )
    .bind(userId)
    .first<AdminMergeUserRow>();
}

async function getAdminMergeConfig(env: Env, userId: string): Promise<AdminMergeConfigRow | null> {
  return env.DB.prepare(
    `SELECT enabled, subscription_url AS subscriptionUrl, rule_profile AS ruleProfile,
            preferred_region AS preferredRegion, region_fallback AS regionFallback, updated_at AS updatedAt
     FROM user_remote_config
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<AdminMergeConfigRow>();
}

async function getAdminMergeNotice(env: Env, userId: string): Promise<AdminMergeNoticeRow | null> {
  return env.DB.prepare(
    `SELECT revision, enabled, message, tone, expires_at AS expiresAt, updated_at AS updatedAt
     FROM user_notices WHERE user_id = ?`
  )
    .bind(userId)
    .first<AdminMergeNoticeRow>();
}

async function recoverAdminUserMerge(
  env: Env,
  sourceUserId: string,
  targetUserId: string,
  requestId: string
): Promise<Response | null> {
  const audits = await env.DB.prepare(
    `SELECT
       request_id AS requestId,
       source_user_id AS sourceUserId,
       target_user_id AS targetUserId,
       config_resolution AS configResolution,
       merged_at AS mergedAt
     FROM user_merge_audit
     WHERE request_id = ? OR source_user_id = ?`
  )
    .bind(requestId, sourceUserId)
    .all<AdminMergeAuditRow>();
  const requestAudit = audits.results.find((audit) => audit.requestId === requestId);
  if (requestAudit && (requestAudit.sourceUserId !== sourceUserId || requestAudit.targetUserId !== targetUserId)) {
    throw new HttpError(409, 'merge request conflict');
  }
  const sourceAudit = audits.results.find((audit) => audit.sourceUserId === sourceUserId);
  if (sourceAudit && sourceAudit.targetUserId !== targetUserId) {
    throw new HttpError(409, 'user already merged');
  }
  const audit = requestAudit ?? sourceAudit;
  if (!audit) return null;
  return json({
    ok: true,
    alreadyMerged: true,
    sourceUserId: audit.sourceUserId,
    targetUserId: audit.targetUserId,
    requestId: audit.requestId,
    configResolution: audit.configResolution,
    mergedAt: audit.mergedAt
  });
}

function getAdminMergeConfigFingerprint(config: AdminMergeConfigRow | null): string {
  return config
    ? JSON.stringify([
        config.enabled,
        config.subscriptionUrl,
        config.ruleProfile,
        config.preferredRegion,
        config.regionFallback,
        config.updatedAt
      ])
    : '';
}

function getAdminMergeNoticeFingerprint(notice: AdminMergeNoticeRow | null): string {
  return notice
    ? JSON.stringify([notice.revision, notice.enabled, notice.message, notice.tone, notice.expiresAt, notice.updatedAt])
    : '';
}

function sameAdminMergeConfig(left: AdminMergeConfigRow, right: AdminMergeConfigRow): boolean {
  return (
    left.enabled === right.enabled &&
    cleanOptional(left.subscriptionUrl) === cleanOptional(right.subscriptionUrl) &&
    normalizeOptionalRuleProfile(left.ruleProfile) === normalizeOptionalRuleProfile(right.ruleProfile) &&
    normalizeOptionalPreferredRegion(left.preferredRegion) ===
      normalizeOptionalPreferredRegion(right.preferredRegion) &&
    normalizeOptionalRegionFallback(left.regionFallback) === normalizeOptionalRegionFallback(right.regionFallback)
  );
}

async function acknowledgeUserNotice(request: Request, env: Env): Promise<Response> {
  await requireJsonMediaType(request);
  const bodyText = await readRequestTextWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES);
  const input = safeParseJson(bodyText) as UserNoticeAcknowledgementInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid json');
  assertOnlyFields(input, ['userId', 'deviceId', 'revision'], 'unsupported notice acknowledgement field');
  const userId = typeof input.userId === 'string' ? input.userId.trim().toLowerCase() : '';
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim().toLowerCase() : '';
  const revision = parseNoticeRevision(input.revision);
  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');
  if (!isUuid(userId) || !isUuid(deviceId)) throw new HttpError(400, 'invalid identity');
  const canonicalUserId = await verifyDeviceRequest(request, env, userId, deviceId, bodyText);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO user_notice_acknowledgements (user_id, revision, device_id, acknowledged_at)
     SELECT devices.user_id, user_notices.revision, devices.id, ?
     FROM devices
     INNER JOIN user_notices ON user_notices.user_id = devices.user_id
     INNER JOIN users ON users.id = devices.user_id
     WHERE devices.id = ?
       AND devices.user_id = ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL
       AND user_notices.revision = ?
       AND user_notices.enabled = 1
       AND user_notices.expires_at > ?
     ON CONFLICT(user_id, revision, device_id) DO NOTHING`
  )
    .bind(now, deviceId, canonicalUserId, revision, now)
    .run();
  if (getD1Changes(result) === 0) {
    const existing = await env.DB.prepare(
      `SELECT 1 AS acknowledged
       FROM user_notice_acknowledgements
       WHERE user_id = ? AND revision = ? AND device_id = ?`
    )
      .bind(canonicalUserId, revision, deviceId)
      .first<{ acknowledged: number }>();
    if (!existing) throw new HttpError(409, 'notice state changed');
  }
  return json({ ok: true, revision });
}

async function reportTraffic(request: Request, env: Env): Promise<Response> {
  await requireJsonMediaType(request);
  const bodyText = await readRequestTextWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES);
  const input = safeParseJson(bodyText) as TrafficReportInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid json');
  assertOnlyFields(
    input,
    ['reportId', 'userId', 'deviceId', 'uploadDelta', 'downloadDelta', 'reportedAt', 'appVersion'],
    'unsupported traffic report field'
  );
  const reportId = normalizeReportId(input.reportId);
  const userId = typeof input.userId === 'string' ? input.userId.trim().toLowerCase() : '';
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim().toLowerCase() : '';
  const upload = parseTrafficDelta(input.uploadDelta, 'invalid upload delta');
  const download = parseTrafficDelta(input.downloadDelta, 'invalid download delta');
  const reportedAt = parseOptionalReportTimestamp(input.reportedAt);
  const now = new Date().toISOString();
  const date = toTrafficDateKey(new Date(now));

  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');
  if (!isUuid(userId) || !isUuid(deviceId)) throw new HttpError(400, 'invalid identity');
  if (input.reportId === undefined || input.reportId === null || input.reportId === '') {
    throw new HttpError(400, 'missing report id');
  }
  if (!reportId) throw new HttpError(400, 'invalid report id');

  await verifyDeviceRequest(request, env, userId, deviceId, bodyText);
  const appVersion = parseAppVersion(input.appVersion);
  if (upload === 0 && download === 0) {
    const heartbeat = await env.DB.prepare(
      `UPDATE devices
       SET last_seen_at = ?, app_version = COALESCE(?, app_version)
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.id = devices.user_id
             AND users.status = 'active'
             AND users.merged_into_user_id IS NULL
         )`
    )
      .bind(now, appVersion, deviceId)
      .run();
    if (getD1Changes(heartbeat) === 0) throw new HttpError(409, 'device state changed');
    return json({ ok: true, traffic: await getTrafficSummary(env, deviceId, date) });
  }

  const anomaly = upload >= ANOMALY_THRESHOLD_BYTES || download >= ANOMALY_THRESHOLD_BYTES;
  const payloadHash = await createTrafficReportPayloadHash({
    deviceId,
    upload,
    download,
    reportedAt
  });
  const existingResponse = await recoverTrafficReportDuplicate(env, reportId, payloadHash, {
    deviceId,
    upload,
    download,
    reportedAt
  });
  if (existingResponse) return existingResponse;

  const writes = [
    env.DB.prepare(
      `INSERT INTO traffic_report_dedup
         (id, payload_hash, traffic_date, anomaly)
       SELECT ?, ?, ?, ?
       FROM devices
       INNER JOIN users ON users.id = devices.user_id
       WHERE devices.id = ?
         AND users.status = 'active'
         AND users.merged_into_user_id IS NULL`
    ).bind(reportId, payloadHash, date, anomaly ? 1 : 0, deviceId),
    env.DB.prepare(
      `UPDATE devices
       SET last_seen_at = ?, app_version = COALESCE(?, app_version)
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM users
           WHERE users.id = devices.user_id
             AND users.status = 'active'
             AND users.merged_into_user_id IS NULL
         )`
    ).bind(now, appVersion, deviceId)
  ];
  writes.push(
    env.DB.prepare(
      `INSERT INTO traffic_reports (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
       SELECT ?, devices.user_id, devices.id, ?, ?, ?, ?
       FROM devices
       INNER JOIN users ON users.id = devices.user_id
       WHERE devices.id = ?
         AND users.status = 'active'
         AND users.merged_into_user_id IS NULL`
    ).bind(reportId, upload, download, reportedAt ?? now, now, deviceId),
    env.DB.prepare(
      `INSERT INTO traffic_daily (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       SELECT devices.user_id, devices.id, ?, ?, ?, ?
       FROM devices
       INNER JOIN users ON users.id = devices.user_id
       WHERE devices.id = ?
         AND users.status = 'active'
         AND users.merged_into_user_id IS NULL
       ON CONFLICT(user_id, device_id, date) DO UPDATE SET
         upload_bytes = upload_bytes + excluded.upload_bytes,
         download_bytes = download_bytes + excluded.download_bytes,
         updated_at = excluded.updated_at`
    ).bind(date, upload, download, now, deviceId)
  );
  if (anomaly) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO traffic_anomalies (id, user_id, device_id, date, upload_delta, download_delta, reason, created_at)
         SELECT ?, devices.user_id, devices.id, ?, ?, ?, ?, ?
         FROM devices
         INNER JOIN users ON users.id = devices.user_id
         WHERE devices.id = ?
           AND users.status = 'active'
           AND users.merged_into_user_id IS NULL`
      ).bind(crypto.randomUUID(), date, upload, download, 'traffic_spike', now, deviceId)
    );
  }

  try {
    const results = await env.DB.batch(writes);
    if (getD1Changes(results[0]) === 0) throw new HttpError(409, 'device state changed');
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const duplicateResponse = await recoverTrafficReportDuplicate(env, reportId, payloadHash, {
        deviceId,
        upload,
        download,
        reportedAt
      });
      if (duplicateResponse) return duplicateResponse;
      const auditResponse = await recoverTrafficReportFromAudit(env, reportId, payloadHash, {
        deviceId,
        upload,
        download,
        reportedAt
      });
      if (auditResponse) return auditResponse;
    }
    throw error;
  }

  const traffic = await getTrafficSummary(env, deviceId, date);
  return json({ ok: true, anomaly, traffic });
}

async function createTrafficReportPayloadHash(input: {
  deviceId: string;
  upload: number;
  download: number;
  reportedAt: string | null;
}): Promise<string> {
  // User ids can change during a merge and appVersion can change while an accepted report awaits its lost response.
  // Neither changes the traffic mutation, so the stable device and mutation-bearing fields define idempotency.
  return sha256Hex(JSON.stringify([1, input.deviceId, input.upload, input.download, input.reportedAt]));
}

async function recoverTrafficReportDuplicate(
  env: Env,
  reportId: string,
  payloadHash: string,
  input: { deviceId: string; upload: number; download: number; reportedAt: string | null }
): Promise<Response | null> {
  let existing = await getTrafficReportDedup(env, reportId);
  if (!existing) return null;

  if (existing.payloadHash) {
    if (existing.payloadHash !== payloadHash) throw new HttpError(409, 'report id conflict');
  } else {
    const legacyPayloadMatches =
      existing.legacyDeviceId === input.deviceId &&
      Number(existing.legacyUploadDelta) === input.upload &&
      Number(existing.legacyDownloadDelta) === input.download &&
      (!input.reportedAt || existing.legacyReportedAt === input.reportedAt);
    if (!legacyPayloadMatches) throw new HttpError(409, 'report id conflict');

    const sealed = await env.DB.prepare(
      `UPDATE traffic_report_dedup
       SET
         payload_hash = ?,
         legacy_device_id = NULL,
         legacy_upload_delta = NULL,
         legacy_download_delta = NULL,
         legacy_reported_at = NULL
       WHERE id = ? AND payload_hash IS NULL`
    )
      .bind(payloadHash, reportId)
      .run();
    if (getD1Changes(sealed) === 0) {
      existing = await getTrafficReportDedup(env, reportId);
      if (!existing || existing.payloadHash !== payloadHash) throw new HttpError(409, 'report id conflict');
    }
  }

  return json({
    ok: true,
    anomaly: Number(existing.anomaly) === 1,
    duplicate: true,
    traffic: await getTrafficSummary(env, input.deviceId, existing.trafficDate)
  });
}

async function getTrafficReportDedup(env: Env, reportId: string): Promise<TrafficReportDedupRow | null> {
  return env.DB.prepare(
    `SELECT
       payload_hash AS payloadHash,
       traffic_date AS trafficDate,
       anomaly,
       legacy_device_id AS legacyDeviceId,
       legacy_upload_delta AS legacyUploadDelta,
       legacy_download_delta AS legacyDownloadDelta,
       legacy_reported_at AS legacyReportedAt
     FROM traffic_report_dedup
     WHERE id = ?`
  )
    .bind(reportId)
    .first<TrafficReportDedupRow>();
}

async function recoverTrafficReportFromAudit(
  env: Env,
  reportId: string,
  payloadHash: string,
  input: { deviceId: string; upload: number; download: number; reportedAt: string | null }
): Promise<Response | null> {
  const audit = await env.DB.prepare(
    `SELECT
       device_id AS deviceId,
       upload_delta AS uploadDelta,
       download_delta AS downloadDelta,
       reported_at AS reportedAt,
       COALESCE(strftime('%Y-%m-%d', created_at, '+8 hours'), substr(created_at, 1, 10), '1970-01-01') AS trafficDate
     FROM traffic_reports
     WHERE id = ?`
  )
    .bind(reportId)
    .first<TrafficReportAuditRow>();
  if (!audit) return null;
  if (
    audit.deviceId !== input.deviceId ||
    Number(audit.uploadDelta) !== input.upload ||
    Number(audit.downloadDelta) !== input.download ||
    (input.reportedAt && audit.reportedAt !== input.reportedAt)
  ) {
    throw new HttpError(409, 'report id conflict');
  }

  const anomaly = input.upload >= ANOMALY_THRESHOLD_BYTES || input.download >= ANOMALY_THRESHOLD_BYTES;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO traffic_report_dedup (id, payload_hash, traffic_date, anomaly)
     VALUES (?, ?, ?, ?)`
  )
    .bind(reportId, payloadHash, audit.trafficDate, anomaly ? 1 : 0)
    .run();
  const proof = await getTrafficReportDedup(env, reportId);
  if (!proof || proof.payloadHash !== payloadHash) throw new HttpError(409, 'report id conflict');

  return json({
    ok: true,
    anomaly,
    duplicate: true,
    traffic: await getTrafficSummary(env, input.deviceId, audit.trafficDate)
  });
}

export async function cleanupExpiredData(
  env: Env,
  now = Date.now(),
  maxReportBatches = RETENTION_MAX_REPORT_BATCHES
): Promise<RetentionCleanupResult> {
  const safeNow = Number.isFinite(now) && now > 0 ? now : Date.now();
  const safeMaxBatches = Math.max(1, Math.min(Math.floor(maxReportBatches), RETENTION_MAX_REPORT_BATCHES));
  const cutoff = new Date(safeNow - TRAFFIC_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deletedReportRows = 0;
  let completedBatches = 0;
  let lastBatchChanges = 0;
  let deletedRateLimitRows = 0;
  let completedRateLimitBatches = 0;
  let lastRateLimitBatchChanges = 0;

  for (let batch = 0; batch < safeMaxBatches; batch += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM traffic_reports
       WHERE id IN (
         SELECT id FROM traffic_reports
         WHERE created_at < ?
         ORDER BY created_at
         LIMIT ?
       )`
    )
      .bind(cutoff, RETENTION_DELETE_BATCH_SIZE)
      .run();
    lastBatchChanges = getD1Changes(result);
    deletedReportRows += lastBatchChanges;
    completedBatches += 1;
    if (lastBatchChanges < RETENTION_DELETE_BATCH_SIZE) break;
  }

  for (let batch = 0; batch < safeMaxBatches; batch += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM rate_limits
       WHERE key IN (
         SELECT key FROM rate_limits
         WHERE reset_at <= ?
         ORDER BY reset_at
         LIMIT ?
       )`
    )
      .bind(safeNow, RETENTION_DELETE_BATCH_SIZE)
      .run();
    lastRateLimitBatchChanges = getD1Changes(result);
    deletedRateLimitRows += lastRateLimitBatchChanges;
    completedRateLimitBatches += 1;
    if (lastRateLimitBatchChanges < RETENTION_DELETE_BATCH_SIZE) break;
  }

  return {
    cutoff,
    deletedReportRows,
    deletedRateLimitRows,
    reportBatchLimitReached: completedBatches === safeMaxBatches && lastBatchChanges === RETENTION_DELETE_BATCH_SIZE,
    rateLimitBatchLimitReached:
      completedRateLimitBatches === safeMaxBatches && lastRateLimitBatchChanges === RETENTION_DELETE_BATCH_SIZE
  };
}

function getD1Changes(result: unknown): number {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes) && changes > 0 ? Math.floor(changes) : 0;
}

async function getAdminTrafficLimitSummary(env: Env): Promise<AdminTrafficLimitSummary> {
  let row = await queryAdminTrafficLimitSummary(env);
  if (!row) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO admin_settings (id, traffic_limit_bytes, traffic_expires_at, updated_at)
       VALUES (1, ?, ?, ?)`
    )
      .bind(DEFAULT_TRAFFIC_LIMIT_BYTES, DEFAULT_TRAFFIC_EXPIRES_AT, new Date().toISOString())
      .run();
    row = await queryAdminTrafficLimitSummary(env);
  }

  const trafficLimitBytes = parseStoredTrafficLimitBytes(row?.trafficLimitBytes);
  const trafficExpiresAt = parseStoredTrafficExpiresAt(row?.trafficExpiresAt);
  const uploadBytes = normalizeBytes(row?.uploadBytes);
  const downloadBytes = normalizeBytes(row?.downloadBytes);
  const usedBytes = uploadBytes + downloadBytes;
  return {
    trafficLimitBytes,
    trafficExpiresAt,
    uploadBytes,
    downloadBytes,
    usedBytes,
    remainingBytes: Math.max(trafficLimitBytes - usedBytes, 0),
    exceededBytes: Math.max(usedBytes - trafficLimitBytes, 0),
    usagePercent: (usedBytes / trafficLimitBytes) * 100
  };
}

async function queryAdminTrafficLimitSummary(env: Env): Promise<AdminTrafficLimitRow | null> {
  return env.DB.prepare(
    `WITH traffic_totals AS (
       SELECT
         COALESCE(SUM(traffic_daily.upload_bytes), 0) AS uploadBytes,
         COALESCE(SUM(traffic_daily.download_bytes), 0) AS downloadBytes
       FROM traffic_daily
       INNER JOIN users ON users.id = traffic_daily.user_id
       WHERE users.status = 'active' AND users.merged_into_user_id IS NULL
     )
     SELECT
       admin_settings.traffic_limit_bytes AS trafficLimitBytes,
       admin_settings.traffic_expires_at AS trafficExpiresAt,
       traffic_totals.uploadBytes,
       traffic_totals.downloadBytes
     FROM admin_settings
     CROSS JOIN traffic_totals
     WHERE admin_settings.id = 1`
  ).first<AdminTrafficLimitRow>();
}

async function getAdminTrafficTrend(env: Env, requestedRange: string | null): Promise<Response> {
  const range = parseAdminTrafficTrendRange(requestedRange);
  const now = new Date();
  const points =
    range === 'hour'
      ? await getHourlyTrafficTrend(env, now)
      : range === 'month'
        ? await getMonthlyTrafficTrend(env, now)
        : await getDailyTrafficTrend(env, now);

  return json({
    range,
    timeZone: 'Asia/Shanghai',
    generatedAt: now.toISOString(),
    points
  });
}

async function getHourlyTrafficTrend(env: Env, now: Date): Promise<AdminTrafficTrendPoint[]> {
  const shiftedNow = new Date(now.getTime() + TRAFFIC_TIME_ZONE_OFFSET_MS);
  const dayStart =
    Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) -
    TRAFFIC_TIME_ZONE_OFFSET_MS;
  const currentHour = shiftedNow.getUTCHours();
  const result = await env.DB.prepare(
    `SELECT
       strftime('%H', traffic_reports.created_at, '+8 hours') AS bucket,
       COALESCE(SUM(traffic_reports.upload_delta), 0) AS uploadBytes,
       COALESCE(SUM(traffic_reports.download_delta), 0) AS downloadBytes
     FROM traffic_reports
     INNER JOIN users ON users.id = traffic_reports.user_id
     WHERE traffic_reports.created_at >= ?
       AND traffic_reports.created_at <= ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL
     GROUP BY bucket
     ORDER BY bucket`
  )
    .bind(new Date(dayStart).toISOString(), now.toISOString())
    .all<AdminTrafficTrendRow>();
  const totals = trendRowsByBucket(result.results);

  return Array.from({ length: currentHour + 1 }, (_, hour) => {
    const key = String(hour).padStart(2, '0');
    const values = totals.get(key);
    return {
      key,
      label: `${key}:00`,
      uploadBytes: values?.uploadBytes ?? 0,
      downloadBytes: values?.downloadBytes ?? 0
    };
  });
}

async function getDailyTrafficTrend(env: Env, now: Date): Promise<AdminTrafficTrendPoint[]> {
  const shiftedNow = new Date(now.getTime() + TRAFFIC_TIME_ZONE_OFFSET_MS);
  const endDate = shiftedNow.toISOString().slice(0, 10);
  const startDate = new Date(shiftedNow.getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    `SELECT
       traffic_daily.date AS bucket,
       COALESCE(SUM(traffic_daily.upload_bytes), 0) AS uploadBytes,
       COALESCE(SUM(traffic_daily.download_bytes), 0) AS downloadBytes
     FROM traffic_daily
     INNER JOIN users ON users.id = traffic_daily.user_id
     WHERE traffic_daily.date >= ?
       AND traffic_daily.date <= ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL
     GROUP BY traffic_daily.date
     ORDER BY traffic_daily.date`
  )
    .bind(startDate, endDate)
    .all<AdminTrafficTrendRow>();
  const totals = trendRowsByBucket(result.results);

  return Array.from({ length: 30 }, (_, index) => {
    const key = new Date(shiftedNow.getTime() - (29 - index) * DAY_MS).toISOString().slice(0, 10);
    const values = totals.get(key);
    return {
      key,
      label: key.slice(5).replace('-', '/'),
      uploadBytes: values?.uploadBytes ?? 0,
      downloadBytes: values?.downloadBytes ?? 0
    };
  });
}

async function getMonthlyTrafficTrend(env: Env, now: Date): Promise<AdminTrafficTrendPoint[]> {
  const shiftedNow = new Date(now.getTime() + TRAFFIC_TIME_ZONE_OFFSET_MS);
  const endMonthIndex = shiftedNow.getUTCFullYear() * 12 + shiftedNow.getUTCMonth();
  const monthKeys = Array.from({ length: 12 }, (_, index) => monthKeyFromIndex(endMonthIndex - 11 + index));
  const startDate = `${monthKeys[0]}-01`;
  const endDate = `${monthKeyFromIndex(endMonthIndex + 1)}-01`;
  const result = await env.DB.prepare(
    `SELECT
       substr(traffic_daily.date, 1, 7) AS bucket,
       COALESCE(SUM(traffic_daily.upload_bytes), 0) AS uploadBytes,
       COALESCE(SUM(traffic_daily.download_bytes), 0) AS downloadBytes
     FROM traffic_daily
     INNER JOIN users ON users.id = traffic_daily.user_id
     WHERE traffic_daily.date >= ?
       AND traffic_daily.date < ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL
     GROUP BY bucket
     ORDER BY bucket`
  )
    .bind(startDate, endDate)
    .all<AdminTrafficTrendRow>();
  const totals = trendRowsByBucket(result.results);

  return monthKeys.map((key) => {
    const values = totals.get(key);
    return {
      key,
      label: key.replace('-', '/'),
      uploadBytes: values?.uploadBytes ?? 0,
      downloadBytes: values?.downloadBytes ?? 0
    };
  });
}

function trendRowsByBucket(
  rows: AdminTrafficTrendRow[] | undefined
): Map<string, { uploadBytes: number; downloadBytes: number }> {
  return new Map(
    (rows ?? [])
      .filter((row) => typeof row.bucket === 'string')
      .map((row) => [
        row.bucket as string,
        {
          uploadBytes: normalizeBytes(row.uploadBytes),
          downloadBytes: normalizeBytes(row.downloadBytes)
        }
      ])
  );
}

function monthKeyFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

async function getTrafficSummary(env: Env, deviceId: string, date: string): Promise<TrafficSummary> {
  const summary = await env.DB.prepare(
    `WITH identity AS (
       SELECT user_id FROM devices WHERE id = ?
     )
     SELECT
       COALESCE((
         SELECT SUM(upload_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity)
       ), 0) AS totalUpload,
       COALESCE((
         SELECT SUM(download_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity)
       ), 0) AS totalDownload,
       COALESCE((
         SELECT SUM(upload_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity) AND device_id = ?
       ), 0) AS deviceTotalUpload,
       COALESCE((
         SELECT SUM(download_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity) AND device_id = ?
       ), 0) AS deviceTotalDownload,
       COALESCE((
         SELECT SUM(upload_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity) AND date = ?
       ), 0) AS todayUpload,
       COALESCE((
         SELECT SUM(download_bytes) FROM traffic_daily
         WHERE user_id = (SELECT user_id FROM identity) AND date = ?
       ), 0) AS todayDownload`
  )
    .bind(deviceId, deviceId, deviceId, date, date)
    .first<{
      totalUpload: number;
      totalDownload: number;
      deviceTotalUpload: number;
      deviceTotalDownload: number;
      todayUpload: number;
      todayDownload: number;
    }>();

  return {
    date,
    totalUpload: normalizeBytes(summary?.totalUpload),
    totalDownload: normalizeBytes(summary?.totalDownload),
    deviceTotalUpload: normalizeBytes(summary?.deviceTotalUpload),
    deviceTotalDownload: normalizeBytes(summary?.deviceTotalDownload),
    todayUpload: normalizeBytes(summary?.todayUpload),
    todayDownload: normalizeBytes(summary?.todayDownload),
    updatedAt: new Date().toISOString()
  };
}

function toTrafficDateKey(date: Date): string {
  return new Date(date.getTime() + TRAFFIC_TIME_ZONE_OFFSET_MS).toISOString().slice(0, 10);
}

async function listUsers(env: Env, pagination: AdminPagination): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
       users.id,
       users.name,
       users.status,
       CASE
         WHEN user_remote_config.user_id IS NOT NULL AND user_remote_config.enabled = 0 THEN '已停用'
         WHEN user_remote_config.user_id IS NOT NULL AND COALESCE(TRIM(user_remote_config.subscription_url), '') <> '' THEN '单独订阅'
         WHEN user_remote_config.user_id IS NOT NULL THEN '单独配置'
         WHEN remote_config.enabled = 0 THEN '已停用'
         WHEN COALESCE(TRIM(remote_config.subscription_url), '') <> '' THEN '跟随全局'
         ELSE '未配置'
       END AS subscriptionState,
       COALESCE(device_totals.devices, 0) AS devices,
       COALESCE(device_totals.deviceRecords, 0) AS deviceRecords,
        COALESCE(traffic_totals.uploadBytes, 0) AS uploadBytes,
        COALESCE(traffic_totals.downloadBytes, 0) AS downloadBytes,
        device_totals.lastSeenAt AS lastSeenAt,
        latest_version.app_version AS latestAppVersion,
        latest_version.last_seen_at AS appVersionReportedAt,
        COALESCE(anomaly_totals.anomalies, 0) AS anomalies,
       anomaly_totals.lastAnomalyAt AS lastAnomalyAt
     FROM users
     LEFT JOIN (
       SELECT
         current_device.user_id,
         COUNT(*) AS deviceRecords,
         COUNT(DISTINCT CASE
           WHEN COALESCE(TRIM(current_device.device_key), '') <> ''
             THEN 'key:' || current_device.device_key
           WHEN COALESCE(TRIM(current_device.device_name), '') <> ''
             THEN COALESCE(
               (
                 SELECT 'key:' || keyed_device.device_key
                 FROM devices keyed_device
                 WHERE keyed_device.user_id = current_device.user_id
                   AND COALESCE(TRIM(keyed_device.device_key), '') <> ''
                   AND LOWER(TRIM(keyed_device.device_name)) = LOWER(TRIM(current_device.device_name))
                   AND LOWER(TRIM(COALESCE(keyed_device.platform, ''))) =
                     LOWER(TRIM(COALESCE(current_device.platform, '')))
                 ORDER BY keyed_device.last_seen_at DESC
                 LIMIT 1
               ),
               'legacy:' || LOWER(TRIM(current_device.device_name)) || '|' ||
                 LOWER(TRIM(COALESCE(current_device.platform, '')))
             )
           ELSE 'record:' || current_device.id
         END) AS devices,
         MAX(current_device.last_seen_at) AS lastSeenAt
       FROM devices current_device
       GROUP BY current_device.user_id
     ) device_totals ON device_totals.user_id = users.id
     LEFT JOIN (
       SELECT user_id, SUM(upload_bytes) AS uploadBytes, SUM(download_bytes) AS downloadBytes
       FROM traffic_daily
       GROUP BY user_id
      ) traffic_totals ON traffic_totals.user_id = users.id
      LEFT JOIN devices latest_version
        ON latest_version.id = (
          SELECT candidate.id
          FROM devices candidate
          WHERE candidate.user_id = users.id
            AND COALESCE(TRIM(candidate.app_version), '') <> ''
          ORDER BY candidate.last_seen_at DESC, candidate.id DESC
          LIMIT 1
        )
       LEFT JOIN (
        SELECT user_id, COUNT(*) AS anomalies, MAX(created_at) AS lastAnomalyAt
        FROM traffic_anomalies
        GROUP BY user_id
      ) anomaly_totals ON anomaly_totals.user_id = users.id
      LEFT JOIN user_remote_config ON user_remote_config.user_id = users.id
      LEFT JOIN remote_config ON remote_config.id = 1
       WHERE users.status = 'active' AND users.merged_into_user_id IS NULL
       ORDER BY downloadBytes DESC, uploadBytes DESC, lastSeenAt DESC, users.id ASC
       LIMIT ? OFFSET ?`
  )
    .bind(pagination.limit + 1, pagination.offset)
    .all();
  const page = createAdminPage(result.results, pagination);
  return json({ users: page.items, page: page.metadata });
}

async function getUserTraffic(env: Env, userId: string, pagination: AdminPagination): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
       traffic_daily.date,
       traffic_daily.device_id AS deviceId,
       devices.device_name AS deviceName,
       traffic_daily.upload_bytes AS uploadBytes,
       traffic_daily.download_bytes AS downloadBytes,
       traffic_daily.updated_at AS updatedAt
     FROM traffic_daily
     LEFT JOIN devices ON devices.id = traffic_daily.device_id
     WHERE traffic_daily.user_id = ?
     ORDER BY traffic_daily.date DESC, traffic_daily.device_id ASC
     LIMIT ? OFFSET ?`
  )
    .bind(userId, pagination.limit + 1, pagination.offset)
    .all();
  const page = createAdminPage(result.results, pagination);
  return json({ rows: page.items, page: page.metadata });
}

async function listAnomalies(env: Env, pagination: AdminPagination): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
       traffic_anomalies.id,
       traffic_anomalies.user_id AS userId,
       users.name AS userName,
       traffic_anomalies.device_id AS deviceId,
       devices.device_name AS deviceName,
       traffic_anomalies.date,
       traffic_anomalies.upload_delta AS uploadBytes,
       traffic_anomalies.download_delta AS downloadBytes,
       traffic_anomalies.reason,
       traffic_anomalies.created_at AS createdAt
     FROM traffic_anomalies
     LEFT JOIN users ON users.id = traffic_anomalies.user_id
     LEFT JOIN devices ON devices.id = traffic_anomalies.device_id
     ORDER BY traffic_anomalies.created_at DESC, traffic_anomalies.id ASC
     LIMIT ? OFFSET ?`
  )
    .bind(pagination.limit + 1, pagination.offset)
    .all();
  const page = createAdminPage(result.results, pagination);
  return json({ anomalies: page.items, page: page.metadata });
}

async function getGlobalRemoteConfig(env: Env): Promise<RemoteControlConfig> {
  const row = await env.DB.prepare('SELECT * FROM remote_config WHERE id = 1').first<RemoteConfigRow>();
  if (!row) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO remote_config
       (id, version, enabled, subscription_url, rule_profile, preferred_region, region_fallback, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
       VALUES (1, 1, 1, NULL, NULL, 'jp', 'global', NULL, NULL, '[]', '[]', 1073741824, ?)`
    )
      .bind(now)
      .run();
    return {
      version: 1,
      enabled: true,
      configSource: 'global',
      subscriptionUrl: undefined,
      ruleProfile: 'ruleset',
      preferredRegion: 'jp',
      regionFallback: 'global',
      directRules: [],
      proxyRules: [],
      anomalyThresholdBytes: ANOMALY_THRESHOLD_BYTES,
      updatedAt: now
    };
  }

  return normalizeRemoteConfigRow(row);
}

async function getUserRemoteConfig(env: Env, userId: string): Promise<Partial<RemoteControlConfig> | null> {
  const row = await env.DB.prepare('SELECT * FROM user_remote_config WHERE user_id = ?')
    .bind(userId)
    .first<UserRemoteConfigRow>();
  if (!row) return null;

  return {
    enabled: typeof row.enabled === 'number' ? row.enabled === 1 : undefined,
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.subscription_url),
    ruleProfile: normalizeOptionalRuleProfile(row.rule_profile),
    preferredRegion: normalizeOptionalPreferredRegion(row.preferred_region),
    regionFallback: normalizeOptionalRegionFallback(row.region_fallback),
    updatedAt: row.updated_at ?? undefined
  };
}

async function getEffectiveRemoteConfig(env: Env, userId: string): Promise<RemoteControlConfig> {
  const global = await getGlobalRemoteConfig(env);
  const override = await getUserRemoteConfig(env, userId);
  if (!override) return global;

  return {
    ...global,
    enabled: typeof override.enabled === 'boolean' ? override.enabled : global.enabled,
    subscriptionUrl: override.subscriptionUrl ?? global.subscriptionUrl,
    ruleProfile: override.ruleProfile ?? global.ruleProfile,
    preferredRegion: override.preferredRegion ?? global.preferredRegion,
    regionFallback: override.regionFallback ?? global.regionFallback,
    updatedAt: override.updatedAt ?? global.updatedAt,
    configSource: 'user'
  };
}

async function getEffectiveClientStateForDevice(env: Env, deviceId: string): Promise<EffectiveClientState> {
  await getGlobalRemoteConfig(env);
  const row = await env.DB.prepare(
    `SELECT
       remote_config.version,
       remote_config.enabled,
       remote_config.subscription_url,
       remote_config.rule_profile,
       remote_config.preferred_region,
       remote_config.region_fallback,
       remote_config.updated_at,
       user_remote_config.enabled AS user_enabled,
       user_remote_config.subscription_url AS user_subscription_url,
       user_remote_config.rule_profile AS user_rule_profile,
       user_remote_config.preferred_region AS user_preferred_region,
       user_remote_config.region_fallback AS user_region_fallback,
       user_remote_config.updated_at AS user_updated_at,
       users.id AS user_id,
       users.name AS user_name,
       COALESCE((
         SELECT renamed_at FROM user_profile_audit
         WHERE user_id = users.id
         ORDER BY renamed_at DESC
         LIMIT 1
       ), users.created_at) AS profile_updated_at,
       user_notices.revision AS notice_revision,
       user_notices.enabled AS notice_enabled,
       user_notices.message AS notice_message,
       user_notices.tone AS notice_tone,
       user_notices.expires_at AS notice_expires_at,
       user_notices.updated_at AS notice_updated_at,
       user_notice_acknowledgements.acknowledged_at AS notice_acknowledged_at
     FROM devices
     INNER JOIN users ON users.id = devices.user_id
     INNER JOIN remote_config ON remote_config.id = 1
     LEFT JOIN user_remote_config ON user_remote_config.user_id = devices.user_id
     LEFT JOIN user_notices ON user_notices.user_id = devices.user_id
     LEFT JOIN user_notice_acknowledgements
       ON user_notice_acknowledgements.user_id = devices.user_id
      AND user_notice_acknowledgements.revision = user_notices.revision
      AND user_notice_acknowledgements.device_id = devices.id
     WHERE devices.id = ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL`
  )
    .bind(deviceId)
    .first<EffectiveDeviceConfigRow>();
  if (!row) throw new HttpError(409, 'device state changed');

  const global = normalizeRemoteConfigRow(row);
  const config = {
    ...global,
    enabled: typeof row.user_enabled === 'number' ? row.user_enabled === 1 : global.enabled,
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.user_subscription_url) ?? global.subscriptionUrl,
    ruleProfile: normalizeOptionalRuleProfile(row.user_rule_profile) ?? global.ruleProfile,
    preferredRegion: normalizeOptionalPreferredRegion(row.user_preferred_region) ?? global.preferredRegion,
    regionFallback: normalizeOptionalRegionFallback(row.user_region_fallback) ?? global.regionFallback,
    updatedAt: row.user_updated_at ?? global.updatedAt,
    configSource: row.user_updated_at ? ('user' as const) : ('global' as const)
  };
  const userId = cleanOptional(row.user_id);
  const name = cleanOptional(row.user_name);
  if (!userId || !name) throw new HttpError(409, 'device state changed');
  const profile: RemoteUserProfile = {
    userId,
    name,
    updatedAt: row.profile_updated_at ?? new Date(0).toISOString()
  };
  const notice = normalizeRemoteNoticeRow(row);
  return { config, profile, ...(notice ? { notice } : {}) };
}

function normalizeRemoteNoticeRow(row: EffectiveDeviceConfigRow, now = new Date()): RemoteUserNotice | undefined {
  if (row.notice_enabled !== 1 || row.notice_acknowledged_at) return undefined;
  const revision = row.notice_revision;
  const message = cleanOptional(row.notice_message);
  const tone = row.notice_tone === 'warning' ? 'warning' : row.notice_tone === 'info' ? 'info' : undefined;
  const expiresAt = cleanOptional(row.notice_expires_at);
  const updatedAt = cleanOptional(row.notice_updated_at);
  if (!Number.isSafeInteger(revision) || (revision ?? 0) <= 0 || !message || !tone || !expiresAt || !updatedAt) {
    return undefined;
  }
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined;
  return { revision: revision!, message, tone, expiresAt, updatedAt };
}

function normalizeRemoteConfigRow(row: RemoteConfigRow): RemoteControlConfig {
  return {
    version: typeof row.version === 'number' && row.version > 0 ? row.version : 1,
    enabled: row.enabled !== 0,
    configSource: 'global',
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.subscription_url),
    ruleProfile: normalizeRuleProfile(row.rule_profile),
    preferredRegion: normalizePreferredRegion(row.preferred_region),
    regionFallback: normalizeRegionFallback(row.region_fallback),
    directRules: [],
    proxyRules: [],
    anomalyThresholdBytes: ANOMALY_THRESHOLD_BYTES,
    updatedAt: row.updated_at ?? new Date(0).toISOString()
  };
}

async function requireKnownUser(env: Env, userId: string): Promise<void> {
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE id = ? AND status = 'active' AND merged_into_user_id IS NULL"
  )
    .bind(userId)
    .first<{ id: string }>();
  if (!user) throw new HttpError(404, 'unknown user');
}

async function resolveCanonicalUserId(env: Env, requestedUserId: string): Promise<string> {
  let userId = requestedUserId;
  const visited = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!userId || visited.has(userId)) throw new HttpError(409, 'invalid user merge');
    visited.add(userId);
    const user = await env.DB.prepare(
      'SELECT id, status, merged_into_user_id AS mergedIntoUserId FROM users WHERE id = ?'
    )
      .bind(userId)
      .first<{ id: string; status: string; mergedIntoUserId: string | null }>();
    if (!user) throw new HttpError(403, 'unknown device');
    if (!user.mergedIntoUserId) {
      if (user.status !== 'active') throw new HttpError(403, 'unknown device');
      return user.id;
    }
    userId = user.mergedIntoUserId;
  }
  throw new HttpError(409, 'invalid user merge');
}

async function verifyDeviceRequest(
  request: Request,
  env: Env,
  userId: string,
  deviceId: string,
  bodyText: string
): Promise<string> {
  const canonicalUserId = await resolveCanonicalUserId(env, userId);
  const device = await env.DB.prepare('SELECT id, device_seed AS deviceSeed FROM devices WHERE id = ? AND user_id = ?')
    .bind(deviceId, canonicalUserId)
    .first<{ id: string; deviceSeed: string }>();
  if (!device?.deviceSeed) throw new HttpError(403, 'unknown device');

  const timestamp = request.headers.get('x-youyu-timestamp')?.trim() ?? '';
  const signature = request.headers.get('x-youyu-signature')?.trim() ?? '';
  if (!timestamp || !signature) throw new HttpError(401, 'signature required');

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 5 * 60 * 1000) {
    throw new HttpError(401, 'stale signature');
  }

  const expected = await signDeviceRequest(
    request.method,
    new URL(request.url),
    bodyText,
    device.deviceSeed,
    timestamp
  );
  if (!constantTimeEqual(signature, expected)) throw new HttpError(401, 'invalid signature');
  return canonicalUserId;
}

async function signDeviceRequest(
  method: string,
  url: URL,
  bodyText: string,
  secret: string,
  timestamp: string
): Promise<string> {
  const canonical = [method.toUpperCase(), `${url.pathname}${url.search}`, timestamp, await sha256Hex(bodyText)].join(
    '\n'
  );
  return hmacSha256Hex(secret, canonical);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const expectedToken = env.ADMIN_TOKEN?.trim();
  if (!expectedToken) throw new HttpError(403, 'admin disabled');
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim();
  if (constantTimeEqual(token ?? '', expectedToken)) return;

  const rateLimitKey = `admin:${getClientIp(request)}`;
  await consumeRateLimitAttempt(env, rateLimitKey, 10, 15 * 60 * 1000);
  throw new HttpError(403, 'forbidden');
}

function parseAdminPagination(url: URL, defaultLimit: number): AdminPagination {
  for (const key of url.searchParams.keys()) {
    if (key !== 'limit' && key !== 'offset') throw new HttpError(400, 'invalid pagination');
  }
  if (url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('offset').length > 1) {
    throw new HttpError(400, 'invalid pagination');
  }

  const limit = parsePaginationInteger(url.searchParams.get('limit'), defaultLimit, 1, ADMIN_COLLECTION_MAX_PAGE_SIZE);
  const offset = parsePaginationInteger(url.searchParams.get('offset'), 0, 0, ADMIN_COLLECTION_MAX_OFFSET);
  return { limit, offset };
}

function parsePaginationInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new HttpError(400, 'invalid pagination');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'invalid pagination');
  }
  return parsed;
}

function createAdminPage<T>(
  rows: T[],
  pagination: AdminPagination
): {
  items: T[];
  metadata: {
    limit: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
} {
  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  return {
    items,
    metadata: {
      limit: pagination.limit,
      offset: pagination.offset,
      returned: items.length,
      hasMore,
      nextOffset: hasMore ? pagination.offset + items.length : null
    }
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
}

function staticAsset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store, no-transform',
      'content-type': contentType,
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff'
    }
  });
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function logRequestTelemetry(
  request: Request,
  url: URL,
  status: number,
  requestId: string,
  durationMs: number,
  errorCode?: string
): void {
  if (status < 500 && durationMs < 1000) return;
  const entry = {
    event: status >= 500 ? 'worker_request_error' : 'worker_request_slow',
    requestId,
    method: request.method,
    route: safeRouteLabel(url.pathname),
    status,
    durationMs,
    ...(errorCode ? { errorCode } : {})
  };
  if (status >= 500) console.error(entry);
  else console.warn(entry);
}

function safeRouteLabel(pathname: string): string {
  if (/^\/api\/admin\/users\/[^/]+\/profile$/.test(pathname)) return '/api/admin/users/:id/profile';
  if (/^\/api\/admin\/users\/[^/]+\/notice\/reset$/.test(pathname)) return '/api/admin/users/:id/notice/reset';
  if (/^\/api\/admin\/users\/[^/]+\/notice$/.test(pathname)) return '/api/admin/users/:id/notice';
  if (/^\/api\/admin\/users\/[^/]+\/merge-preview$/.test(pathname)) return '/api/admin/users/:id/merge-preview';
  if (/^\/api\/admin\/users\/[^/]+\/merge$/.test(pathname)) return '/api/admin/users/:id/merge';
  if (/^\/api\/admin\/users\/[^/]+\/config\/reset$/.test(pathname)) return '/api/admin/users/:id/config/reset';
  if (/^\/api\/admin\/users\/[^/]+\/config$/.test(pathname)) return '/api/admin/users/:id/config';
  if (/^\/api\/admin\/users\/[^/]+\/traffic$/.test(pathname)) return '/api/admin/users/:id/traffic';
  const knownRoutes = new Set([
    '/',
    '/admin',
    '/admin/assets/app.css',
    '/admin/assets/app.js',
    '/api/activate',
    '/api/traffic/report',
    '/api/notices/acknowledge',
    '/api/config',
    '/api/admin/users',
    '/api/admin/config',
    '/api/admin/traffic-limit',
    '/api/admin/traffic-trend',
    '/api/admin/config/sync-users',
    '/api/admin/maintenance',
    '/api/admin/anomalies'
  ]);
  return knownRoutes.has(pathname) ? pathname : '/unmatched';
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      allow: 'GET, POST, OPTIONS'
    }
  });
}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^(?:0|[1-9]\d*)$/.test(declaredLength.trim())) {
    await request.body?.cancel('invalid content length').catch(() => undefined);
    throw new HttpError(400, 'invalid content length');
  }
  if (declaredLength !== null && (!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > maxBytes)) {
    await request.body?.cancel('request too large').catch(() => undefined);
    throw new HttpError(413, 'request too large');
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const segments: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel('request too large').catch(() => undefined);
        throw new HttpError(413, 'request too large');
      }

      try {
        segments.push(decoder.decode(value, { stream: true }));
      } catch {
        await reader.cancel('invalid utf-8').catch(() => undefined);
        throw new HttpError(400, 'invalid json');
      }
    }

    try {
      segments.push(decoder.decode());
    } catch {
      throw new HttpError(400, 'invalid json');
    }
    return segments.join('');
  } catch (error) {
    if (!(error instanceof HttpError)) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readJsonObjectWithLimit(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  await requireJsonMediaType(request);
  const bodyText = await readRequestTextWithLimit(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid json');
  }
  return parsed as Record<string, unknown>;
}

async function requireJsonMediaType(request: Request): Promise<void> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) return;
  await request.body?.cancel('unsupported media type').catch(() => undefined);
  throw new HttpError(415, 'unsupported media type');
}

async function requireEmptyBody(request: Request): Promise<void> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^(?:0|[1-9]\d*)$/.test(declaredLength.trim())) {
    await request.body?.cancel('invalid content length').catch(() => undefined);
    throw new HttpError(400, 'invalid content length');
  }
  if (declaredLength !== null && Number(declaredLength) > 0) {
    await request.body?.cancel('unexpected request body').catch(() => undefined);
    throw new HttpError(400, 'unexpected request body');
  }
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done && first.value.byteLength > 0) {
      await reader.cancel('unexpected request body').catch(() => undefined);
      throw new HttpError(400, 'unexpected request body');
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeActivationText(value: unknown, maxLength: number, errorMessage: string): string | null {
  if (typeof value === 'undefined' || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, errorMessage);
  const text = value.trim();
  if (!text) return null;
  if (!isBoundedText(text, maxLength)) throw new HttpError(400, errorMessage);
  return text;
}

function parseAppVersion(value: unknown): string | null {
  const appVersion = normalizeActivationText(value, ACTIVATION_MAX_APP_VERSION_LENGTH, 'invalid app version');
  if (appVersion && !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(appVersion)) {
    throw new HttpError(400, 'invalid app version');
  }
  return appVersion;
}

function isBoundedText(value: string, maxLength: number): boolean {
  return Array.from(value).length <= maxLength && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function consumeRateLimitAttempt(env: Env, key: string, maxAttempts: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, attempts, reset_at, updated_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE WHEN rate_limits.reset_at > ? THEN MIN(rate_limits.attempts + 1, ?) ELSE 1 END,
       reset_at = CASE WHEN rate_limits.reset_at > ? THEN rate_limits.reset_at ELSE excluded.reset_at END,
       updated_at = excluded.updated_at
     RETURNING attempts`
  )
    .bind(key, now + windowMs, new Date(now).toISOString(), now, maxAttempts + 1, now)
    .first<{ attempts: number }>();
  if (!row || row.attempts > maxAttempts) throw new HttpError(429, 'too many attempts');
}

async function clearRateLimit(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

function normalizeBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseTrafficDelta(value: unknown, errorMessage: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, errorMessage);
  }
  return value;
}

function parseOptionalReportTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || hasControlCharacters(value)) {
    throw new HttpError(400, 'invalid reported at');
  }
  return parseStrictIsoDateTime(value.trim(), 'invalid reported at');
}

function parseTrafficLimitBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, 'invalid traffic limit');
  }
  return value;
}

function parseStoredTrafficLimitBytes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TRAFFIC_LIMIT_BYTES;
}

function parseTrafficExpiresAt(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid traffic expiry');
  return parseStrictIsoDateTime(value.trim(), 'invalid traffic expiry');
}

function parseStrictIsoDateTime(text: string, errorMessage: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    text
  );
  if (!match) throw new HttpError(400, errorMessage);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const nominal = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      milliseconds
    )
  );
  if (
    nominal.getUTCFullYear() !== Number(match[1]) ||
    nominal.getUTCMonth() !== Number(match[2]) - 1 ||
    nominal.getUTCDate() !== Number(match[3]) ||
    nominal.getUTCHours() !== Number(match[4]) ||
    nominal.getUTCMinutes() !== Number(match[5]) ||
    nominal.getUTCSeconds() !== Number(match[6])
  ) {
    throw new HttpError(400, errorMessage);
  }
  if (match[8] && (Number(match[9]) > 23 || Number(match[10]) > 59)) {
    throw new HttpError(400, errorMessage);
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, errorMessage);
  return date.toISOString();
}

function parseStoredTrafficExpiresAt(value: unknown): string {
  try {
    return parseTrafficExpiresAt(value);
  } catch {
    return DEFAULT_TRAFFIC_EXPIRES_AT;
  }
}

function parseAdminTrafficTrendRange(value: string | null): AdminTrafficTrendRange {
  if (value === null || value === '') return 'day';
  if (value === 'hour' || value === 'day' || value === 'month') return value;
  throw new HttpError(400, 'invalid traffic trend range');
}

function normalizeReportId(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isUuid(text) ? text : undefined;
}

function parseNullableConfigText(value: unknown, maxLength: number, errorMessage: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, errorMessage);
  const text = value.trim();
  if (!text) return null;
  if (Array.from(text).length > maxLength || hasControlCharacters(text)) {
    throw new HttpError(400, errorMessage);
  }
  return text;
}

function parseNullableConfigChoice(value: unknown, choices: string[], errorMessage: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, errorMessage);
  const text = value.trim();
  if (!choices.includes(text)) throw new HttpError(400, errorMessage);
  return text;
}

function assertSupportedRemoteConfigInput(input: RemoteConfigInput): void {
  const supportedFields = new Set(['enabled', 'subscriptionUrl', 'ruleProfile', 'preferredRegion', 'regionFallback']);
  if (Object.keys(input).some((field) => !supportedFields.has(field))) {
    throw new HttpError(400, 'unsupported config field');
  }
}

function assertOnlyFields(input: object, supportedFields: string[], errorMessage: string): void {
  const supported = new Set(supportedFields);
  if (Object.keys(input).some((field) => !supported.has(field))) throw new HttpError(400, errorMessage);
}

function normalizeRuleProfile(value: unknown): 'ruleset' | 'subscription' {
  return cleanOptional(value) === 'subscription' ? 'subscription' : 'ruleset';
}

function normalizeOptionalRuleProfile(value: unknown): 'ruleset' | 'subscription' | undefined {
  const profile = cleanOptional(value);
  if (!profile) return undefined;
  return profile === 'subscription' ? 'subscription' : 'ruleset';
}

function normalizePreferredRegion(value: unknown): RemoteControlConfig['preferredRegion'] {
  return normalizeOptionalPreferredRegion(value) ?? 'jp';
}

function normalizeOptionalPreferredRegion(value: unknown): RemoteControlConfig['preferredRegion'] | undefined {
  const region = cleanOptional(value);
  return region && ['auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr'].includes(region)
    ? (region as RemoteControlConfig['preferredRegion'])
    : undefined;
}

function normalizeRegionFallback(value: unknown): RemoteControlConfig['regionFallback'] {
  return normalizeOptionalRegionFallback(value) ?? 'global';
}

function normalizeOptionalRegionFallback(value: unknown): RemoteControlConfig['regionFallback'] | undefined {
  const fallback = cleanOptional(value);
  return fallback === 'strict' || fallback === 'global' ? fallback : undefined;
}

function parseNullableSubscriptionUrl(value: unknown): string | null {
  const text = parseNullableConfigText(value, 2048, 'invalid subscription url');
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') throw new Error('unsupported protocol');
    return text;
  } catch {
    throw new HttpError(400, 'invalid subscription url');
  }
}

function parseNoticeMessage(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid notice message');
  const message = value.trim();
  if (!message || !isBoundedText(message, USER_NOTICE_MAX_MESSAGE_LENGTH)) {
    throw new HttpError(400, 'invalid notice message');
  }
  return message;
}

function parseNoticeTone(value: unknown): 'info' | 'warning' {
  if (value === 'info' || value === 'warning') return value;
  throw new HttpError(400, 'invalid notice tone');
}

function parseNoticeDurationMinutes(value: unknown): number {
  if (value === undefined) return USER_NOTICE_DEFAULT_DURATION_MINUTES;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < USER_NOTICE_MIN_DURATION_MINUTES ||
    value > USER_NOTICE_MAX_DURATION_MINUTES ||
    value % USER_NOTICE_DURATION_STEP_MINUTES !== 0
  ) {
    throw new HttpError(400, 'invalid notice duration');
  }
  return value;
}

function normalizeStoredNoticeDurationMinutes(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= USER_NOTICE_MIN_DURATION_MINUTES &&
    value <= USER_NOTICE_MAX_DURATION_MINUTES &&
    value % USER_NOTICE_DURATION_STEP_MINUTES === 0
    ? value
    : USER_NOTICE_DEFAULT_DURATION_MINUTES;
}

function parseOptionalRequestId(value: unknown): string {
  const requestId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : crypto.randomUUID();
  if (!isUuid(requestId)) throw new HttpError(400, 'invalid request id');
  return requestId;
}

function parseNoticeRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, 'invalid notice revision');
  }
  return value;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeStoredSubscriptionUrl(value: unknown): string | undefined {
  const text = cleanOptional(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnField(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cleanOptional(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|constraint/i.test(message);
}

class HttpError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.code = errorCodeFor(status, message);
  }
}

function errorCodeFor(status: number, message: string): string {
  const knownCodes: Record<string, string> = {
    'admin disabled': 'ADMIN_DISABLED',
    'config conflict': 'CONFIG_CONFLICT',
    'device state changed': 'DEVICE_STATE_CHANGED',
    forbidden: 'FORBIDDEN',
    'internal error': 'INTERNAL_ERROR',
    'invalid app version': 'INVALID_APP_VERSION',
    'invalid config resolution': 'INVALID_CONFIG_RESOLUTION',
    'invalid content length': 'INVALID_CONTENT_LENGTH',
    'invalid device': 'INVALID_DEVICE',
    'invalid device key': 'INVALID_DEVICE_KEY',
    'invalid device name': 'INVALID_DEVICE_NAME',
    'invalid download delta': 'INVALID_DOWNLOAD_DELTA',
    'invalid enabled': 'INVALID_ENABLED',
    'invalid identity': 'INVALID_IDENTITY',
    'invalid json': 'INVALID_JSON',
    'invalid name': 'INVALID_NAME',
    'invalid notice enabled': 'INVALID_NOTICE_ENABLED',
    'invalid notice duration': 'INVALID_NOTICE_DURATION',
    'invalid notice expiry': 'INVALID_NOTICE_EXPIRY',
    'invalid notice message': 'INVALID_NOTICE_MESSAGE',
    'invalid notice revision': 'INVALID_NOTICE_REVISION',
    'invalid notice tone': 'INVALID_NOTICE_TONE',
    'invalid pagination': 'INVALID_PAGINATION',
    'invalid passphrase': 'INVALID_PASSPHRASE',
    'invalid platform': 'INVALID_PLATFORM',
    'invalid request id': 'INVALID_REQUEST_ID',
    'invalid report id': 'INVALID_REPORT_ID',
    'invalid reported at': 'INVALID_REPORTED_AT',
    'invalid rule profile': 'INVALID_RULE_PROFILE',
    'invalid preferred region': 'INVALID_PREFERRED_REGION',
    'invalid region fallback': 'INVALID_REGION_FALLBACK',
    'invalid signature': 'INVALID_SIGNATURE',
    'invalid subscription url': 'INVALID_SUBSCRIPTION_URL',
    'invalid target user': 'INVALID_TARGET_USER',
    'invalid traffic expiry': 'INVALID_TRAFFIC_EXPIRY',
    'invalid traffic limit': 'INVALID_TRAFFIC_LIMIT',
    'invalid traffic trend range': 'INVALID_TRAFFIC_TREND_RANGE',
    'invalid user': 'INVALID_USER',
    'invalid user merge': 'INVALID_USER_MERGE',
    'merge request conflict': 'MERGE_REQUEST_CONFLICT',
    'merge state changed': 'MERGE_STATE_CHANGED',
    'missing device': 'MISSING_DEVICE',
    'missing identity': 'MISSING_IDENTITY',
    'missing name': 'MISSING_NAME',
    'missing report id': 'MISSING_REPORT_ID',
    'not found': 'NOT_FOUND',
    'name conflict': 'NAME_CONFLICT',
    'notice state changed': 'NOTICE_STATE_CHANGED',
    'notice request conflict': 'NOTICE_REQUEST_CONFLICT',
    'profile request conflict': 'PROFILE_REQUEST_CONFLICT',
    'profile state changed': 'PROFILE_STATE_CHANGED',
    'registration conflict': 'REGISTRATION_CONFLICT',
    'registration disabled': 'REGISTRATION_DISABLED',
    'report id conflict': 'REPORT_ID_CONFLICT',
    'request too large': 'REQUEST_TOO_LARGE',
    'same user': 'SAME_USER',
    'signature required': 'SIGNATURE_REQUIRED',
    'stale signature': 'STALE_SIGNATURE',
    'too many attempts': 'TOO_MANY_ATTEMPTS',
    'unexpected request body': 'UNEXPECTED_REQUEST_BODY',
    'unknown device': 'UNKNOWN_DEVICE',
    'unknown target user': 'UNKNOWN_TARGET_USER',
    'unknown user': 'UNKNOWN_USER',
    'unsupported activation field': 'UNSUPPORTED_ACTIVATION_FIELD',
    'unsupported config field': 'UNSUPPORTED_CONFIG_FIELD',
    'unsupported merge field': 'UNSUPPORTED_MERGE_FIELD',
    'unsupported notice acknowledgement field': 'UNSUPPORTED_NOTICE_ACKNOWLEDGEMENT_FIELD',
    'unsupported notice field': 'UNSUPPORTED_NOTICE_FIELD',
    'unsupported profile field': 'UNSUPPORTED_PROFILE_FIELD',
    'unsupported media type': 'UNSUPPORTED_MEDIA_TYPE',
    'unsupported traffic report field': 'UNSUPPORTED_TRAFFIC_REPORT_FIELD',
    'unsupported traffic limit field': 'UNSUPPORTED_TRAFFIC_LIMIT_FIELD',
    'user already merged': 'USER_ALREADY_MERGED',
    'invalid upload delta': 'INVALID_UPLOAD_DELTA'
  };
  return knownCodes[message] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED');
}

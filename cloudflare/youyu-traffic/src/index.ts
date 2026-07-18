import { adminPage } from './adminPage';

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
};

type RemoteConfigRow = {
  version?: number;
  enabled?: number | null;
  subscription_url?: string | null;
  rule_profile?: string | null;
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
  user_updated_at?: string | null;
};

type RemoteControlConfig = {
  version: number;
  enabled: boolean;
  subscriptionUrl?: string;
  ruleProfile?: string;
  directRules: string[];
  proxyRules: string[];
  anomalyThresholdBytes: number;
  updatedAt: string;
};

type UserMergeInput = {
  targetUserId?: string;
  configResolution?: 'keep_target' | 'use_source' | 'reset_to_global';
  requestId?: string;
};

const TRAFFIC_REPORT_RETENTION_DAYS = 90;
const RETENTION_DELETE_BATCH_SIZE = 500;
const RETENTION_MAX_REPORT_BATCHES = 20;
const JSON_REQUEST_MAX_BODY_BYTES = 16 * 1024;
const ADMIN_CONFIG_MAX_BODY_BYTES = 64 * 1024;
const ACTIVATION_MAX_NAME_LENGTH = 80;
const ACTIVATION_MAX_DEVICE_NAME_LENGTH = 120;
const ACTIVATION_MAX_PLATFORM_LENGTH = 32;
const ACTIVATION_MAX_APP_VERSION_LENGTH = 64;
const TRAFFIC_TIME_ZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
const ANOMALY_THRESHOLD_BYTES = 1024 * 1024 * 1024;

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
    if (request.method === 'OPTIONS') return optionsResponse();

    try {
      if (request.method === 'POST' && url.pathname === '/api/activate') {
        return await activate(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/traffic/report') {
        return await reportTraffic(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return await getClientConfig(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/users') {
        await requireAdmin(request, env);
        return listUsers(env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/config') {
        await requireAdmin(request, env);
        return await getAdminConfig(env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/config') {
        await requireAdmin(request, env);
        return await updateAdminConfig(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/config/sync-users') {
        await requireAdmin(request, env);
        return await syncGlobalConfigToUsers(env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/maintenance') {
        await requireAdmin(request, env);
        return json({ ok: true, cleanup: await cleanupExpiredData(env) });
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
        return new Response(adminPage(), {
          headers: {
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            'content-type': 'text/html; charset=utf-8',
            'x-content-type-options': 'nosniff'
          }
        });
      }
      const userTrafficMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/traffic$/);
      if (request.method === 'GET' && userTrafficMatch) {
        await requireAdmin(request, env);
        return await getUserTraffic(env, userTrafficMatch[1]);
      }
      const userMergePreviewMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/merge-preview$/);
      if (request.method === 'GET' && userMergePreviewMatch) {
        await requireAdmin(request, env);
        return await previewAdminUserMerge(request, env, userMergePreviewMatch[1]);
      }
      const userMergeMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/merge$/);
      if (request.method === 'POST' && userMergeMatch) {
        await requireAdmin(request, env);
        return await mergeAdminUser(request, env, userMergeMatch[1]);
      }
      const userConfigMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config$/);
      if (userConfigMatch) {
        await requireAdmin(request, env);
        if (request.method === 'GET') return await getAdminUserConfig(env, userConfigMatch[1]);
        if (request.method === 'POST') return await updateAdminUserConfig(request, env, userConfigMatch[1]);
      }
      const userConfigResetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config\/reset$/);
      if (request.method === 'POST' && userConfigResetMatch) {
        await requireAdmin(request, env);
        return await resetAdminUserConfig(env, userConfigResetMatch[1]);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/anomalies') {
        await requireAdmin(request, env);
        return await listAnomalies(env);
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'internal error';
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: message }, status);
    }
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      cleanupExpiredData(env, controller.scheduledTime).catch((error) => {
        console.error('retention cleanup failed', error);
        throw error;
      })
    );
  }
};

async function activate(request: Request, env: Env): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES)) as ActivateInput;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new HttpError(400, 'missing name');
  if (!isBoundedText(name, ACTIVATION_MAX_NAME_LENGTH)) throw new HttpError(400, 'invalid name');

  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new HttpError(400, 'invalid name');

  const passphrase = typeof input.passphrase === 'string' ? input.passphrase.trim() : '';
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
  const appVersion = normalizeActivationText(
    input.appVersion,
    ACTIVATION_MAX_APP_VERSION_LENGTH,
    'invalid app version'
  );
  if (appVersion && !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(appVersion)) {
    throw new HttpError(400, 'invalid app version');
  }

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
       VALUES (?, ?, ?, ?, ?)`
    ).bind(proposedUserId, name, normalizedName, 'active', now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO devices
         (id, user_id, device_seed, device_key, device_name, platform, app_version, first_seen_at, last_seen_at)
       SELECT ?, COALESCE(users.merged_into_user_id, users.id), ?, ?, ?, ?, ?, ?, ?
       FROM users
       WHERE users.normalized_name = ?`
    ).bind(proposedDeviceId, deviceSeed, deviceKey || null, deviceName, platform, appVersion, now, now, normalizedName),
    env.DB.prepare(
      `UPDATE devices
       SET user_id = (
             SELECT COALESCE(merged_into_user_id, id)
             FROM users
             WHERE normalized_name = ?
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
     FROM users requested
     INNER JOIN users canonical ON canonical.id = COALESCE(requested.merged_into_user_id, requested.id)
     INNER JOIN devices ON devices.user_id = canonical.id
     WHERE requested.normalized_name = ? AND devices.device_seed = ?`
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

  await verifyDeviceRequest(request, env, userId, deviceId, '');
  return json({ config: await getEffectiveRemoteConfigForDevice(env, deviceId) });
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

  if (assignments.length === 0) return json({ config: await getGlobalRemoteConfig(env) });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO remote_config
       (id, version, enabled, subscription_url, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
     VALUES (1, 1, 1, NULL, NULL, NULL, NULL, '[]', '[]', 1073741824, ?)`
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
  const [knownUser] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND merged_into_user_id IS NULL").bind(
      userId
    ),
    env.DB.prepare(
      `DELETE FROM user_remote_config
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM users
             WHERE id = ? AND status = 'active' AND merged_into_user_id IS NULL
           )`
    ).bind(userId, userId)
  ]);
  if (!hasD1Rows(knownUser)) throw new HttpError(404, 'unknown user');
  const effective = await getEffectiveRemoteConfig(env, userId);
  await requireKnownUser(env, userId);
  return json({
    override: null,
    effective
  });
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
  updatedAt: string;
};

type AdminMergeAuditRow = {
  requestId: string;
  sourceUserId: string;
  targetUserId: string;
  configResolution: string;
  mergedAt: string;
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
           SELECT json_array(enabled, subscription_url, rule_profile, updated_at)
           FROM user_remote_config
           WHERE user_id = source.id
         ), '') = ?
         AND COALESCE((
           SELECT json_array(enabled, subscription_url, rule_profile, updated_at)
           FROM user_remote_config
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
      getAdminMergeConfigFingerprint(context.targetConfig)
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
    )
  ];

  if (configResolution === 'use_source') {
    if (context.sourceConfig) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO user_remote_config
             (user_id, enabled, subscription_url, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, updated_at)
           SELECT ?, enabled, subscription_url, rule_profile, NULL, NULL, NULL, NULL, ?
           FROM user_remote_config
           WHERE user_id = ? AND ${auditGuard}
           ON CONFLICT(user_id) DO UPDATE SET
             enabled = excluded.enabled,
             subscription_url = excluded.subscription_url,
             rule_profile = excluded.rule_profile,
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
  const [source, target, sourceConfig, targetConfig] = await Promise.all([
    getAdminMergeUser(env, sourceUserId),
    getAdminMergeUser(env, targetUserId),
    getAdminMergeConfig(env, sourceUserId),
    getAdminMergeConfig(env, targetUserId)
  ]);
  if (!source || source.status !== 'active' || source.mergedIntoUserId) throw new HttpError(404, 'unknown user');
  if (!target || target.status !== 'active' || target.mergedIntoUserId) throw new HttpError(404, 'unknown target user');
  const configConflict = Boolean(sourceConfig && targetConfig && !sameAdminMergeConfig(sourceConfig, targetConfig));
  const recommendedResolution: NonNullable<UserMergeInput['configResolution']> =
    sourceConfig && !targetConfig ? 'use_source' : 'keep_target';
  return { source, target, sourceConfig, targetConfig, configConflict, recommendedResolution };
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
    `SELECT enabled, subscription_url AS subscriptionUrl, rule_profile AS ruleProfile, updated_at AS updatedAt
     FROM user_remote_config
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<AdminMergeConfigRow>();
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
  return config ? JSON.stringify([config.enabled, config.subscriptionUrl, config.ruleProfile, config.updatedAt]) : '';
}

function sameAdminMergeConfig(left: AdminMergeConfigRow, right: AdminMergeConfigRow): boolean {
  return (
    left.enabled === right.enabled &&
    cleanOptional(left.subscriptionUrl) === cleanOptional(right.subscriptionUrl) &&
    normalizeOptionalRuleProfile(left.ruleProfile) === normalizeOptionalRuleProfile(right.ruleProfile)
  );
}

async function reportTraffic(request: Request, env: Env): Promise<Response> {
  const bodyText = await readRequestTextWithLimit(request, JSON_REQUEST_MAX_BODY_BYTES);
  const input = safeParseJson(bodyText) as TrafficReportInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid json');
  const reportId = normalizeReportId(input.reportId);
  const userId = String(input.userId ?? '').trim();
  const deviceId = String(input.deviceId ?? '').trim();
  const upload = normalizeBytes(input.uploadDelta);
  const download = normalizeBytes(input.downloadDelta);
  const now = new Date().toISOString();
  const date = toTrafficDateKey(new Date(now));

  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');
  if (!reportId) throw new HttpError(400, 'missing report id');

  await verifyDeviceRequest(request, env, userId, deviceId, bodyText);
  const appVersion = cleanOptional(input.appVersion);
  if (upload === 0 && download === 0) {
    const result = await env.DB.prepare(
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
    if (getD1Changes(result) === 0) throw new HttpError(409, 'device state changed');
    return json({ ok: true, traffic: await getTrafficSummary(env, deviceId, date) });
  }

  const anomaly = upload >= ANOMALY_THRESHOLD_BYTES || download >= ANOMALY_THRESHOLD_BYTES;
  const writes = [
    env.DB.prepare(
      `INSERT INTO traffic_reports (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
       SELECT ?, devices.user_id, devices.id, ?, ?, ?, ?
       FROM devices
       INNER JOIN users ON users.id = devices.user_id
       WHERE devices.id = ?
         AND users.status = 'active'
         AND users.merged_into_user_id IS NULL`
    ).bind(reportId, upload, download, cleanOptional(input.reportedAt) ?? now, now, deviceId),
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
    ).bind(now, appVersion, deviceId),
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
  ];
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
      return json({
        ok: true,
        anomaly: false,
        duplicate: true,
        traffic: await getTrafficSummary(env, deviceId, date)
      });
    }
    throw error;
  }

  return json({ ok: true, anomaly, traffic: await getTrafficSummary(env, deviceId, date) });
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

function hasD1Rows(result: unknown): boolean {
  const rows = (result as { results?: unknown[] } | null)?.results;
  return Array.isArray(rows) && rows.length > 0;
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

async function listUsers(env: Env): Promise<Response> {
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
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS anomalies, MAX(created_at) AS lastAnomalyAt
        FROM traffic_anomalies
        GROUP BY user_id
      ) anomaly_totals ON anomaly_totals.user_id = users.id
      LEFT JOIN user_remote_config ON user_remote_config.user_id = users.id
      LEFT JOIN remote_config ON remote_config.id = 1
      WHERE users.status = 'active' AND users.merged_into_user_id IS NULL
      ORDER BY downloadBytes DESC, uploadBytes DESC, lastSeenAt DESC`
  ).all();
  return json({ users: result.results });
}

async function getUserTraffic(env: Env, userId: string): Promise<Response> {
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
     ORDER BY traffic_daily.date DESC
     LIMIT 60`
  )
    .bind(userId)
    .all();
  return json({ rows: result.results });
}

async function listAnomalies(env: Env): Promise<Response> {
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
     ORDER BY traffic_anomalies.created_at DESC
     LIMIT 100`
  ).all();
  return json({ anomalies: result.results });
}

async function getGlobalRemoteConfig(env: Env): Promise<RemoteControlConfig> {
  const row = await env.DB.prepare('SELECT * FROM remote_config WHERE id = 1').first<RemoteConfigRow>();
  if (!row) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO remote_config
       (id, version, enabled, subscription_url, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
       VALUES (1, 1, 1, NULL, NULL, NULL, NULL, '[]', '[]', 1073741824, ?)`
    )
      .bind(now)
      .run();
    return {
      version: 1,
      enabled: true,
      subscriptionUrl: undefined,
      ruleProfile: 'ruleset',
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
    updatedAt: override.updatedAt ?? global.updatedAt
  };
}

async function getEffectiveRemoteConfigForDevice(env: Env, deviceId: string): Promise<RemoteControlConfig> {
  await getGlobalRemoteConfig(env);
  const row = await env.DB.prepare(
    `SELECT
       remote_config.version,
       remote_config.enabled,
       remote_config.subscription_url,
       remote_config.rule_profile,
       remote_config.updated_at,
       user_remote_config.enabled AS user_enabled,
       user_remote_config.subscription_url AS user_subscription_url,
       user_remote_config.rule_profile AS user_rule_profile,
       user_remote_config.updated_at AS user_updated_at
     FROM devices
     INNER JOIN users ON users.id = devices.user_id
     INNER JOIN remote_config ON remote_config.id = 1
     LEFT JOIN user_remote_config ON user_remote_config.user_id = devices.user_id
     WHERE devices.id = ?
       AND users.status = 'active'
       AND users.merged_into_user_id IS NULL`
  )
    .bind(deviceId)
    .first<EffectiveDeviceConfigRow>();
  if (!row) throw new HttpError(409, 'device state changed');

  const global = normalizeRemoteConfigRow(row);
  return {
    ...global,
    enabled: typeof row.user_enabled === 'number' ? row.user_enabled === 1 : global.enabled,
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.user_subscription_url) ?? global.subscriptionUrl,
    ruleProfile: normalizeOptionalRuleProfile(row.user_rule_profile) ?? global.ruleProfile,
    updatedAt: row.user_updated_at ?? global.updatedAt
  };
}

function normalizeRemoteConfigRow(row: RemoteConfigRow): RemoteControlConfig {
  return {
    version: typeof row.version === 'number' && row.version > 0 ? row.version : 1,
    enabled: row.enabled !== 0,
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.subscription_url),
    ruleProfile: normalizeRuleProfile(row.rule_profile),
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
  const rateLimitKey = `admin:${getClientIp(request)}`;
  await consumeRateLimitAttempt(env, rateLimitKey, 10, 15 * 60 * 1000);
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim();
  if (!constantTimeEqual(token ?? '', expectedToken)) {
    throw new HttpError(403, 'forbidden');
  }
  await clearRateLimit(env, rateLimitKey);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
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
  const declaredLength = request.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
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

function normalizeReportId(value: unknown): string | undefined {
  const text = normalizeText(value, 120);
  return text && /^[A-Za-z0-9:_-]{8,120}$/.test(text) ? text : undefined;
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
  const supportedFields = new Set(['enabled', 'subscriptionUrl', 'ruleProfile']);
  if (Object.keys(input).some((field) => !supportedFields.has(field))) {
    throw new HttpError(400, 'unsupported config field');
  }
}

function normalizeRuleProfile(value: unknown): 'ruleset' | 'subscription' {
  return cleanOptional(value) === 'subscription' ? 'subscription' : 'ruleset';
}

function normalizeOptionalRuleProfile(value: unknown): 'ruleset' | 'subscription' | undefined {
  const profile = cleanOptional(value);
  if (!profile) return undefined;
  return profile === 'subscription' ? 'subscription' : 'ruleset';
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

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
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
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

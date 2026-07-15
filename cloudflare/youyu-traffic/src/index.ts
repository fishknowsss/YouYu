export interface Env {
  DB: D1Database;
  REGISTRATION_PASSPHRASE: string;
  ADMIN_TOKEN?: string;
}

type ActivateInput = {
  name?: string;
  passphrase?: string;
  deviceSeed?: string;
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
  preferredNode?: string | null;
  preferredStrategy?: string | null;
  directRules?: unknown;
  proxyRules?: unknown;
  anomalyThresholdBytes?: number | null;
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

type RemoteControlConfig = {
  version: number;
  enabled: boolean;
  subscriptionUrl?: string;
  ruleProfile?: string;
  preferredNode?: string;
  preferredStrategy?: string;
  directRules: string[];
  proxyRules: string[];
  anomalyThresholdBytes: number;
  updatedAt: string;
};

const TRAFFIC_REPORT_RETENTION_DAYS = 90;
const RETENTION_DELETE_BATCH_SIZE = 500;
const RETENTION_MAX_REPORT_BATCHES = 20;
const JSON_REQUEST_MAX_BODY_BYTES = 16 * 1024;
const ADMIN_CONFIG_MAX_BODY_BYTES = 64 * 1024;
const ADMIN_RULE_MAX_ITEMS = 256;
const ADMIN_RULE_MAX_TEXT_LENGTH = 160;
const ACTIVATION_MAX_NAME_LENGTH = 80;
const ACTIVATION_MAX_DEVICE_NAME_LENGTH = 120;
const ACTIVATION_MAX_PLATFORM_LENGTH = 32;
const ACTIVATION_MAX_APP_VERSION_LENGTH = 64;
const TRAFFIC_TIME_ZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

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
        return adminPageV3();
      }
      const userTrafficMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/traffic$/);
      if (request.method === 'GET' && userTrafficMatch) {
        await requireAdmin(request, env);
        return await getUserTraffic(env, userTrafficMatch[1]);
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
         (id, user_id, device_seed, device_name, platform, app_version, first_seen_at, last_seen_at)
       SELECT ?, users.id, ?, ?, ?, ?, ?, ?
       FROM users
       WHERE users.normalized_name = ?`
    ).bind(proposedDeviceId, deviceSeed, deviceName, platform, appVersion, now, now, normalizedName),
    env.DB.prepare(
      `UPDATE devices
       SET user_id = (SELECT id FROM users WHERE normalized_name = ?),
           device_name = ?, platform = ?, app_version = ?, last_seen_at = ?
       WHERE device_seed = ?`
    ).bind(normalizedName, deviceName, platform, appVersion, now, deviceSeed)
  ]);

  const registration = await env.DB.prepare(
    `SELECT users.id AS userId, users.name, devices.id AS deviceId
     FROM users
     INNER JOIN devices ON devices.user_id = users.id
     WHERE users.normalized_name = ? AND devices.device_seed = ?`
  )
    .bind(normalizedName, deviceSeed)
    .first<{ userId: string; name: string; deviceId: string }>();
  if (!registration) throw new HttpError(409, 'registration conflict');

  const traffic = await getTrafficSummary(
    env,
    registration.userId,
    registration.deviceId,
    toTrafficDateKey(new Date(now))
  );

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
  return json({ config: await getEffectiveRemoteConfig(env, userId) });
}

async function getAdminConfig(env: Env): Promise<Response> {
  return json({ config: await getGlobalRemoteConfig(env) });
}

async function updateAdminConfig(request: Request, env: Env): Promise<Response> {
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as RemoteConfigInput;
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
      parseNullableConfigChoice(
        input.ruleProfile,
        ['ruleset', 'smart', 'global', 'subscription'],
        'invalid rule profile'
      )
    );
  }
  if (hasOwnField(input, 'preferredNode')) {
    assign('preferred_node', parseNullableConfigText(input.preferredNode, 120, 'invalid preferred node'));
  }
  if (hasOwnField(input, 'preferredStrategy')) {
    assign(
      'preferred_strategy',
      parseNullableConfigChoice(
        input.preferredStrategy,
        ['manual', 'auto', 'fallback', 'load-balance', 'direct'],
        'invalid preferred strategy'
      )
    );
  }
  if (hasOwnField(input, 'directRules')) {
    assign('direct_rules', JSON.stringify(parseAdminRuleList(input.directRules)));
  }
  if (hasOwnField(input, 'proxyRules')) {
    assign('proxy_rules', JSON.stringify(parseAdminRuleList(input.proxyRules)));
  }
  if (hasOwnField(input, 'anomalyThresholdBytes')) {
    assign('anomaly_threshold_bytes', parseAnomalyThreshold(input.anomalyThresholdBytes));
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
  return json({
    override,
    effective: await getEffectiveRemoteConfig(env, userId)
  });
}

async function updateAdminUserConfig(request: Request, env: Env, userId: string): Promise<Response> {
  await requireKnownUser(env, userId);
  const input = (await readJsonObjectWithLimit(request, ADMIN_CONFIG_MAX_BODY_BYTES)) as RemoteConfigInput;
  const assignments: string[] = [];
  const bindings: unknown[] = [];
  const assign = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
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
      parseNullableConfigChoice(
        input.ruleProfile,
        ['ruleset', 'smart', 'global', 'subscription'],
        'invalid rule profile'
      )
    );
  }
  if (hasOwnField(input, 'preferredNode')) {
    assign('preferred_node', parseNullableConfigText(input.preferredNode, 120, 'invalid preferred node'));
  }
  if (hasOwnField(input, 'preferredStrategy')) {
    assign(
      'preferred_strategy',
      parseNullableConfigChoice(
        input.preferredStrategy,
        ['manual', 'auto', 'fallback', 'load-balance', 'direct'],
        'invalid preferred strategy'
      )
    );
  }
  if (hasOwnField(input, 'directRules')) {
    assign('direct_rules', input.directRules === null ? null : JSON.stringify(parseAdminRuleList(input.directRules)));
  }
  if (hasOwnField(input, 'proxyRules')) {
    assign('proxy_rules', input.proxyRules === null ? null : JSON.stringify(parseAdminRuleList(input.proxyRules)));
  }
  if (hasOwnField(input, 'anomalyThresholdBytes')) {
    throw new HttpError(400, 'invalid anomaly threshold');
  }

  if (assignments.length > 0) {
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT OR IGNORE INTO user_remote_config (user_id, updated_at) VALUES (?, ?)')
      .bind(userId, now)
      .run();
    assignments.push('updated_at = ?');
    bindings.push(now);
    await env.DB.prepare(`UPDATE user_remote_config SET ${assignments.join(', ')} WHERE user_id = ?`)
      .bind(...bindings, userId)
      .run();
  }

  return json({
    override: await getUserRemoteConfig(env, userId),
    effective: await getEffectiveRemoteConfig(env, userId)
  });
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
  await env.DB.prepare('DELETE FROM user_remote_config WHERE user_id = ?').bind(userId).run();
  return json({
    override: null,
    effective: await getEffectiveRemoteConfig(env, userId)
  });
}

function adminPageV3(): Response {
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YouYu 后台</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2328; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; }
    main { width: 100%; max-width: 1500px; min-width: 0; margin: 0 auto; display: grid; gap: 12px; }
    main > *, .panel, .auth, .subscription-box, .table-wrap { min-width: 0; }
    .topbar, .panel-head, .toolbar, .actions, .subscription-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1, h2, h3, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; line-height: 1.1; }
    h2 { font-size: 18px; line-height: 1.2; }
    .status-text, .muted { color: #667085; }
    .panel, .auth { background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 14px; box-shadow: none; }
    .auth { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 10px; }
    .config-panel { display: grid; gap: 12px; }
    .subscription-box { display: grid; gap: 10px; padding: 12px; border: 1px solid #e7eaee; border-radius: 8px; background: #fbfcfd; }
    .subscription-field { display: grid; grid-template-columns: 76px minmax(0, 1fr); align-items: center; gap: 10px; }
    .subscription-field span { color: #344054; font-size: 13px; font-weight: 800; }
    .field-error { min-height: 18px; color: #b42318; font-size: 13px; font-weight: 800; }
    .advanced { display: grid; gap: 12px; border: 0; padding: 0; }
    .advanced summary { width: fit-content; height: 34px; display: inline-flex; align-items: center; border-radius: 8px; padding: 0 12px; background: #eef1f4; color: #1f2328; font-size: 13px; font-weight: 900; cursor: pointer; }
    .advanced[open] summary { margin-bottom: 12px; }
    .danger-zone { display: flex; justify-content: flex-end; padding-top: 2px; }
    .control-grid { display: grid; grid-template-columns: 112px 142px 142px 124px; gap: 10px; }
    .node-line { display: grid; grid-template-columns: 86px minmax(0, 1fr); align-items: center; gap: 10px; }
    .rules { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .admin-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 460px); align-items: start; gap: 12px; }
    .side-stack { min-width: 0; max-height: calc(100dvh - 36px); display: grid; gap: 12px; position: sticky; top: 18px; overflow: auto; scrollbar-gutter: stable; }
    .side-placeholder { display: grid; gap: 8px; min-height: 104px; align-content: center; }
    .side-stack .control-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .side-stack .rules { grid-template-columns: 1fr; }
    .side-stack #detailPanel table { min-width: 320px; }
    .users-panel { min-width: 0; }
    .users-panel .table-wrap { max-height: calc(100dvh - 312px); overflow: auto; }
    label { min-width: 0; display: grid; gap: 6px; color: #344054; font-size: 13px; font-weight: 800; }
    .node-line > span { color: #344054; font-size: 13px; font-weight: 800; }
    input, select, button { border-radius: 8px; font: inherit; }
    input, select { width: 100%; min-width: 0; height: 40px; border: 1px solid #d0d5dd; padding: 0 10px; background: #fff; color: #1f2328; }
    input::placeholder { color: #98a2b3; }
    button { height: 40px; border: 0; padding: 0 16px; background: #1f2328; color: #fff; font-weight: 900; cursor: pointer; }
    button.secondary { background: #eef1f4; color: #1f2328; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .chip { height: 30px; display: inline-flex; align-items: center; border-radius: 999px; padding: 0 10px; background: #eef1f4; color: #344054; font-size: 13px; font-weight: 800; }
    .chip.good { background: #e8f5ee; color: #166534; }
    .chip.warn { background: #fff4e5; color: #9a3412; }
    .chip.off { background: #f2f4f7; color: #667085; }
    .rule-card { min-width: 0; display: grid; gap: 10px; border: 1px solid #edf0f2; border-radius: 8px; padding: 12px; background: #fcfcfd; }
    .rule-card h3 { margin: 0; color: #344054; font-size: 13px; line-height: 1.2; }
    .check-list { display: grid; gap: 8px; }
    .check-list label { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; color: #1f2328; font-weight: 700; cursor: pointer; }
    .check-list input { width: 16px; height: 16px; margin: 1px 0 0; flex: 0 0 auto; }
    .check-list span { display: grid; gap: 2px; }
    .check-list small { color: #475467; font-size: 13px; font-weight: 500; line-height: 1.35; }
    .preserved-rules { display: flex; flex-wrap: wrap; gap: 6px; min-height: 0; }
    .preserved-rules:empty { display: none; }
    .preserved-rules .chip { max-width: 100%; height: auto; min-height: 28px; overflow-wrap: anywhere; }
    .chip-remove { width: 20px; height: 20px; margin-left: 6px; padding: 0; border-radius: 999px; background: #d0d5dd; color: #1f2328; font-size: 12px; line-height: 20px; }
    .table-wrap { overflow-x: auto; }
    td.actions-cell, th.actions-cell { text-align: right; }
    td.actions-cell .actions { justify-content: flex-end; gap: 8px; }
    table { width: 100%; min-width: 620px; border-collapse: collapse; }
    .users-table { min-width: 880px; }
    .users-table th, .users-table td { padding-left: 7px; padding-right: 7px; }
    .users-table tbody tr { cursor: pointer; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #edf0f2; text-align: left; white-space: nowrap; vertical-align: middle; }
    th { color: #667085; font-size: 13px; }
    th.sortable { padding: 0; }
    th.sortable button { width: 100%; height: auto; min-height: 42px; padding: 11px 8px; border-radius: 0; background: transparent; color: #667085; text-align: inherit; font-size: 13px; font-weight: 900; }
    th.sortable button:hover { background: #f8fafc; color: #1f2328; }
    th.sortable button::after { content: '  ↕'; color: #98a2b3; font-weight: 700; }
    th.sortable[data-active="true"] button { color: #1f2328; }
    th.sortable[data-active="true"][data-direction="asc"] button::after { content: '  ↑'; color: #1f2328; }
    th.sortable[data-active="true"][data-direction="desc"] button::after { content: '  ↓'; color: #1f2328; }
    td.num, th.num { text-align: right; }
    tbody tr:hover td { background: #fafbfc; }
    tr.is-active td { background: #f3f6fb; }
    .user-name-cell { max-width: 150px; overflow: hidden; text-overflow: ellipsis; font-weight: 900; }
    .anomaly-panel { padding: 0; overflow: hidden; }
    .anomaly-panel summary { min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; cursor: pointer; list-style: none; }
    .anomaly-panel summary::-webkit-details-marker { display: none; }
    .anomaly-panel summary strong { display: block; font-size: 18px; line-height: 1.2; }
    .anomaly-panel .table-wrap { border-top: 1px solid #edf0f2; }
    .summary-action { color: #344054; font-size: 13px; font-weight: 900; }
    .summary-action::before { content: '展开'; }
    .anomaly-panel[open] .summary-action::before { content: '收起'; }
    .danger { color: #b42318; font-weight: 900; }
    .hidden { display: none; }
    @media (max-width: 900px) {
      .admin-grid { grid-template-columns: 1fr; }
      .side-stack { position: static; }
    }
    @media (max-width: 860px) {
      body { padding: 14px; }
      .topbar, .panel-head, .toolbar, .actions, .subscription-head { align-items: start; flex-direction: column; }
      .auth, .control-grid, .node-line, .rules, .subscription-field, .admin-grid { grid-template-columns: 1fr; }
      .side-stack { position: static; }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div><h1>YouYu 后台</h1><p class="status-text" id="status">未加载</p></div>
      <div class="actions"><button class="secondary" id="changeToken">令牌</button><button class="secondary" id="refresh">刷新</button></div>
    </header>
    <section class="auth" id="authPanel">
      <input id="token" type="password" placeholder="管理令牌" autocomplete="current-password" />
      <button id="login">进入</button>
    </section>
    <section class="panel config-panel">
      <div class="panel-head">
        <div><h2>全局配置</h2></div>
        <div class="actions"><span class="chip" id="globalVersion">v1</span><button id="saveGlobal">保存</button></div>
      </div>
      <div class="subscription-box">
        <div class="subscription-head">
          <h3>全局订阅</h3>
          <span class="chip off" id="globalSubscriptionState">未配置</span>
        </div>
        <label class="subscription-field"><span>订阅链接</span><input id="globalSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" /></label>
        <div class="field-error" id="globalSubscriptionError"></div>
      </div>
      <details class="advanced">
        <summary>高级</summary>
        <div class="control-grid">
        <label>状态<select id="globalEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>规则<select id="globalRuleProfile"><option value="">不覆盖</option><option value="ruleset">智能规则</option><option value="subscription">兼容机场</option><option value="smart">本地规则</option><option value="global">全局代理</option></select></label>
        <label>策略<select id="globalStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
        <label>阈值 MB<input id="globalThreshold" type="number" min="1" step="1" /></label>
      </div>
      <div class="node-line"><span>启动选择</span><select id="globalNode"></select></div>
        <div class="rules">
        <div class="rule-card"><h3>直连规则</h3><div class="check-list" id="globalDirect"></div><div class="preserved-rules" id="globalDirectCustom"></div></div>
        <div class="rule-card"><h3>代理规则</h3><div class="check-list" id="globalProxy"></div><div class="preserved-rules" id="globalProxyCustom"></div></div>
        </div>
        <div class="danger-zone"><button class="secondary" id="syncGlobalUsers">清除覆盖</button></div>
      </details>
    </section>
    <div class="admin-grid">
      <section class="panel users-panel">
        <div class="toolbar"><h2>用户</h2><span class="muted" id="userCount">0 个用户</span></div>
        <div class="table-wrap"><table class="users-table"><thead><tr><th class="sortable" data-sort="name"><button type="button">姓名</button></th><th class="sortable" data-sort="subscriptionState"><button type="button">订阅</button></th><th class="num sortable" data-sort="devices"><button type="button">设备</button></th><th class="num sortable" data-sort="uploadBytes"><button type="button">上传</button></th><th class="num sortable" data-sort="downloadBytes"><button type="button">下载</button></th><th class="num sortable" data-sort="totalBytes"><button type="button">总量</button></th><th class="num sortable" data-sort="anomalies"><button type="button">异常</button></th><th class="sortable" data-sort="lastSeenAt"><button type="button">最后在线</button></th><th class="actions-cell"></th></tr></thead><tbody id="users"></tbody></table></div>
      </section>
      <aside class="side-stack">
        <section class="panel side-placeholder" id="sidePlaceholder">
          <h2>用户明细</h2>
          <p class="status-text">选择用户查看配置和流量</p>
        </section>
        <section class="panel hidden" id="userConfigPanel">
          <div class="toolbar"><h2 id="userConfigTitle">用户配置</h2><div class="actions"><button class="secondary" id="resetUserConfig">重置</button><button id="saveUserConfig">保存</button></div></div>
          <div class="subscription-box">
            <div class="subscription-head">
              <h3>用户订阅</h3>
              <span class="chip off" id="userSubscriptionState">跟随全局</span>
            </div>
            <label class="subscription-field"><span>模式</span><select id="userMode"><option value="follow">跟随全局</option><option value="custom">单独配置</option><option value="disabled">停用</option></select></label>
            <label class="subscription-field"><span>订阅链接</span><input id="userSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" /></label>
            <div class="field-error" id="userSubscriptionError"></div>
          </div>
          <details class="advanced">
            <summary>高级</summary>
            <div class="control-grid">
            <label>状态<select id="userEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
            <label>规则<select id="userRuleProfile"><option value="">不覆盖</option><option value="ruleset">智能规则</option><option value="subscription">兼容机场</option><option value="smart">本地规则</option><option value="global">全局代理</option></select></label>
            <label>策略<select id="userStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
            <label>启动选择<select id="userNode"></select></label>
          </div>
            <div class="rules">
            <div class="rule-card"><h3>直连规则</h3><div class="check-list" id="userDirect"></div><div class="preserved-rules" id="userDirectCustom"></div></div>
            <div class="rule-card"><h3>代理规则</h3><div class="check-list" id="userProxy"></div><div class="preserved-rules" id="userProxyCustom"></div></div>
            </div>
          </details>
        </section>
        <section class="panel hidden" id="detailPanel"><div class="toolbar"><h2 id="detailTitle">流量明细</h2><button class="secondary" id="closeDetail">收起</button></div><div class="table-wrap"><table><thead><tr><th>日期</th><th>设备</th><th class="num">上传</th><th class="num">下载</th></tr></thead><tbody id="details"></tbody></table></div></section>
        <details class="panel anomaly-panel hidden" id="anomalyPanel"><summary><span><strong>异常</strong><span class="muted" id="anomalyCount">0 条</span></span><span class="summary-action"></span></summary><div class="table-wrap"><table><thead><tr><th>用户</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>时间</th></tr></thead><tbody id="anomalies"></tbody></table></div></details>
      </aside>
    </div>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const usersBody = document.getElementById('users');
    const detailsBody = document.getElementById('details');
    const anomaliesBody = document.getElementById('anomalies');
    const statusEl = document.getElementById('status');
    const authPanel = document.getElementById('authPanel');
    const userCountEl = document.getElementById('userCount');
    const anomalyCountEl = document.getElementById('anomalyCount');
    const globalSubscriptionState = document.getElementById('globalSubscriptionState');
    const userSubscriptionState = document.getElementById('userSubscriptionState');
    const userModeEl = document.getElementById('userMode');
    const detailPanel = document.getElementById('detailPanel');
    const detailTitle = document.getElementById('detailTitle');
    const userConfigPanel = document.getElementById('userConfigPanel');
    const userConfigTitle = document.getElementById('userConfigTitle');
    const sidePlaceholder = document.getElementById('sidePlaceholder');
    const anomalyPanel = document.getElementById('anomalyPanel');
    const nodeChoices = [
      { value: '', label: '不指定，沿用客户端' },
      { value: '__default__', label: '默认优选节点' },
      { value: '自动选择', label: '自动选择' },
      { value: '故障转移', label: '故障转移' },
      { value: '负载均衡', label: '负载均衡' },
      { value: 'DIRECT', label: '直连' }
    ];
    const rulePresets = {
      direct: [
        { key: 'remote-control', label: '远程控制软件直连', hint: 'ToDesk、向日葵、AnyDesk、RustDesk、网易UU远程等进程', rules: ['PROCESS-NAME,ToDesk.exe,DIRECT', 'PROCESS-NAME,ToDesk_Service.exe,DIRECT', 'PROCESS-NAME,ToDesk_Lite.exe,DIRECT', 'PROCESS-NAME,SunloginClient.exe,DIRECT', 'PROCESS-NAME,SunloginClient_Desktop.exe,DIRECT', 'PROCESS-NAME,SunloginService.exe,DIRECT', 'PROCESS-NAME,AnyDesk.exe,DIRECT', 'PROCESS-NAME,RustDesk.exe,DIRECT', 'PROCESS-NAME,rustdesk.exe,DIRECT', 'PROCESS-NAME,UU.exe,DIRECT', 'PROCESS-NAME,UURemote.exe,DIRECT', 'PROCESS-NAME,UUDesktop.exe,DIRECT', 'PROCESS-NAME,UURemoteDesktop.exe,DIRECT', 'PROCESS-NAME,UUAccelerator.exe,DIRECT', 'PROCESS-NAME,NeteaseUU.exe,DIRECT'] },
        { key: 'lan', label: '局域网和私网直连', hint: '内网、路由器、公司局域网地址', rules: ['IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve', 'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve'] },
        { key: 'cn-sites', label: '国内常用域名直连', hint: '减少国内网站绕代理导致的慢速或异常', rules: ['DOMAIN-SUFFIX,cn,DIRECT', 'DOMAIN-SUFFIX,qq.com,DIRECT', 'DOMAIN-SUFFIX,alicdn.com,DIRECT', 'DOMAIN-SUFFIX,taobao.com,DIRECT', 'DOMAIN-SUFFIX,jd.com,DIRECT', 'DOMAIN-SUFFIX,bilibili.com,DIRECT', 'DOMAIN-SUFFIX,163.com,DIRECT'] }
      ],
      proxy: [
        { key: 'google-ai', label: 'Google 和 AI 服务代理', hint: 'Flow、Labs、Google API、YouTube 相关域名', rules: ['DOMAIN-SUFFIX,flow.google.com,PROXY', 'DOMAIN-SUFFIX,labs.google,PROXY', 'DOMAIN-SUFFIX,google.com,PROXY', 'DOMAIN-SUFFIX,googleapis.com,PROXY', 'DOMAIN-SUFFIX,googleusercontent.com,PROXY', 'DOMAIN-SUFFIX,gstatic.com,PROXY', 'DOMAIN-SUFFIX,youtube.com,PROXY', 'DOMAIN-SUFFIX,googlevideo.com,PROXY'] },
        { key: 'steam', label: 'Steam 相关服务代理', hint: '商店、社区、内容与聊天服务', rules: ['DOMAIN-SUFFIX,steampowered.com,PROXY', 'DOMAIN-SUFFIX,steamcommunity.com,PROXY', 'DOMAIN-SUFFIX,steamstatic.com,PROXY', 'DOMAIN-SUFFIX,steamcontent.com,PROXY', 'DOMAIN-SUFFIX,steamserver.net,PROXY', 'DOMAIN-SUFFIX,steam-chat.com,PROXY'] },
        { key: 'openai', label: 'OpenAI 服务代理', hint: 'ChatGPT、API、静态资源', rules: ['DOMAIN-SUFFIX,openai.com,PROXY', 'DOMAIN-SUFFIX,chatgpt.com,PROXY', 'DOMAIN-SUFFIX,oaiusercontent.com,PROXY'] }
      ]
    };
    const customRules = { global: { direct: [], proxy: [] }, user: { direct: [], proxy: [] } };
    const userSort = { key: 'totalBytes', direction: 'desc' };
    let loadedUsers = [];
    let activeUserId = '';
    let activeUserName = '';
    initConfigControls('global');
    initConfigControls('user');
    tokenInput.value = sessionStorage.getItem('youyu_admin_token') || localStorage.getItem('youyu_admin_token') || '';
    document.getElementById('login').onclick = () => {
      sessionStorage.setItem('youyu_admin_token', tokenInput.value.trim());
      localStorage.removeItem('youyu_admin_token');
      loadAll();
    };
    document.getElementById('refresh').onclick = loadAll;
    document.getElementById('changeToken').onclick = () => { authPanel.classList.toggle('hidden'); tokenInput.focus(); };
    document.getElementById('closeDetail').onclick = () => { detailPanel.classList.add('hidden'); updateSidePlaceholder(); };
    document.getElementById('saveGlobal').onclick = saveGlobalConfig;
    document.getElementById('syncGlobalUsers').onclick = syncGlobalUsers;
    document.getElementById('saveUserConfig').onclick = saveUserConfig;
    document.getElementById('resetUserConfig').onclick = resetUserConfig;
    userModeEl.onchange = updateUserModeState;
    document.querySelectorAll('th.sortable button').forEach((button) => {
      button.onclick = () => {
        const key = button.closest('th').dataset.sort;
        if (userSort.key === key) {
          userSort.direction = userSort.direction === 'desc' ? 'asc' : 'desc';
        } else {
          userSort.key = key;
          userSort.direction = key === 'name' ? 'asc' : 'desc';
        }
        renderUsers();
      };
    });
    async function api(path, options) {
      const token = tokenInput.value.trim() || sessionStorage.getItem('youyu_admin_token') || '';
      const headers = Object.assign({ authorization: 'Bearer ' + token }, options && options.headers ? options.headers : {});
      const res = await fetch(path, Object.assign({}, options || {}, { headers }));
      const text = await res.text();
      const data = parseJson(text);
      if (!res.ok) throw new Error(formatApiError(res.status, data));
      return data || {};
    }
    async function loadAll() {
      statusEl.textContent = '加载中';
      try { await Promise.all([loadGlobalConfig(), loadUsers(), loadAnomalies()]); authPanel.classList.add('hidden'); statusEl.textContent = '已更新'; }
      catch (error) { authPanel.classList.remove('hidden'); statusEl.textContent = formatAdminError(error); }
    }
    async function loadGlobalConfig() {
      const data = await api('/api/admin/config');
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
    }
    async function saveGlobalConfig() {
      if (!validateSubscriptionField('global')) return;
      const data = await api('/api/admin/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfigFields('global', true)) });
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
      await loadUsers();
      statusEl.textContent = '已保存，客户端会自动同步';
    }
    async function syncGlobalUsers() {
      if (prompt('清除所有用户的单独配置？输入“清除”确认') !== '清除') return;
      const data = await api('/api/admin/config/sync-users', { method: 'POST' });
      statusEl.textContent = '已清除 ' + (data.clearedUsers || 0) + ' 个覆盖';
      if (activeUserId) {
        setConfigFields('user', data.config || {});
        setUserMode('follow');
        setUserSubscriptionState(data.config || {}, null);
        userConfigTitle.textContent = activeUserName + ' 配置';
      }
      await loadUsers();
    }
    async function loadUsers() {
      const data = await api('/api/admin/users');
      loadedUsers = data.users || [];
      renderUsers();
      userCountEl.textContent = loadedUsers.length + ' 个用户';
    }
    function renderUsers() {
      usersBody.innerHTML = '';
      updateSortHeaders();
      for (const user of sortUsers(loadedUsers)) {
        const tr = document.createElement('tr');
        const displayName = user.name || user.id || '未命名';
        const anomalyText = user.anomalies ? '<span class="danger">' + user.anomalies + '</span>' : '0';
        const uploadBytes = user.uploadBytes || 0;
        const downloadBytes = user.downloadBytes || 0;
        tr.dataset.userId = user.id || '';
        if (user.id === activeUserId) tr.classList.add('is-active');
        tr.innerHTML = '<td class="user-name-cell" title="' + escapeHtml(displayName) + '">' + escapeHtml(displayName) + '</td><td>' + subscriptionBadge(user.subscriptionState) + '</td><td class="num">' + (user.devices || 0) + '</td><td class="num">' + formatBytes(uploadBytes) + '</td><td class="num">' + formatBytes(downloadBytes) + '</td><td class="num">' + formatBytes(uploadBytes + downloadBytes) + '</td><td class="num">' + anomalyText + '</td><td>' + formatTime(user.lastSeenAt) + '</td><td class="actions-cell"><div class="actions"><button data-action="manage" data-id="' + escapeHtml(user.id || '') + '" data-name="' + escapeHtml(displayName) + '">查看</button></div></td>';
        tr.onclick = (event) => { if (!event.target.closest('button')) loadUserOverview(user.id, displayName); };
        usersBody.appendChild(tr);
      }
      usersBody.querySelectorAll('button[data-action="manage"]').forEach((button) => { button.onclick = () => loadUserOverview(button.dataset.id, button.dataset.name); });
    }
    function revealSideForUser(userId) {
      sidePlaceholder.classList.add('hidden');
      usersBody.querySelectorAll('tr').forEach((row) => {
        row.classList.toggle('is-active', row.dataset.userId === userId);
      });
    }
    function updateSidePlaceholder() {
      const hasVisiblePanel = !userConfigPanel.classList.contains('hidden') || !detailPanel.classList.contains('hidden');
      sidePlaceholder.classList.toggle('hidden', hasVisiblePanel);
    }
    function updateSortHeaders() {
      document.querySelectorAll('th.sortable').forEach((th) => {
        th.dataset.active = String(th.dataset.sort === userSort.key);
        th.dataset.direction = th.dataset.sort === userSort.key ? userSort.direction : '';
      });
    }
    function sortUsers(users) {
      const sorted = [...users];
      sorted.sort((a, b) => {
        const result = compareUserValue(a, b, userSort.key);
        return userSort.direction === 'asc' ? result : -result;
      });
      return sorted;
    }
    function compareUserValue(a, b, key) {
      if (key === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
      if (key === 'subscriptionState') return String(a.subscriptionState || '').localeCompare(String(b.subscriptionState || ''), 'zh-CN');
      if (key === 'lastSeenAt') return dateValue(a.lastSeenAt) - dateValue(b.lastSeenAt);
      if (key === 'totalBytes') return numberValue(a.uploadBytes) + numberValue(a.downloadBytes) - numberValue(b.uploadBytes) - numberValue(b.downloadBytes);
      return numberValue(a[key]) - numberValue(b[key]);
    }
    function numberValue(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
    function dateValue(value) { const time = value ? new Date(value).getTime() : 0; return Number.isFinite(time) ? time : 0; }
    async function loadUserOverview(userId, name) {
      activeUserId = userId; activeUserName = name;
      revealSideForUser(userId);
      statusEl.textContent = name + ' 加载中';
      const [configData, trafficData] = await Promise.all([
        api('/api/admin/users/' + encodeURIComponent(userId) + '/config'),
        api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic')
      ]);
      renderUserConfig(name, configData);
      renderUserTraffic(name, trafficData.rows || []);
      userConfigPanel.classList.remove('hidden');
      detailPanel.classList.remove('hidden');
      updateSidePlaceholder();
      statusEl.textContent = name + ' 已加载';
    }
    async function loadUserConfig(userId, name) {
      activeUserId = userId; activeUserName = name;
      revealSideForUser(userId);
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config');
      renderUserConfig(name, data);
      userConfigPanel.classList.remove('hidden');
      updateSidePlaceholder();
    }
    function renderUserConfig(name, data) {
      const hasOverride = Boolean(data.override);
      setConfigFields('user', hasOverride ? data.override : data.effective || {});
      setUserMode(getUserModeFromConfig(data.override || null));
      setUserSubscriptionState(data.effective || {}, data.override || null);
      userConfigTitle.textContent = name + ' 配置';
    }
    async function saveUserConfig() {
      if (!activeUserId) return;
      const mode = getUserMode();
      if (mode === 'follow') {
        const data = await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config/reset', { method: 'POST' });
        setConfigFields('user', data.effective || {});
        setUserMode('follow');
        setUserSubscriptionState(data.effective || {}, null);
        userConfigTitle.textContent = activeUserName + ' 配置';
        await loadUsers();
        statusEl.textContent = activeUserName + ' 已跟随全局';
        return;
      }
      if (!validateSubscriptionField('user')) return;
      const payload = readConfigFields('user', false);
      payload.enabled = mode !== 'disabled';
      if (mode !== 'custom') payload.subscriptionUrl = null;
      const data = await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      setConfigFields('user', data.override || data.effective || {});
      setUserMode(getUserModeFromConfig(data.override || null));
      setUserSubscriptionState(data.effective || {}, data.override || null);
      userConfigTitle.textContent = activeUserName + ' 配置';
      await loadUsers();
      statusEl.textContent = activeUserName + ' 已保存';
    }
    async function resetUserConfig() {
      if (!activeUserId) return;
      const data = await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config/reset', { method: 'POST' });
      setConfigFields('user', data.effective || {});
      setUserMode('follow');
      setUserSubscriptionState(data.effective || {}, null);
      userConfigTitle.textContent = activeUserName + ' 配置';
      await loadUsers();
      statusEl.textContent = activeUserName + ' 已重置为跟随全局';
    }
    async function loadDetails(userId, name) {
      activeUserId = userId; activeUserName = name;
      revealSideForUser(userId);
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic');
      renderUserTraffic(name, data.rows || []);
      detailPanel.classList.remove('hidden');
      updateSidePlaceholder();
    }
    function renderUserTraffic(name, rows) {
      detailTitle.textContent = name + ' 流量';
      detailsBody.innerHTML = '';
      const visibleRows = (rows || []).slice(0, 14);
      if (!visibleRows.length) {
        detailsBody.innerHTML = '<tr><td colspan="4" class="muted">暂无流量</td></tr>';
        return;
      }
      for (const row of visibleRows) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.date || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num">' + formatBytes(row.downloadBytes || 0) + '</td>';
        detailsBody.appendChild(tr);
      }
    }
    async function loadAnomalies() {
      const data = await api('/api/admin/anomalies');
      const anomalies = data.anomalies || [];
      anomaliesBody.innerHTML = '';
      for (const row of anomalies.slice(0, 20)) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.userName || row.userId || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num danger">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num danger">' + formatBytes(row.downloadBytes || 0) + '</td><td>' + formatTime(row.createdAt) + '</td>';
        anomaliesBody.appendChild(tr);
      }
      anomalyCountEl.textContent = anomalies.length > 20 ? anomalies.length + ' 条，显示 20 条' : anomalies.length + ' 条';
      anomalyPanel.classList.toggle('hidden', anomalies.length === 0);
      if (anomalies.length === 0) anomalyPanel.open = false;
    }
    function setConfigFields(prefix, config) {
      document.getElementById(prefix + 'Enabled').value = config.enabled === false ? 'false' : 'true';
      document.getElementById(prefix + 'RuleProfile').value = config.ruleProfile || '';
      document.getElementById(prefix + 'Strategy').value = config.preferredStrategy || '';
      document.getElementById(prefix + 'Subscription').value = config.subscriptionUrl || '';
      setNodeChoice(prefix, config.preferredNode || '');
      setRuleChoices(prefix, 'direct', config.directRules || []);
      setRuleChoices(prefix, 'proxy', config.proxyRules || []);
      if (prefix === 'global') {
        document.getElementById('globalThreshold').value = Math.round((config.anomalyThresholdBytes || 1073741824) / 1024 / 1024);
        setGlobalSubscriptionState(config);
      }
    }
    function readConfigFields(prefix, includeThreshold) {
      const nodeChoice = document.getElementById(prefix + 'Node').value;
      const value = { enabled: document.getElementById(prefix + 'Enabled').value === 'true', subscriptionUrl: document.getElementById(prefix + 'Subscription').value.trim() || null, ruleProfile: document.getElementById(prefix + 'RuleProfile').value || null, preferredStrategy: document.getElementById(prefix + 'Strategy').value || null, preferredNode: nodeChoice === '__default__' ? null : nodeChoice || null, directRules: readRuleChoices(prefix, 'direct'), proxyRules: readRuleChoices(prefix, 'proxy') };
      if (includeThreshold) value.anomalyThresholdBytes = Math.max(1, Number(document.getElementById('globalThreshold').value || 1024)) * 1024 * 1024;
      return value;
    }
    function validateSubscriptionField(prefix) {
      const input = document.getElementById(prefix + 'Subscription');
      const error = document.getElementById(prefix + 'SubscriptionError');
      const value = input.value.trim();
      if (error) error.textContent = '';
      if (value && !value.startsWith('https://')) {
        const message = '订阅链接需以 https:// 开头';
        if (error) error.textContent = message;
        statusEl.textContent = message;
        input.focus();
        return false;
      }
      return true;
    }
    function getUserMode() {
      const value = userModeEl.value;
      return value === 'custom' || value === 'disabled' ? value : 'follow';
    }
    function setUserMode(mode) {
      userModeEl.value = mode;
      updateUserModeState();
    }
    function getUserModeFromConfig(override) {
      if (!override) return 'follow';
      if (override.enabled === false) return 'disabled';
      return 'custom';
    }
    function updateUserModeState() {
      const mode = getUserMode();
      const editable = mode === 'custom';
      document.getElementById('userSubscription').disabled = !editable;
      document.querySelectorAll('#userConfigPanel details.advanced input, #userConfigPanel details.advanced select').forEach((field) => {
        field.disabled = !editable;
      });
    }
    function initConfigControls(prefix) {
      const nodeSelect = document.getElementById(prefix + 'Node');
      nodeSelect.innerHTML = nodeChoices.map((choice) => '<option value="' + escapeHtml(choice.value) + '">' + escapeHtml(choice.label) + '</option>').join('');
      renderRulePresetGroup(prefix, 'direct');
      renderRulePresetGroup(prefix, 'proxy');
    }
    function renderRulePresetGroup(prefix, kind) {
      const el = document.getElementById(prefix + (kind === 'direct' ? 'Direct' : 'Proxy'));
      el.innerHTML = rulePresets[kind].map((preset) => '<label><input type="checkbox" data-rule-kind="' + kind + '" value="' + escapeHtml(preset.key) + '" /><span>' + escapeHtml(preset.label) + '<small>' + escapeHtml(preset.hint) + '</small></span></label>').join('');
    }
    function setNodeChoice(prefix, value) {
      const select = document.getElementById(prefix + 'Node');
      const customOptionId = prefix + 'CustomNodeOption';
      document.getElementById(customOptionId)?.remove();
      if (value && !nodeChoices.some((choice) => choice.value === value)) {
        const option = document.createElement('option');
        option.id = customOptionId;
        option.value = value;
        option.textContent = '保留现有节点：' + value;
        select.appendChild(option);
      }
      select.value = value || '';
    }
    function setRuleChoices(prefix, kind, rules) {
      const normalized = new Set((rules || []).map(normalizeRuleText).filter(Boolean));
      const matched = new Set();
      for (const preset of rulePresets[kind]) {
        const presetRules = preset.rules.map(normalizeRuleText);
        const checked = presetRules.every((rule) => normalized.has(rule));
        const checkbox = document.querySelector('#' + prefix + (kind === 'direct' ? 'Direct' : 'Proxy') + ' input[value="' + preset.key + '"]');
        if (checkbox) checkbox.checked = checked;
        if (checked) presetRules.forEach((rule) => matched.add(rule));
      }
      customRules[prefix][kind] = [...normalized].filter((rule) => !matched.has(rule));
      renderCustomRules(prefix, kind);
    }
    function readRuleChoices(prefix, kind) {
      const selected = [];
      document.querySelectorAll('#' + prefix + (kind === 'direct' ? 'Direct' : 'Proxy') + ' input:checked').forEach((checkbox) => {
        const preset = rulePresets[kind].find((item) => item.key === checkbox.value);
        if (preset) selected.push(...preset.rules);
      });
      return dedupeRules([...selected, ...customRules[prefix][kind]]);
    }
    function renderCustomRules(prefix, kind) {
      const el = document.getElementById(prefix + (kind === 'direct' ? 'DirectCustom' : 'ProxyCustom'));
      el.innerHTML = customRules[prefix][kind].map((rule, index) => '<span class="chip">' + escapeHtml(rule) + '<button class="chip-remove" type="button" data-rule-index="' + index + '" title="移除">x</button></span>').join('');
      el.querySelectorAll('button[data-rule-index]').forEach((button) => {
        button.onclick = () => {
          customRules[prefix][kind].splice(Number(button.dataset.ruleIndex), 1);
          renderCustomRules(prefix, kind);
        };
      });
    }
    function setGlobalSubscriptionState(config) {
      if (config.enabled === false) return setSubscriptionChip(globalSubscriptionState, '已停用');
      if (config.subscriptionUrl) return setSubscriptionChip(globalSubscriptionState, '已设置');
      setSubscriptionChip(globalSubscriptionState, '未配置');
    }
    function setUserSubscriptionState(effective, override) {
      if (override && override.enabled === false) return setSubscriptionChip(userSubscriptionState, '已停用');
      if (override && override.subscriptionUrl) return setSubscriptionChip(userSubscriptionState, '单独订阅');
      if (override) return setSubscriptionChip(userSubscriptionState, '单独配置');
      if (effective && effective.subscriptionUrl) return setSubscriptionChip(userSubscriptionState, '跟随全局');
      setSubscriptionChip(userSubscriptionState, '未配置');
    }
    function setSubscriptionChip(el, text) {
      el.textContent = text;
      el.className = 'chip ' + subscriptionClass(text);
    }
    function subscriptionBadge(value) {
      const text = value || '未配置';
      return '<span class="chip ' + subscriptionClass(text) + '">' + escapeHtml(text) + '</span>';
    }
    function subscriptionClass(value) {
      if (value === '已设置' || value === '单独订阅' || value === '跟随全局') return 'good';
      if (value === '已停用') return 'off';
      return 'warn';
    }
    function parseJson(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    }
    function formatApiError(status, data) {
      const error = data && data.error ? String(data.error) : '';
      if (status === 403) return error === 'admin disabled' ? '后台未启用管理' : '管理 token 不对';
      if (status === 401) return '设备签名无效';
      if (status === 429) return '请求太频繁';
      if (status === 400) return error === 'invalid subscription url' ? '订阅链接无效' : '请求内容有误';
      if (status === 404) return '接口不存在';
      if (status >= 500) return '后台暂时不可用';
      return '请求失败';
    }
    function formatAdminError(error) {
      return error instanceof Error && error.message ? error.message : '无法加载';
    }
    function normalizeRuleText(rule) { return String(rule || '').split(',').map((part) => part.trim()).filter(Boolean).join(','); }
    function dedupeRules(rules) { return [...new Set(rules.map(normalizeRuleText).filter(Boolean))]; }
    function formatBytes(bytes) { if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'; return (bytes / 1073741824).toFixed(2) + ' GB'; }
    function formatTime(value) { if (!value) return '-'; return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  </script>
</body>
</html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    }
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
  if (upload === 0 && download === 0) {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?')
      .bind(now, cleanOptional(input.appVersion), deviceId)
      .run();
    return json({ ok: true, traffic: await getTrafficSummary(env, userId, deviceId, date) });
  }

  const config = await getEffectiveRemoteConfig(env, userId);
  const anomaly = upload >= config.anomalyThresholdBytes || download >= config.anomalyThresholdBytes;
  const writes = [
    env.DB.prepare(
      `INSERT INTO traffic_reports (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(reportId, userId, deviceId, upload, download, cleanOptional(input.reportedAt) ?? now, now),
    env.DB.prepare('UPDATE devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?').bind(
      now,
      cleanOptional(input.appVersion),
      deviceId
    ),
    env.DB.prepare(
      `INSERT INTO traffic_daily (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id, date) DO UPDATE SET
         upload_bytes = upload_bytes + excluded.upload_bytes,
         download_bytes = download_bytes + excluded.download_bytes,
         updated_at = excluded.updated_at`
    ).bind(userId, deviceId, date, upload, download, now)
  ];
  if (anomaly) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO traffic_anomalies (id, user_id, device_id, date, upload_delta, download_delta, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, deviceId, date, upload, download, 'traffic_spike', now)
    );
  }

  try {
    await env.DB.batch(writes);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return json({
        ok: true,
        anomaly: false,
        duplicate: true,
        traffic: await getTrafficSummary(env, userId, deviceId, date)
      });
    }
    throw error;
  }

  return json({ ok: true, anomaly, traffic: await getTrafficSummary(env, userId, deviceId, date) });
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

async function getTrafficSummary(env: Env, userId: string, deviceId: string, date: string): Promise<TrafficSummary> {
  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(upload_bytes), 0) AS totalUpload,
       COALESCE(SUM(download_bytes), 0) AS totalDownload
     FROM traffic_daily
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ totalUpload: number; totalDownload: number }>();
  const deviceTotals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(upload_bytes), 0) AS totalUpload,
       COALESCE(SUM(download_bytes), 0) AS totalDownload
     FROM traffic_daily
     WHERE user_id = ? AND device_id = ?`
  )
    .bind(userId, deviceId)
    .first<{ totalUpload: number; totalDownload: number }>();
  const today = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(upload_bytes), 0) AS upload,
       COALESCE(SUM(download_bytes), 0) AS download
     FROM traffic_daily
     WHERE user_id = ? AND date = ?`
  )
    .bind(userId, date)
    .first<{ upload: number; download: number }>();

  return {
    date,
    totalUpload: normalizeBytes(totals?.totalUpload),
    totalDownload: normalizeBytes(totals?.totalDownload),
    deviceTotalUpload: normalizeBytes(deviceTotals?.totalUpload),
    deviceTotalDownload: normalizeBytes(deviceTotals?.totalDownload),
    todayUpload: normalizeBytes(today?.upload),
    todayDownload: normalizeBytes(today?.download),
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
       COALESCE(traffic_totals.uploadBytes, 0) AS uploadBytes,
       COALESCE(traffic_totals.downloadBytes, 0) AS downloadBytes,
       device_totals.lastSeenAt AS lastSeenAt,
       COALESCE(anomaly_totals.anomalies, 0) AS anomalies,
       anomaly_totals.lastAnomalyAt AS lastAnomalyAt
     FROM users
     LEFT JOIN (
       SELECT user_id, COUNT(*) AS devices, MAX(last_seen_at) AS lastSeenAt
       FROM devices
       GROUP BY user_id
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
      directRules: [],
      proxyRules: [],
      anomalyThresholdBytes: 1073741824,
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
    ruleProfile: cleanOptional(row.rule_profile) ?? undefined,
    preferredNode: cleanOptional(row.preferred_node) ?? undefined,
    preferredStrategy: cleanOptional(row.preferred_strategy) ?? undefined,
    directRules: typeof row.direct_rules === 'string' ? parseRuleList(row.direct_rules) : undefined,
    proxyRules: typeof row.proxy_rules === 'string' ? parseRuleList(row.proxy_rules) : undefined,
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
    preferredNode: override.preferredNode ?? global.preferredNode,
    preferredStrategy: override.preferredStrategy ?? global.preferredStrategy,
    directRules: override.directRules ?? global.directRules,
    proxyRules: override.proxyRules ?? global.proxyRules,
    updatedAt: override.updatedAt ?? global.updatedAt
  };
}

function normalizeRemoteConfigRow(row: RemoteConfigRow): RemoteControlConfig {
  return {
    version: typeof row.version === 'number' && row.version > 0 ? row.version : 1,
    enabled: row.enabled !== 0,
    subscriptionUrl: normalizeStoredSubscriptionUrl(row.subscription_url),
    ruleProfile: cleanOptional(row.rule_profile) ?? undefined,
    preferredNode: cleanOptional(row.preferred_node) ?? undefined,
    preferredStrategy: cleanOptional(row.preferred_strategy) ?? undefined,
    directRules: parseRuleList(row.direct_rules),
    proxyRules: parseRuleList(row.proxy_rules),
    anomalyThresholdBytes:
      typeof row.anomaly_threshold_bytes === 'number' && row.anomaly_threshold_bytes > 0
        ? row.anomaly_threshold_bytes
        : 1073741824,
    updatedAt: row.updated_at ?? new Date(0).toISOString()
  };
}

async function requireKnownUser(env: Env, userId: string): Promise<void> {
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
  if (!user) throw new HttpError(404, 'unknown user');
}

async function verifyDeviceRequest(
  request: Request,
  env: Env,
  userId: string,
  deviceId: string,
  bodyText: string
): Promise<void> {
  const device = await env.DB.prepare('SELECT id, device_seed AS deviceSeed FROM devices WHERE id = ? AND user_id = ?')
    .bind(deviceId, userId)
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

function parseRuleList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim().startsWith('[')
      ? safeParseJson(value)
      : typeof value === 'string'
        ? value.split(/\r?\n/)
        : [];
  if (!Array.isArray(raw)) return [];

  return raw.map((item) => normalizeText(item, 160)).filter((item): item is string => Boolean(item));
}

function parseAdminRuleList(value: unknown): string[] {
  let raw: unknown;
  if (value === null || value === '') {
    raw = [];
  } else if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    raw = text.startsWith('[') ? safeParseJson(text) : text.split(/\r?\n/);
  }

  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid rules');
  if (raw.length > ADMIN_RULE_MAX_ITEMS) throw new HttpError(400, 'too many rules');

  const rules: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new HttpError(400, 'invalid rules');
    const text = item.trim();
    if (!text) continue;
    if (Array.from(text).length > ADMIN_RULE_MAX_TEXT_LENGTH || hasControlCharacters(text)) {
      throw new HttpError(400, 'invalid rule');
    }
    rules.push(text);
  }
  return rules;
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

function parseAnomalyThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, 'invalid anomaly threshold');
  }
  const threshold = Math.floor(value);
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new HttpError(400, 'invalid anomaly threshold');
  }
  return threshold;
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

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
  userId?: string;
  deviceId?: string;
  uploadDelta?: number;
  downloadDelta?: number;
  reportedAt?: string;
  appVersion?: string;
};

type RemoteConfigInput = {
  enabled?: boolean;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({});

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
        requireAdmin(request, env);
        return listUsers(env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/config') {
        requireAdmin(request, env);
        return await getAdminConfig(env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/config') {
        requireAdmin(request, env);
        return await updateAdminConfig(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/config/sync-users') {
        requireAdmin(request, env);
        return await syncGlobalConfigToUsers(env);
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
        return adminPageV3();
      }
      const userTrafficMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/traffic$/);
      if (request.method === 'GET' && userTrafficMatch) {
        requireAdmin(request, env);
        return await getUserTraffic(env, userTrafficMatch[1]);
      }
      const userConfigMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config$/);
      if (userConfigMatch) {
        requireAdmin(request, env);
        if (request.method === 'GET') return await getAdminUserConfig(env, userConfigMatch[1]);
        if (request.method === 'POST') return await updateAdminUserConfig(request, env, userConfigMatch[1]);
      }
      const userConfigResetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/config\/reset$/);
      if (request.method === 'POST' && userConfigResetMatch) {
        requireAdmin(request, env);
        return await resetAdminUserConfig(env, userConfigResetMatch[1]);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/anomalies') {
        requireAdmin(request, env);
        return await listAnomalies(env);
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'internal error';
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: message }, status);
    }
  }
};

async function activate(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as ActivateInput;
  const name = String(input.name ?? '').trim();
  const normalizedName = normalizeName(name);
  const passphrase = String(input.passphrase ?? '').trim();
  const deviceSeed = String(input.deviceSeed ?? '').trim();
  const now = new Date().toISOString();

  if (!name) throw new HttpError(400, 'missing name');
  if (!deviceSeed) throw new HttpError(400, 'missing device');
  const expectedPassphrase = env.REGISTRATION_PASSPHRASE?.trim();
  if (!expectedPassphrase) {
    throw new HttpError(503, 'registration disabled');
  }
  if (passphrase !== expectedPassphrase) {
    throw new HttpError(403, 'invalid passphrase');
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (id, name, normalized_name, status, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), name, normalizedName, 'active', now)
    .run();

  const user = await env.DB.prepare('SELECT id, name FROM users WHERE normalized_name = ?')
    .bind(normalizedName)
    .first<{ id: string; name: string }>();
  if (!user) throw new HttpError(500, 'user registration failed');

  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, device_seed, device_name, platform, app_version, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_seed) DO UPDATE SET
       user_id = excluded.user_id,
       device_name = excluded.device_name,
       platform = excluded.platform,
       app_version = excluded.app_version,
       last_seen_at = excluded.last_seen_at`
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      deviceSeed,
      cleanOptional(input.deviceName),
      cleanOptional(input.platform),
      cleanOptional(input.appVersion),
      now,
      now
    )
    .run();

  const device = await env.DB.prepare('SELECT id FROM devices WHERE device_seed = ?')
    .bind(deviceSeed)
    .first<{ id: string }>();
  if (!device) throw new HttpError(500, 'device registration failed');

  return json({
    userId: user.id,
    deviceId: device.id,
    name: user.name
  });
}

async function getClientConfig(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId')?.trim() ?? '';
  const deviceId = url.searchParams.get('deviceId')?.trim() ?? '';
  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');

  await requireKnownDevice(env, userId, deviceId);
  return json({ config: await getEffectiveRemoteConfig(env, userId) });
}

async function getAdminConfig(env: Env): Promise<Response> {
  return json({ config: await getGlobalRemoteConfig(env) });
}

async function updateAdminConfig(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as RemoteConfigInput;
  const current = await getGlobalRemoteConfig(env);
  const next = normalizeRemoteConfigInput(input, current);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO remote_config
       (id, version, enabled, subscription_url, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       enabled = excluded.enabled,
       subscription_url = excluded.subscription_url,
       rule_profile = excluded.rule_profile,
       preferred_node = excluded.preferred_node,
       preferred_strategy = excluded.preferred_strategy,
       direct_rules = excluded.direct_rules,
       proxy_rules = excluded.proxy_rules,
       anomaly_threshold_bytes = excluded.anomaly_threshold_bytes,
       updated_at = excluded.updated_at`
  )
    .bind(
      current.version + 1,
      next.enabled ? 1 : 0,
      next.subscriptionUrl ?? null,
      next.ruleProfile ?? null,
      next.preferredNode ?? null,
      next.preferredStrategy ?? null,
      JSON.stringify(next.directRules),
      JSON.stringify(next.proxyRules),
      next.anomalyThresholdBytes,
      now
    )
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
  const input = (await request.json()) as RemoteConfigInput;
  const next = normalizeUserRemoteConfigInput(input);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO user_remote_config
       (user_id, enabled, subscription_url, rule_profile, preferred_node, preferred_strategy, direct_rules, proxy_rules, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       subscription_url = excluded.subscription_url,
       rule_profile = excluded.rule_profile,
       preferred_node = excluded.preferred_node,
       preferred_strategy = excluded.preferred_strategy,
       direct_rules = excluded.direct_rules,
       proxy_rules = excluded.proxy_rules,
       updated_at = excluded.updated_at`
  )
    .bind(
      userId,
      typeof next.enabled === 'boolean' ? (next.enabled ? 1 : 0) : null,
      next.subscriptionUrl ?? null,
      next.ruleProfile ?? null,
      next.preferredNode ?? null,
      next.preferredStrategy ?? null,
      next.directRules ? JSON.stringify(next.directRules) : null,
      next.proxyRules ? JSON.stringify(next.proxyRules) : null,
      now
    )
    .run();

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
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YouYu 后台</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f5f7; color: #1f2328; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; }
    main { max-width: 1180px; margin: 0 auto; display: grid; gap: 14px; }
    header, .panel-head, .toolbar, .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; line-height: 1.1; }
    h2 { font-size: 18px; line-height: 1.2; }
    .muted { color: #667085; }
    .panel, .auth { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgb(16 24 40 / 6%); }
    .auth { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 10px; }
    .config-panel { display: grid; gap: 14px; }
    .control-grid { display: grid; grid-template-columns: 120px 150px 150px minmax(240px, 1fr) 130px; gap: 10px; }
    .node-line { display: grid; grid-template-columns: 86px minmax(0, 1fr); align-items: center; gap: 10px; }
    .rules { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    label { min-width: 0; display: grid; gap: 6px; color: #344054; font-size: 13px; font-weight: 800; }
    .node-line > span { color: #344054; font-size: 13px; font-weight: 800; }
    input, select, button { border-radius: 8px; font: inherit; }
    input, select { width: 100%; height: 40px; border: 1px solid #d0d5dd; padding: 0 10px; background: #fff; color: #1f2328; }
    input::placeholder { color: #98a2b3; }
    button { height: 40px; border: 0; padding: 0 16px; background: #1f2328; color: #fff; font-weight: 900; cursor: pointer; }
    button.secondary { background: #eef1f4; color: #1f2328; }
    .chip { height: 30px; display: inline-flex; align-items: center; border-radius: 999px; padding: 0 10px; background: #eef1f4; color: #344054; font-size: 13px; font-weight: 800; }
    .rule-card { min-width: 0; display: grid; gap: 10px; border: 1px solid #edf0f2; border-radius: 8px; padding: 12px; background: #fcfcfd; }
    .rule-card h3 { margin: 0; color: #344054; font-size: 13px; line-height: 1.2; }
    .check-list { display: grid; gap: 8px; }
    .check-list label { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; color: #1f2328; font-weight: 700; cursor: pointer; }
    .check-list input { width: 16px; height: 16px; margin: 1px 0 0; flex: 0 0 auto; }
    .check-list span { display: grid; gap: 2px; }
    .check-list small { color: #667085; font-size: 12px; font-weight: 500; line-height: 1.35; }
    .preserved-rules { display: flex; flex-wrap: wrap; gap: 6px; min-height: 0; }
    .preserved-rules:empty { display: none; }
    .preserved-rules .chip { max-width: 100%; height: auto; min-height: 28px; overflow-wrap: anywhere; }
    .chip-remove { width: 20px; height: 20px; margin-left: 6px; padding: 0; border-radius: 999px; background: #d0d5dd; color: #1f2328; font-size: 12px; line-height: 20px; }
    td.actions-cell, th.actions-cell { text-align: right; }
    td.actions-cell .actions { justify-content: flex-end; gap: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 8px; border-bottom: 1px solid #edf0f2; text-align: left; white-space: nowrap; }
    th { color: #667085; font-size: 13px; }
    th.sortable { padding: 0; }
    th.sortable button { width: 100%; height: auto; min-height: 42px; padding: 11px 8px; border-radius: 0; background: transparent; color: #667085; text-align: inherit; font-size: 13px; font-weight: 900; }
    th.sortable button:hover { background: #f8fafc; color: #1f2328; }
    th.sortable button::after { content: '  ↕'; color: #98a2b3; font-weight: 700; }
    th.sortable[data-active="true"] button { color: #1f2328; }
    th.sortable[data-active="true"][data-direction="asc"] button::after { content: '  ↑'; color: #1f2328; }
    th.sortable[data-active="true"][data-direction="desc"] button::after { content: '  ↓'; color: #1f2328; }
    td.num, th.num { text-align: right; }
    .danger { color: #b42318; font-weight: 900; }
    .hidden { display: none; }
    @media (max-width: 860px) {
      body { padding: 14px; }
      header, .panel-head, .toolbar, .actions { align-items: start; flex-direction: column; }
      .auth, .control-grid, .node-line, .rules { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>YouYu 后台</h1><div class="muted" id="status">未加载</div></div>
      <button class="secondary" id="refresh">刷新</button>
    </header>
    <section class="auth">
      <input id="token" type="password" placeholder="管理 token" autocomplete="current-password" />
      <button id="login">进入</button>
    </section>
    <section class="panel config-panel">
      <div class="panel-head">
        <div><h2>远程配置</h2></div>
        <div class="actions"><span class="chip" id="globalVersion">v1</span><button class="secondary" id="syncGlobalUsers">同步所有用户</button><button id="saveGlobal">保存</button></div>
      </div>
      <div class="control-grid">
        <label>状态<select id="globalEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>规则<select id="globalRuleProfile"><option value="">不覆盖</option><option value="subscription">机场配置</option><option value="smart">智能规则</option><option value="global">全局代理</option></select></label>
        <label>策略<select id="globalStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
        <label>订阅<input id="globalSubscription" placeholder="留空不覆盖" /></label>
        <label>阈值 MB<input id="globalThreshold" type="number" min="1" step="1" /></label>
      </div>
      <div class="node-line"><span>启动选择</span><select id="globalNode"></select></div>
      <div class="rules">
        <div class="rule-card"><h3>直连规则</h3><div class="check-list" id="globalDirect"></div><div class="preserved-rules" id="globalDirectCustom"></div></div>
        <div class="rule-card"><h3>代理规则</h3><div class="check-list" id="globalProxy"></div><div class="preserved-rules" id="globalProxyCustom"></div></div>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar"><h2>用户</h2><span class="muted" id="userCount">0 个用户</span></div>
      <table><thead><tr><th class="sortable" data-sort="name"><button type="button">姓名</button></th><th class="num sortable" data-sort="devices"><button type="button">设备</button></th><th class="num sortable" data-sort="uploadBytes"><button type="button">上传</button></th><th class="num sortable" data-sort="downloadBytes"><button type="button">下载</button></th><th class="num sortable" data-sort="anomalies"><button type="button">异常</button></th><th class="sortable" data-sort="lastSeenAt"><button type="button">最后在线</button></th><th class="actions-cell"></th></tr></thead><tbody id="users"></tbody></table>
    </section>
    <section class="panel hidden" id="userConfigPanel">
      <div class="toolbar"><h2 id="userConfigTitle">用户配置</h2><div class="actions"><button class="secondary" id="resetUserConfig">重置</button><button id="saveUserConfig">保存</button></div></div>
      <div class="control-grid">
        <label>状态<select id="userEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>规则<select id="userRuleProfile"><option value="">不覆盖</option><option value="subscription">机场配置</option><option value="smart">智能规则</option><option value="global">全局代理</option></select></label>
        <label>策略<select id="userStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
        <label>订阅<input id="userSubscription" placeholder="留空跟随全局" /></label>
        <label>启动选择<select id="userNode"></select></label>
      </div>
      <div class="rules">
        <div class="rule-card"><h3>直连规则</h3><div class="check-list" id="userDirect"></div><div class="preserved-rules" id="userDirectCustom"></div></div>
        <div class="rule-card"><h3>代理规则</h3><div class="check-list" id="userProxy"></div><div class="preserved-rules" id="userProxyCustom"></div></div>
      </div>
    </section>
    <section class="panel hidden" id="detailPanel"><div class="toolbar"><h2 id="detailTitle">明细</h2><button class="secondary" id="closeDetail">收起</button></div><table><thead><tr><th>日期</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>更新时间</th></tr></thead><tbody id="details"></tbody></table></section>
    <section class="panel"><div class="toolbar"><h2>异常</h2><span class="muted" id="anomalyCount">0 条</span></div><table><thead><tr><th>用户</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>时间</th></tr></thead><tbody id="anomalies"></tbody></table></section>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const usersBody = document.getElementById('users');
    const detailsBody = document.getElementById('details');
    const anomaliesBody = document.getElementById('anomalies');
    const statusEl = document.getElementById('status');
    const userCountEl = document.getElementById('userCount');
    const anomalyCountEl = document.getElementById('anomalyCount');
    const detailPanel = document.getElementById('detailPanel');
    const detailTitle = document.getElementById('detailTitle');
    const userConfigPanel = document.getElementById('userConfigPanel');
    const userConfigTitle = document.getElementById('userConfigTitle');
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
    const userSort = { key: 'downloadBytes', direction: 'desc' };
    let loadedUsers = [];
    let activeUserId = '';
    let activeUserName = '';
    initConfigControls('global');
    initConfigControls('user');
    tokenInput.value = localStorage.getItem('youyu_admin_token') || '';
    document.getElementById('login').onclick = () => { localStorage.setItem('youyu_admin_token', tokenInput.value.trim()); loadAll(); };
    document.getElementById('refresh').onclick = loadAll;
    document.getElementById('closeDetail').onclick = () => detailPanel.classList.add('hidden');
    document.getElementById('saveGlobal').onclick = saveGlobalConfig;
    document.getElementById('syncGlobalUsers').onclick = syncGlobalUsers;
    document.getElementById('saveUserConfig').onclick = saveUserConfig;
    document.getElementById('resetUserConfig').onclick = resetUserConfig;
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
      const token = tokenInput.value.trim() || localStorage.getItem('youyu_admin_token') || '';
      const headers = Object.assign({ authorization: 'Bearer ' + token }, options && options.headers ? options.headers : {});
      const res = await fetch(path, Object.assign({}, options || {}, { headers }));
      if (!res.ok) throw new Error('请求失败');
      return res.json();
    }
    async function loadAll() {
      statusEl.textContent = '加载中';
      try { await Promise.all([loadGlobalConfig(), loadUsers(), loadAnomalies()]); statusEl.textContent = '已更新'; }
      catch { statusEl.textContent = '无法加载'; }
    }
    async function loadGlobalConfig() {
      const data = await api('/api/admin/config');
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
    }
    async function saveGlobalConfig() {
      const data = await api('/api/admin/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfigFields('global', true)) });
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
      statusEl.textContent = '已保存';
    }
    async function syncGlobalUsers() {
      if (!confirm('确认让所有用户跟随顶部远程配置？这会清除每个用户的单独配置覆盖。')) return;
      const data = await api('/api/admin/config/sync-users', { method: 'POST' });
      statusEl.textContent = '已同步所有用户，清除 ' + (data.clearedUsers || 0) + ' 个覆盖';
      if (activeUserId) {
        setConfigFields('user', data.config || {});
        userConfigTitle.textContent = activeUserName + ' 配置（跟随全局）';
      }
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
        const anomalyText = user.anomalies ? '<span class="danger">' + user.anomalies + '</span>' : '0';
        tr.innerHTML = '<td>' + escapeHtml(user.name || '') + '</td><td class="num">' + (user.devices || 0) + '</td><td class="num">' + formatBytes(user.uploadBytes || 0) + '</td><td class="num">' + formatBytes(user.downloadBytes || 0) + '</td><td class="num">' + anomalyText + '</td><td>' + formatTime(user.lastSeenAt) + '</td><td class="actions-cell"><div class="actions"><button class="secondary" data-action="detail" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || '') + '">明细</button><button data-action="config" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || '') + '">配置</button></div></td>';
        usersBody.appendChild(tr);
      }
      usersBody.querySelectorAll('button[data-action="detail"]').forEach((button) => { button.onclick = () => loadDetails(button.dataset.id, button.dataset.name); });
      usersBody.querySelectorAll('button[data-action="config"]').forEach((button) => { button.onclick = () => loadUserConfig(button.dataset.id, button.dataset.name); });
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
      if (key === 'lastSeenAt') return dateValue(a.lastSeenAt) - dateValue(b.lastSeenAt);
      return numberValue(a[key]) - numberValue(b[key]);
    }
    function numberValue(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
    function dateValue(value) { const time = value ? new Date(value).getTime() : 0; return Number.isFinite(time) ? time : 0; }
    async function loadUserConfig(userId, name) {
      activeUserId = userId; activeUserName = name;
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config');
      const hasOverride = Boolean(data.override);
      setConfigFields('user', hasOverride ? data.override : data.effective || {});
      userConfigTitle.textContent = name + (hasOverride ? ' 配置' : ' 配置（跟随全局）');
      userConfigPanel.classList.remove('hidden');
    }
    async function saveUserConfig() {
      if (!activeUserId) return;
      await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfigFields('user', false)) });
      statusEl.textContent = activeUserName + ' 已保存';
    }
    async function resetUserConfig() {
      if (!activeUserId) return;
      const data = await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config/reset', { method: 'POST' });
      setConfigFields('user', data.effective || {});
      userConfigTitle.textContent = activeUserName + ' 配置（跟随全局）';
      statusEl.textContent = activeUserName + ' 已重置为跟随全局';
    }
    async function loadDetails(userId, name) {
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic');
      detailTitle.textContent = name + ' 明细'; detailsBody.innerHTML = '';
      for (const row of data.rows || []) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.date || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num">' + formatBytes(row.downloadBytes || 0) + '</td><td>' + formatTime(row.updatedAt) + '</td>';
        detailsBody.appendChild(tr);
      }
      detailPanel.classList.remove('hidden');
    }
    async function loadAnomalies() {
      const data = await api('/api/admin/anomalies');
      anomaliesBody.innerHTML = '';
      for (const row of data.anomalies || []) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.userName || row.userId || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num danger">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num danger">' + formatBytes(row.downloadBytes || 0) + '</td><td>' + formatTime(row.createdAt) + '</td>';
        anomaliesBody.appendChild(tr);
      }
      anomalyCountEl.textContent = (data.anomalies || []).length + ' 条';
    }
    function setConfigFields(prefix, config) {
      document.getElementById(prefix + 'Enabled').value = config.enabled === false ? 'false' : 'true';
      document.getElementById(prefix + 'RuleProfile').value = config.ruleProfile || '';
      document.getElementById(prefix + 'Strategy').value = config.preferredStrategy || '';
      document.getElementById(prefix + 'Subscription').value = config.subscriptionUrl || '';
      setNodeChoice(prefix, config.preferredNode || '');
      setRuleChoices(prefix, 'direct', config.directRules || []);
      setRuleChoices(prefix, 'proxy', config.proxyRules || []);
      if (prefix === 'global') document.getElementById('globalThreshold').value = Math.round((config.anomalyThresholdBytes || 1073741824) / 1024 / 1024);
    }
    function readConfigFields(prefix, includeThreshold) {
      const nodeChoice = document.getElementById(prefix + 'Node').value;
      const value = { enabled: document.getElementById(prefix + 'Enabled').value === 'true', subscriptionUrl: document.getElementById(prefix + 'Subscription').value.trim() || null, ruleProfile: document.getElementById(prefix + 'RuleProfile').value || null, preferredStrategy: document.getElementById(prefix + 'Strategy').value || null, preferredNode: nodeChoice === '__default__' ? null : nodeChoice || null, directRules: readRuleChoices(prefix, 'direct'), proxyRules: readRuleChoices(prefix, 'proxy') };
      if (includeThreshold) value.anomalyThresholdBytes = Math.max(1, Number(document.getElementById('globalThreshold').value || 1024)) * 1024 * 1024;
      return value;
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
    function normalizeRuleText(rule) { return String(rule || '').split(',').map((part) => part.trim()).filter(Boolean).join(','); }
    function dedupeRules(rules) { return [...new Set(rules.map(normalizeRuleText).filter(Boolean))]; }
    function formatBytes(bytes) { if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'; return (bytes / 1073741824).toFixed(2) + ' GB'; }
    function formatTime(value) { if (!value) return '-'; return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  </script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function adminPageV2(): Response {
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YouYu 后台</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f4f1; color: #202124; }
    body { margin: 0; padding: 28px; }
    main { max-width: 1180px; margin: 0 auto; display: grid; gap: 16px; }
    header, .toolbar, .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    .panel, .auth { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgb(0 0 0 / 6%); }
    .auth { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .rules { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; color: #5f5a52; }
    input, select, textarea, button { border-radius: 8px; font: inherit; }
    input, select { height: 40px; border: 1px solid #d8d3ca; padding: 0 10px; background: #fff; }
    textarea { min-height: 88px; resize: vertical; border: 1px solid #d8d3ca; padding: 10px; line-height: 1.4; }
    button { height: 40px; border: 0; padding: 0 14px; background: #202124; color: #fff; font-weight: 800; cursor: pointer; }
    button.secondary { background: #ece8df; color: #202124; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 8px; border-bottom: 1px solid #eee9df; text-align: left; white-space: nowrap; }
    th { color: #6b665e; font-size: 13px; }
    td.num, th.num { text-align: right; }
    .muted { color: #777168; }
    .danger { color: #b42318; font-weight: 800; }
    .hidden { display: none; }
    @media (max-width: 820px) {
      body { padding: 16px; }
      header, .toolbar, .row { align-items: start; flex-direction: column; }
      .auth, .grid, .rules { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header><div><h1>YouYu 后台</h1><div class="muted" id="status">未加载</div></div><button class="secondary" id="refresh">刷新</button></header>
    <section class="auth"><input id="token" type="password" placeholder="管理 token" autocomplete="current-password" /><button id="login">进入</button></section>
    <section class="panel">
      <div class="toolbar"><h2>远程配置</h2><button id="saveGlobal">保存</button></div>
      <div class="grid">
        <label>启用<select id="globalEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>规则<select id="globalRuleProfile"><option value="">不覆盖</option><option value="subscription">机场配置</option><option value="smart">智能规则</option><option value="global">全局代理</option></select></label>
        <label>策略<select id="globalStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
        <label>阈值 MB<input id="globalThreshold" type="number" min="1" step="1" /></label>
      </div>
      <div class="rules"><label>直连规则<textarea id="globalDirect"></textarea></label><label>代理规则<textarea id="globalProxy"></textarea></label></div>
      <div class="row" style="margin-top:10px"><label style="flex:1">节点<input id="globalNode" placeholder="留空不覆盖" /></label><span class="muted" id="globalVersion"></span></div>
    </section>
    <section class="panel">
      <div class="toolbar"><h2>用户</h2><span class="muted" id="userCount">0 个用户</span></div>
      <table><thead><tr><th>姓名</th><th class="num">设备</th><th class="num">上传</th><th class="num">下载</th><th class="num">异常</th><th>最后在线</th><th></th></tr></thead><tbody id="users"></tbody></table>
    </section>
    <section class="panel hidden" id="userConfigPanel">
      <div class="toolbar"><h2 id="userConfigTitle">用户配置</h2><div class="row"><button class="secondary" id="resetUserConfig">重置</button><button id="saveUserConfig">保存</button></div></div>
      <div class="grid">
        <label>启用<select id="userEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
        <label>规则<select id="userRuleProfile"><option value="">不覆盖</option><option value="subscription">机场配置</option><option value="smart">智能规则</option><option value="global">全局代理</option></select></label>
        <label>策略<select id="userStrategy"><option value="">不覆盖</option><option value="auto">自动</option><option value="fallback">故障</option><option value="load-balance">均衡</option><option value="direct">直连</option></select></label>
        <label>节点<input id="userNode" placeholder="留空不覆盖" /></label>
      </div>
      <div class="rules"><label>直连规则<textarea id="userDirect"></textarea></label><label>代理规则<textarea id="userProxy"></textarea></label></div>
    </section>
    <section class="panel hidden" id="detailPanel"><div class="toolbar"><h2 id="detailTitle">明细</h2><button class="secondary" id="closeDetail">收起</button></div><table><thead><tr><th>日期</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>更新时间</th></tr></thead><tbody id="details"></tbody></table></section>
    <section class="panel"><div class="toolbar"><h2>异常</h2><span class="muted" id="anomalyCount">0 条</span></div><table><thead><tr><th>用户</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>时间</th></tr></thead><tbody id="anomalies"></tbody></table></section>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const usersBody = document.getElementById('users');
    const detailsBody = document.getElementById('details');
    const anomaliesBody = document.getElementById('anomalies');
    const statusEl = document.getElementById('status');
    const userCountEl = document.getElementById('userCount');
    const anomalyCountEl = document.getElementById('anomalyCount');
    const detailPanel = document.getElementById('detailPanel');
    const detailTitle = document.getElementById('detailTitle');
    const userConfigPanel = document.getElementById('userConfigPanel');
    const userConfigTitle = document.getElementById('userConfigTitle');
    let activeUserId = '';
    let activeUserName = '';
    tokenInput.value = localStorage.getItem('youyu_admin_token') || '';
    document.getElementById('login').onclick = () => { localStorage.setItem('youyu_admin_token', tokenInput.value.trim()); loadAll(); };
    document.getElementById('refresh').onclick = loadAll;
    document.getElementById('closeDetail').onclick = () => detailPanel.classList.add('hidden');
    document.getElementById('saveGlobal').onclick = saveGlobalConfig;
    document.getElementById('saveUserConfig').onclick = saveUserConfig;
    document.getElementById('resetUserConfig').onclick = resetUserConfig;
    async function api(path, options) {
      const token = tokenInput.value.trim() || localStorage.getItem('youyu_admin_token') || '';
      const headers = Object.assign({ authorization: 'Bearer ' + token }, options && options.headers ? options.headers : {});
      const res = await fetch(path, Object.assign({}, options || {}, { headers }));
      if (!res.ok) throw new Error('请求失败');
      return res.json();
    }
    async function loadAll() {
      statusEl.textContent = '加载中';
      try { await Promise.all([loadGlobalConfig(), loadUsers(), loadAnomalies()]); statusEl.textContent = '已更新'; }
      catch { statusEl.textContent = '无法加载'; }
    }
    async function loadGlobalConfig() {
      const data = await api('/api/admin/config');
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
    }
    async function saveGlobalConfig() {
      const data = await api('/api/admin/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfigFields('global', true)) });
      setConfigFields('global', data.config || {});
      document.getElementById('globalVersion').textContent = 'v' + ((data.config && data.config.version) || 1);
      statusEl.textContent = '已保存';
    }
    async function loadUsers() {
      const data = await api('/api/admin/users');
      usersBody.innerHTML = '';
      for (const user of data.users || []) {
        const tr = document.createElement('tr');
        const anomalyText = user.anomalies ? '<span class="danger">' + user.anomalies + '</span>' : '0';
        tr.innerHTML = '<td>' + escapeHtml(user.name || '') + '</td><td class="num">' + (user.devices || 0) + '</td><td class="num">' + formatBytes(user.uploadBytes || 0) + '</td><td class="num">' + formatBytes(user.downloadBytes || 0) + '</td><td class="num">' + anomalyText + '</td><td>' + formatTime(user.lastSeenAt) + '</td><td><button class="secondary" data-action="detail" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || '') + '">明细</button> <button data-action="config" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || '') + '">配置</button></td>';
        usersBody.appendChild(tr);
      }
      usersBody.querySelectorAll('button[data-action="detail"]').forEach((button) => { button.onclick = () => loadDetails(button.dataset.id, button.dataset.name); });
      usersBody.querySelectorAll('button[data-action="config"]').forEach((button) => { button.onclick = () => loadUserConfig(button.dataset.id, button.dataset.name); });
      userCountEl.textContent = (data.users || []).length + ' 个用户';
    }
    async function loadUserConfig(userId, name) {
      activeUserId = userId; activeUserName = name;
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config');
      setConfigFields('user', data.override || {});
      userConfigTitle.textContent = name + ' 配置';
      userConfigPanel.classList.remove('hidden');
    }
    async function saveUserConfig() {
      if (!activeUserId) return;
      await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readConfigFields('user', false)) });
      statusEl.textContent = activeUserName + ' 已保存';
    }
    async function resetUserConfig() {
      if (!activeUserId) return;
      await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/config/reset', { method: 'POST' });
      setConfigFields('user', {});
      statusEl.textContent = activeUserName + ' 已重置';
    }
    async function loadDetails(userId, name) {
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic');
      detailTitle.textContent = name + ' 明细'; detailsBody.innerHTML = '';
      for (const row of data.rows || []) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.date || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num">' + formatBytes(row.downloadBytes || 0) + '</td><td>' + formatTime(row.updatedAt) + '</td>';
        detailsBody.appendChild(tr);
      }
      detailPanel.classList.remove('hidden');
    }
    async function loadAnomalies() {
      const data = await api('/api/admin/anomalies');
      anomaliesBody.innerHTML = '';
      for (const row of data.anomalies || []) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.userName || row.userId || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num danger">' + formatBytes(row.uploadBytes || 0) + '</td><td class="num danger">' + formatBytes(row.downloadBytes || 0) + '</td><td>' + formatTime(row.createdAt) + '</td>';
        anomaliesBody.appendChild(tr);
      }
      anomalyCountEl.textContent = (data.anomalies || []).length + ' 条';
    }
    function setConfigFields(prefix, config) {
      document.getElementById(prefix + 'Enabled').value = config.enabled === false ? 'false' : 'true';
      document.getElementById(prefix + 'RuleProfile').value = config.ruleProfile || '';
      document.getElementById(prefix + 'Strategy').value = config.preferredStrategy || '';
      document.getElementById(prefix + 'Node').value = config.preferredNode || '';
      document.getElementById(prefix + 'Direct').value = (config.directRules || []).join('\\n');
      document.getElementById(prefix + 'Proxy').value = (config.proxyRules || []).join('\\n');
      if (prefix === 'global') document.getElementById('globalThreshold').value = Math.round((config.anomalyThresholdBytes || 1073741824) / 1024 / 1024);
    }
    function readConfigFields(prefix, includeThreshold) {
      const value = { enabled: document.getElementById(prefix + 'Enabled').value === 'true', ruleProfile: document.getElementById(prefix + 'RuleProfile').value || null, preferredStrategy: document.getElementById(prefix + 'Strategy').value || null, preferredNode: document.getElementById(prefix + 'Node').value.trim() || null, directRules: splitRules(document.getElementById(prefix + 'Direct').value), proxyRules: splitRules(document.getElementById(prefix + 'Proxy').value) };
      if (includeThreshold) value.anomalyThresholdBytes = Math.max(1, Number(document.getElementById('globalThreshold').value || 1024)) * 1024 * 1024;
      return value;
    }
    function splitRules(value) { return String(value).split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean); }
    function formatBytes(bytes) { if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'; return (bytes / 1073741824).toFixed(2) + ' GB'; }
    function formatTime(value) { if (!value) return '-'; return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  </script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function adminPage(): Response {
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YouYu 用量</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f4f1;
      color: #202124;
    }
    body {
      margin: 0;
      padding: 32px;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 {
      font-size: 28px;
    }
    h2 {
      font-size: 18px;
    }
    .auth, .panel {
      background: #fff;
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 1px 3px rgb(0 0 0 / 6%);
    }
    .auth {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 96px;
      gap: 10px;
    }
    input, button {
      height: 42px;
      border-radius: 8px;
      font: inherit;
    }
    input {
      border: 1px solid #d8d3ca;
      padding: 0 12px;
    }
    button {
      border: 0;
      background: #202124;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      background: #ece8df;
      color: #202124;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px 8px;
      border-bottom: 1px solid #eee9df;
      text-align: left;
      white-space: nowrap;
    }
    th {
      color: #6b665e;
      font-size: 13px;
    }
    td.num, th.num {
      text-align: right;
    }
    .muted {
      color: #777168;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .hidden {
      display: none;
    }
    @media (max-width: 760px) {
      body {
        padding: 18px;
      }
      header, .toolbar {
        align-items: start;
        flex-direction: column;
      }
      .auth {
        grid-template-columns: 1fr;
      }
      table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>YouYu 用量</h1>
        <div class="muted">用户和设备流量</div>
      </div>
      <button class="secondary" id="refresh">刷新</button>
    </header>

    <section class="auth">
      <input id="token" type="password" placeholder="管理 token" autocomplete="current-password" />
      <button id="login">进入</button>
    </section>

    <section class="panel">
      <div class="toolbar">
        <h2>用户</h2>
        <span class="muted" id="status">未加载</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>姓名</th>
            <th class="num">设备</th>
            <th class="num">上传</th>
            <th class="num">下载</th>
            <th>最后在线</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="users"></tbody>
      </table>
    </section>

    <section class="panel hidden" id="detailPanel">
      <div class="toolbar">
        <h2 id="detailTitle">明细</h2>
        <button class="secondary" id="closeDetail">收起</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>设备</th>
            <th class="num">上传</th>
            <th class="num">下载</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody id="details"></tbody>
      </table>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const usersBody = document.getElementById('users');
    const detailsBody = document.getElementById('details');
    const statusEl = document.getElementById('status');
    const detailPanel = document.getElementById('detailPanel');
    const detailTitle = document.getElementById('detailTitle');
    tokenInput.value = localStorage.getItem('youyu_admin_token') || '';

    document.getElementById('login').onclick = () => {
      localStorage.setItem('youyu_admin_token', tokenInput.value.trim());
      loadUsers();
    };
    document.getElementById('refresh').onclick = loadUsers;
    document.getElementById('closeDetail').onclick = () => detailPanel.classList.add('hidden');

    async function api(path) {
      const token = tokenInput.value.trim() || localStorage.getItem('youyu_admin_token') || '';
      const res = await fetch(path, { headers: { authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('请求失败');
      return res.json();
    }

    async function loadUsers() {
      statusEl.textContent = '加载中';
      try {
        const data = await api('/api/admin/users');
        usersBody.innerHTML = '';
        for (const user of data.users || []) {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + escapeHtml(user.name || '') + '</td>' +
            '<td class="num">' + (user.devices || 0) + '</td>' +
            '<td class="num">' + formatBytes(user.uploadBytes || 0) + '</td>' +
            '<td class="num">' + formatBytes(user.downloadBytes || 0) + '</td>' +
            '<td>' + formatTime(user.lastSeenAt) + '</td>' +
            '<td><button class="secondary" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || '') + '">明细</button></td>';
          usersBody.appendChild(tr);
        }
        usersBody.querySelectorAll('button[data-id]').forEach((button) => {
          button.onclick = () => loadDetails(button.dataset.id, button.dataset.name);
        });
        statusEl.textContent = (data.users || []).length + ' 个用户';
      } catch {
        statusEl.textContent = '无法加载';
      }
    }

    async function loadDetails(userId, name) {
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic');
      detailTitle.textContent = name + ' 明细';
      detailsBody.innerHTML = '';
      for (const row of data.rows || []) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(row.date || '') + '</td>' +
          '<td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td>' +
          '<td class="num">' + formatBytes(row.uploadBytes || 0) + '</td>' +
          '<td class="num">' + formatBytes(row.downloadBytes || 0) + '</td>' +
          '<td>' + formatTime(row.updatedAt) + '</td>';
        detailsBody.appendChild(tr);
      }
      detailPanel.classList.remove('hidden');
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function formatTime(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('zh-CN', { hour12: false });
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }
  </script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

async function reportTraffic(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as TrafficReportInput;
  const userId = String(input.userId ?? '').trim();
  const deviceId = String(input.deviceId ?? '').trim();
  const upload = normalizeBytes(input.uploadDelta);
  const download = normalizeBytes(input.downloadDelta);
  const now = new Date().toISOString();
  const date = now.slice(0, 10);

  if (!userId || !deviceId) throw new HttpError(400, 'missing identity');
  if (upload === 0 && download === 0) return json({ ok: true });

  await requireKnownDevice(env, userId, deviceId);

  const config = await getEffectiveRemoteConfig(env, userId);
  const anomaly = upload >= config.anomalyThresholdBytes || download >= config.anomalyThresholdBytes;
  const writes = [
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

  await env.DB.batch(writes);

  return json({ ok: true, anomaly });
}

async function listUsers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
       users.id,
       users.name,
       users.status,
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
    subscriptionUrl: cleanOptional(row.subscription_url) ?? undefined,
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
    subscriptionUrl: cleanOptional(row.subscription_url) ?? undefined,
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

function normalizeRemoteConfigInput(
  input: RemoteConfigInput,
  fallback: RemoteControlConfig
): RemoteControlConfig {
  const ruleProfile = normalizeChoice(input.ruleProfile, ['smart', 'global', 'subscription']) ?? fallback.ruleProfile;
  const preferredStrategy =
    normalizeChoice(input.preferredStrategy, ['manual', 'auto', 'fallback', 'load-balance', 'direct']) ??
    fallback.preferredStrategy;
  const threshold =
    typeof input.anomalyThresholdBytes === 'number' &&
    Number.isFinite(input.anomalyThresholdBytes) &&
    input.anomalyThresholdBytes > 0
      ? Math.floor(input.anomalyThresholdBytes)
      : fallback.anomalyThresholdBytes;

  return {
    version: fallback.version,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback.enabled,
    subscriptionUrl: normalizeSubscriptionUrl(input.subscriptionUrl) ?? undefined,
    ruleProfile,
    preferredNode: normalizeText(input.preferredNode, 120) ?? undefined,
    preferredStrategy,
    directRules: parseRuleList(input.directRules),
    proxyRules: parseRuleList(input.proxyRules),
    anomalyThresholdBytes: threshold,
    updatedAt: fallback.updatedAt
  };
}

function normalizeUserRemoteConfigInput(input: RemoteConfigInput): Partial<RemoteControlConfig> {
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
    subscriptionUrl:
      input.subscriptionUrl === null || typeof input.subscriptionUrl === 'undefined'
        ? undefined
        : normalizeSubscriptionUrl(input.subscriptionUrl),
    ruleProfile: normalizeChoice(input.ruleProfile, ['smart', 'global', 'subscription']),
    preferredNode: normalizeText(input.preferredNode, 120) ?? undefined,
    preferredStrategy: normalizeChoice(input.preferredStrategy, ['manual', 'auto', 'fallback', 'load-balance', 'direct']),
    directRules: input.directRules === null || typeof input.directRules === 'undefined' ? undefined : parseRuleList(input.directRules),
    proxyRules: input.proxyRules === null || typeof input.proxyRules === 'undefined' ? undefined : parseRuleList(input.proxyRules)
  };
}

async function requireKnownUser(env: Env, userId: string): Promise<void> {
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
  if (!user) throw new HttpError(404, 'unknown user');
}

async function requireKnownDevice(env: Env, userId: string, deviceId: string): Promise<void> {
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
    .bind(deviceId, userId)
    .first<{ id: string }>();
  if (!device) throw new HttpError(403, 'unknown device');
}

function requireAdmin(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN) throw new HttpError(403, 'admin disabled');
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (token !== env.ADMIN_TOKEN) throw new HttpError(403, 'forbidden');
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization'
    }
  });
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

  return raw
    .map((item) => normalizeText(item, 160))
    .filter((item): item is string => Boolean(item));
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function normalizeSubscriptionUrl(value: unknown): string | undefined {
  const text = normalizeText(value, 2048);
  if (!text) return undefined;

  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeChoice(value: unknown, choices: string[]): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return choices.includes(text) ? text : undefined;
}

function cleanOptional(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

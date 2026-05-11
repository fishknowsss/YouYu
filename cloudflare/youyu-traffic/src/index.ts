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
      if (request.method === 'GET' && url.pathname === '/api/admin/users') {
        requireAdmin(request, env);
        return listUsers(env);
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
        return adminPage();
      }
      const userTrafficMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/traffic$/);
      if (request.method === 'GET' && userTrafficMatch) {
        requireAdmin(request, env);
        return await getUserTraffic(env, userTrafficMatch[1]);
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
  const expectedPassphrase = env.REGISTRATION_PASSPHRASE || 'yaoyaoba118';
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

  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?')
    .bind(deviceId, userId)
    .first<{ id: string }>();
  if (!device) throw new HttpError(403, 'unknown device');

  await env.DB.batch([
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
  ]);

  return json({ ok: true });
}

async function listUsers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
       users.id,
       users.name,
       users.status,
       COUNT(DISTINCT devices.id) AS devices,
       COALESCE(SUM(traffic_daily.upload_bytes), 0) AS uploadBytes,
       COALESCE(SUM(traffic_daily.download_bytes), 0) AS downloadBytes,
       MAX(devices.last_seen_at) AS lastSeenAt
     FROM users
     LEFT JOIN devices ON devices.user_id = users.id
     LEFT JOIN traffic_daily ON traffic_daily.user_id = users.id
     GROUP BY users.id
     ORDER BY lastSeenAt DESC`
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

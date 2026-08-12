import { YOUYU_ICON_DATA_URI } from './adminAssets';

function icon(name: string, className = ''): string {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function metricCard(tone: string, iconName: string, label: string, stat: string, note = ''): string {
  return `<article class="metric-card ${tone}">
    <span class="metric-icon">${icon(iconName)}</span>
    <div class="metric-copy">
      <span class="metric-label" title="${label}">${label}</span>
      <strong class="metric-value" data-stat="${stat}">—</strong>
      ${note ? `<span class="metric-note">${note}</span>` : ''}
    </div>
  </article>`;
}

function userDeviceMetricCard(): string {
  return `<article class="metric-card purple metric-card-pair">
    <span class="metric-icon">${icon('users')}</span>
    <dl class="metric-pair">
      <div><dt>用户</dt><dd data-stat="users">—</dd></div>
      <div><dt>设备</dt><dd data-stat="devices">—</dd></div>
    </dl>
  </article>`;
}

function dashboardMetrics(): string {
  return `<div class="metric-grid">
    ${metricCard('purple', 'clock', '今日上报', 'todayReported')}
    ${userDeviceMetricCard()}
    ${metricCard('cyan', 'upload', '累计上传', 'upload')}
    ${metricCard('sky', 'download', '累计下载', 'download')}
    ${metricCard('coral', 'warning', '累计异常', 'anomalies')}
  </div>`;
}

function quotaDonut(): string {
  return `<div class="donut-wrap">
    <div class="donut" data-quota-donut style="--ring:0">
      <div class="donut-content">
        <span>使用率</span>
        <strong data-quota-percent>0%</strong>
        <small data-quota-limit>648 GB</small>
      </div>
    </div>
  </div>`;
}

export function adminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#07163a" />
  <link rel="icon" type="image/png" href="${YOUYU_ICON_DATA_URI}" />
  <link rel="stylesheet" href="/admin/assets/app.css" />
  <title>YouYu 后台</title>
</head>
<body>
  <svg class="visually-hidden" aria-hidden="true">
    <symbol id="icon-overview" viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" /></symbol>
    <symbol id="icon-users" viewBox="0 0 24 24"><path d="M16 20v-1.7a4.3 4.3 0 0 0-4.3-4.3H6.3A4.3 4.3 0 0 0 2 18.3V20M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm9-1a3 3 0 1 0 0-6m4 17v-1.7a4.3 4.3 0 0 0-3.2-4.2" /></symbol>
    <symbol id="icon-config" viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.06 15a1.7 1.7 0 0 0-1.56-1H2.4V10h.1A1.7 1.7 0 0 0 4 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 4.2l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1-1.56V2.4h4.04v.09A1.7 1.7 0 0 0 14.5 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19 8.4a1.7 1.7 0 0 0 1.56 1h.09v4.04h-.09A1.7 1.7 0 0 0 19.4 15Z" /></symbol>
    <symbol id="icon-warning" viewBox="0 0 24 24"><path d="m10.3 3.7-8 14A2 2 0 0 0 4 20.7h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01" /></symbol>
    <symbol id="icon-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" /></symbol>
    <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></symbol>
    <symbol id="icon-devices" viewBox="0 0 24 24"><rect x="2.5" y="4" width="13" height="10" rx="2" /><path d="M7 18h4m-2-4v4m8-8h4.5v10H17z" /></symbol>
    <symbol id="icon-upload" viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M5 13a5 5 0 0 0 1 9h12a5 5 0 0 0 1-9" /></symbol>
    <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3v13m-5-5 5 5 5-5M5 15a5 5 0 0 0 1 7h12a5 5 0 0 0 1-7" /></symbol>
    <symbol id="icon-chart" viewBox="0 0 24 24"><path d="M4 20V10m5 10V4m5 16v-7m5 7V7M2 20h20" /></symbol>
    <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></symbol>
    <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></symbol>
    <symbol id="icon-chevron-left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></symbol>
    <symbol id="icon-chevron-right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></symbol>
    <symbol id="icon-close" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></symbol>
    <symbol id="icon-save" viewBox="0 0 24 24"><path d="M5 3h12l3 3v15H4V3h1Zm3 0v6h8V3M8 21v-7h8v7" /></symbol>
    <symbol id="icon-reset" viewBox="0 0 24 24"><path d="M4 10a8 8 0 1 1 2.3 7.7M4 4v6h6" /></symbol>
    <symbol id="icon-merge" viewBox="0 0 24 24"><path d="M6 3v4a5 5 0 0 0 5 5h7m-5-5 5 5-5 5M6 21v-4a5 5 0 0 1 5-5" /></symbol>
    <symbol id="icon-edit" viewBox="0 0 24 24"><path d="M13.5 6.5 17.5 10.5M4 20l1-5L16 4a2.1 2.1 0 0 1 3 3L8 18l-4 2Z" /></symbol>
    <symbol id="icon-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></symbol>
  </svg>

  <div class="app-shell" id="adminShell" aria-busy="false">
    <aside class="sidebar" aria-label="后台导航">
      <div class="brand">
        <img src="${YOUYU_ICON_DATA_URI}" alt="" aria-hidden="true" />
        <span class="brand-copy"><strong>YouYu 后台</strong></span>
      </div>
      <nav class="primary-nav">
        <button class="nav-item is-active" type="button" data-view="overview" aria-label="概览">${icon('overview')}<span>概览</span></button>
        <button class="nav-item" type="button" data-view="users" aria-label="用户管理">${icon('users')}<span>用户</span></button>
        <button class="nav-item" type="button" data-view="config" aria-label="配置管理">${icon('config')}<span>配置</span></button>
        <button class="nav-item" type="button" data-view="anomalies" aria-label="异常记录">${icon('warning')}<span>异常</span></button>
      </nav>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div class="page-heading">
          <h1 id="pageTitle">概览</h1>
          <p class="status-text" id="status" role="status" aria-live="polite">请输入管理令牌</p>
        </div>
        <div class="top-actions">
          <button class="button secondary" id="changeToken" type="button" aria-label="管理令牌" aria-controls="authPanel" aria-expanded="true">${icon('key', 'icon-sm')}<span>管理令牌</span></button>
          <button class="button secondary" id="refresh" type="button" aria-label="刷新数据" disabled>${icon('refresh', 'icon-sm')}<span>刷新数据</span></button>
          <form class="auth-panel" id="authPanel">
            <label class="visually-hidden" for="token">管理令牌</label>
            <input id="token" type="password" placeholder="管理令牌" autocomplete="current-password" required />
            <button class="button" id="login" type="submit">进入</button>
          </form>
        </div>
      </header>

      <div class="admin-workspace" id="adminWorkspace" hidden>
        <section class="view-panel" id="viewOverview" data-view-panel="overview">
          ${dashboardMetrics()}
          <div class="section-switcher" data-section-switcher="overview" role="tablist" aria-label="概览内容">
            <button type="button" role="tab" aria-selected="false" data-overview-section="trend">趋势</button>
            <button class="is-active" type="button" role="tab" aria-selected="true" data-overview-section="users">用户</button>
            <button type="button" role="tab" aria-selected="false" data-overview-section="quota">额度</button>
            <button type="button" role="tab" aria-selected="false" data-overview-section="ranking">排行</button>
            <button type="button" role="tab" aria-selected="false" data-overview-section="anomalies">异常</button>
          </div>
          <div class="overview-grid">
            <article class="panel accent-purple overview-trend" data-overview-pane="trend">
              <div class="panel-head">
                <div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">流量趋势</h2></div></div>
                <div class="trend-range" role="tablist" aria-label="趋势时间范围">
                  <button type="button" role="tab" aria-selected="false" data-trend-range="hour">分时</button>
                  <button class="is-active" type="button" role="tab" aria-selected="true" data-trend-range="day">日</button>
                  <button type="button" role="tab" aria-selected="false" data-trend-range="month">月</button>
                </div>
              </div>
              <div class="trend-body">
                <div class="trend-legend" aria-hidden="true"><span class="upload">上传</span><span class="download">下载</span></div>
                <div class="trend-chart-wrap" id="trafficTrendPlot" tabindex="0">
                  <svg id="trafficTrendChart" role="img" aria-labelledby="trafficTrendTitle trafficTrendDescription"></svg>
                  <div class="trend-tooltip" id="trafficTrendTooltip" hidden></div>
                </div>
                <p class="visually-hidden" id="trafficTrendTitle">流量趋势</p>
                <p class="visually-hidden" id="trafficTrendDescription">最近三十日上传和下载流量</p>
              </div>
            </article>

            <article class="panel accent-purple overview-users" data-overview-pane="users">
              <div class="panel-head">
                <div class="panel-heading">${icon('users')}<div><h2 class="panel-title">最近上报用户</h2></div></div>
                <button class="button ghost" type="button" data-go-users aria-label="查看全部用户">${icon('chevron-right', 'icon-sm')}</button>
              </div>
              <div class="table-wrap overview-users-table-wrap">
                <table class="compact-table overview-users-table">
                  <colgroup><col class="recent-name" /><col class="recent-devices" /><col class="recent-upload" /><col class="recent-download" /><col class="recent-total" /><col class="recent-anomalies" /><col class="recent-seen" /></colgroup>
                  <thead><tr><th>姓名</th><th class="num recent-devices">设备</th><th class="num">上传</th><th class="num">下载</th><th class="num recent-total">总量</th><th class="num">异常</th><th class="recent-seen">最近上报</th></tr></thead>
                  <tbody id="recentUsers"></tbody>
                </table>
              </div>
            </article>

            <article class="panel accent-purple overview-quota" data-overview-pane="quota">
              <div class="panel-head">
                <div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">本期流量</h2></div></div>
                <button class="button ghost" type="button" data-go-config aria-label="编辑流量设置">${icon('edit', 'icon-sm')}</button>
              </div>
              <div class="panel-body quota-layout overview-quota-layout">
                ${quotaDonut()}
                <div class="quota-legend">
                  <div class="quota-line"><span class="quota-dot"></span><span>已用流量</span><strong data-quota-used>—</strong></div>
                  <div class="quota-line"><span class="quota-dot muted"></span><span>剩余流量</span><strong data-quota-balance>—</strong></div>
                  <div class="quota-line"><span class="quota-dot limit"></span><span>套餐额度</span><strong data-quota-limit-value>648 GB</strong></div>
                  <div class="quota-line quota-start"><span class="quota-dot period"></span><span>开始时间</span><strong data-quota-start>—</strong></div>
                  <div class="quota-line quota-expiry"><span class="quota-dot expiry"></span><span>到期时间</span><strong data-quota-expiry>—</strong></div>
                </div>
              </div>
            </article>

            <article class="panel accent-purple overview-ranking" data-overview-pane="ranking">
              <div class="panel-head">
                <div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">流量排行</h2></div></div>
              </div>
              <div class="panel-body"><div class="ranking-list" id="trafficRanking"></div></div>
            </article>

            <article class="panel accent-red overview-anomalies" data-overview-pane="anomalies">
              <div class="panel-head">
                <div class="panel-heading">${icon('warning')}<div><h2 class="panel-title">异常记录</h2></div></div>
                <button class="button ghost" type="button" data-go-anomalies aria-label="查看全部异常">${icon('chevron-right', 'icon-sm')}</button>
              </div>
              <div class="table-wrap">
                <table class="compact-table"><colgroup><col style="width:23%" /><col style="width:28%" /><col style="width:18%" /><col style="width:31%" /></colgroup>
                  <thead><tr><th>用户</th><th>设备</th><th class="num">总量</th><th>记录时间</th></tr></thead>
                  <tbody id="recentAnomalies"></tbody>
                </table>
              </div>
            </article>
          </div>
        </section>

        <section class="view-panel" id="viewUsers" data-view-panel="users" hidden>
          ${dashboardMetrics()}
          <div class="users-workbench">
            <article class="panel user-list-panel">
              <div class="panel-head">
                <div class="panel-heading">${icon('users')}<div><h2 class="panel-title">用户列表</h2></div></div>
                <span class="count-text" id="userCount" hidden>0 个用户</span>
              </div>
              <div class="users-toolbar">
                <div class="toolbar-group">
                  <label class="search-box"><span class="visually-hidden">搜索用户名</span>${icon('search')}<input id="userSearch" type="search" placeholder="搜索用户名" autocomplete="off" /></label>
                  <select class="compact" id="userSubscriptionFilter" aria-label="订阅状态"><option value="">全部订阅</option><option value="跟随全局">跟随全局</option><option value="单独订阅">单独订阅</option><option value="单独配置">单独配置</option><option value="已停用">已停用</option><option value="未配置">未配置</option></select>
                  <select class="compact" id="userAnomalyFilter" aria-label="异常筛选"><option value="">全部用户</option><option value="has">存在异常</option><option value="none">无异常</option></select>
                </div>
                <div class="toolbar-group">
                  <select class="compact" id="userSortKey" aria-label="排序字段"><option value="totalBytes">总量</option><option value="lastSeenAt">最近上报</option><option value="name">姓名</option><option value="subscriptionState">订阅</option><option value="devices">设备</option><option value="uploadBytes">上传</option><option value="downloadBytes">下载</option><option value="anomalies">异常</option></select>
                  <select class="compact" id="userSortDirection" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
                </div>
              </div>
              <div class="table-wrap">
                <table class="users-table">
                  <colgroup><col class="col-name" /><col class="col-subscription" /><col class="col-version" /><col class="col-devices" /><col class="col-upload" /><col class="col-download" /><col class="col-total" /><col class="col-anomalies" /><col class="col-seen" /><col class="col-actions" /></colgroup>
                  <thead><tr>
                    <th><button class="sort-button" type="button" data-user-sort="name">姓名<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th><button class="sort-button" type="button" data-user-sort="subscriptionState">订阅<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th>客户端</th>
                    <th class="num"><button class="sort-button" type="button" data-user-sort="devices">设备<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th class="num"><button class="sort-button" type="button" data-user-sort="uploadBytes">上传<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th class="num"><button class="sort-button" type="button" data-user-sort="downloadBytes">下载<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th class="num"><button class="sort-button" type="button" data-user-sort="totalBytes">总量<span class="sort-mark" aria-hidden="true">↓</span></button></th>
                    <th class="num"><button class="sort-button" type="button" data-user-sort="anomalies">异常<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th><button class="sort-button" type="button" data-user-sort="lastSeenAt">最近上报<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                    <th>操作</th>
                  </tr></thead>
                  <tbody id="users"></tbody>
                </table>
              </div>
              <footer class="list-footer">
                <span class="count-text" id="userPageSummary">0 条</span>
                <div class="pagination-controls" id="userPagination"></div>
              </footer>
            </article>

            <aside class="panel user-drawer" id="userDrawer" role="dialog" aria-modal="false" aria-label="用户详情">
              <div class="drawer-placeholder" id="drawerPlaceholder">
                <div><span class="placeholder-mark">${icon('users')}</span><h2>选择用户</h2></div>
              </div>
              <div id="drawerContent" hidden>
                <div class="drawer-profile">
                  <div class="profile-head">
                    <span class="profile-avatar" id="activeUserInitial">—</span>
                    <div class="profile-copy">
                      <h2 id="activeUserName">—</h2>
                      <dl class="profile-meta" aria-label="客户端信息">
                        <div><dt>客户端</dt><dd id="activeUserVersion">未上报</dd></div>
                        <div><dt>最近上报</dt><dd id="activeUserReportedAt">—</dd></div>
                      </dl>
                    </div>
                    <button class="button ghost" id="closeUserDrawer" type="button" aria-label="关闭用户详情">${icon('close', 'icon-sm')}</button>
                  </div>
                  <div class="profile-stats">
                    <div class="profile-stat"><span>逻辑设备</span><strong id="activeUserDevices">0</strong></div>
                    <div class="profile-stat"><span>原始记录</span><strong id="activeUserRecords">0</strong></div>
                    <div class="profile-stat"><span>总流量</span><strong id="activeUserTraffic">0 B</strong></div>
                    <div class="profile-stat"><span>异常</span><strong id="activeUserAnomalies">0</strong></div>
                  </div>
                </div>
                <div class="drawer-tabs" role="tablist" aria-label="用户详情分类">
                  <button class="drawer-tab is-active" id="drawerTabConfig" type="button" role="tab" aria-controls="drawerConfigSection" aria-selected="true" data-drawer-tab="config">客户端配置</button>
                  <button class="drawer-tab" id="drawerTabProfile" type="button" role="tab" aria-controls="drawerProfileSection" aria-selected="false" data-drawer-tab="profile">资料通知</button>
                  <button class="drawer-tab" id="drawerTabTraffic" type="button" role="tab" aria-controls="drawerTrafficSection" aria-selected="false" data-drawer-tab="traffic">每日流量</button>
                  <button class="drawer-tab" id="drawerTabMerge" type="button" role="tab" aria-controls="drawerMergeSection" aria-selected="false" data-drawer-tab="merge">合并用户</button>
                </div>
                <section class="drawer-section" id="drawerConfigSection" role="tabpanel" aria-labelledby="drawerTabConfig" data-drawer-section="config">
                  <form id="userConfigForm">
                    <div class="section-title user-config-state"><span class="chip gray" id="userSubscriptionState">跟随全局</span></div>
                    <div class="form-grid">
                      <label class="field" for="userMode">模式<select id="userMode"><option value="follow">跟随全局</option><option value="custom">单独配置</option><option value="disabled">停用</option></select></label>
                      <label class="field" for="userCanEditManagedConfig">自行配置<select id="userCanEditManagedConfig"><option value="inherit">跟随全局</option><option value="true">允许</option><option value="false">不允许</option></select></label>
                      <label class="field" for="userRuleProfile">规则<select id="userRuleProfile"><option value="ruleset">智能规则</option><option value="subscription">机场规则</option></select></label>
                      <label class="field" for="userPreferredRegion">优先地区<select id="userPreferredRegion"><option value="jp">日本</option><option value="hk">香港</option><option value="tw">台湾</option><option value="sg">新加坡</option><option value="us">美国</option><option value="kr">韩国</option><option value="auto">最低延迟</option></select></label>
                      <label class="field" for="userRegionFallback">地区不可用<select id="userRegionFallback"><option value="global">自动切换</option><option value="strict">保持地区</option></select></label>
                      <label class="field wide" for="userSubscription">订阅链接<input id="userSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" aria-describedby="userSubscriptionError" /></label>
                      <div class="field-error wide" id="userSubscriptionError" role="alert"></div>
                    </div>
                    <div class="drawer-actions"><button class="button" id="saveUserConfig" type="submit">${icon('save', 'icon-sm')}保存</button><button class="button secondary" id="resetUserConfig" type="button">${icon('reset', 'icon-sm')}重置</button></div>
                  </form>
                </section>
                <section class="drawer-section" id="drawerProfileSection" role="tabpanel" aria-labelledby="drawerTabProfile" data-drawer-section="profile" hidden>
                  <form class="user-profile-editor" id="userProfileForm">
                    <div class="section-title"><h3>用户资料</h3></div>
                    <div class="profile-editor-row">
                      <label class="field" for="userProfileName">用户名<input id="userProfileName" maxlength="80" autocomplete="off" aria-describedby="userProfileNameError" /></label>
                      <button class="button" id="saveUserProfile" type="submit">${icon('save', 'icon-sm')}保存</button>
                    </div>
                    <div class="field-error" id="userProfileNameError" role="alert"></div>
                  </form>
                  <form class="notice-editor" id="userNoticeForm">
                    <div class="section-title"><h3>定向通知</h3></div>
                    <div class="form-grid">
                      <label class="field" for="userNoticeTone">级别<select id="userNoticeTone"><option value="info">提示</option><option value="warning">警告</option></select></label>
                      <div class="field notice-duration-field">
                        <span id="userNoticeDurationLabel">持续时间</span>
                        <div class="duration-stepper" role="group" aria-labelledby="userNoticeDurationLabel">
                          <button class="stepper-button" id="decreaseUserNoticeDuration" type="button" aria-label="减少持续时间">−</button>
                          <input id="userNoticeDuration" type="number" min="5" max="10080" step="5" inputmode="numeric" aria-describedby="userNoticeError" />
                          <span class="duration-unit" aria-hidden="true">分钟</span>
                          <button class="stepper-button" id="increaseUserNoticeDuration" type="button" aria-label="增加持续时间">+</button>
                        </div>
                      </div>
                      <label class="field wide" for="userNoticeMessage">内容<textarea id="userNoticeMessage" maxlength="500" rows="4" aria-describedby="userNoticeError"></textarea></label>
                      <div class="field-error wide" id="userNoticeError" role="alert"></div>
                    </div>
                    <div class="drawer-actions"><button class="button" id="saveUserNotice" type="submit">${icon('save', 'icon-sm')}保存通知</button><button class="button secondary" id="clearUserNotice" type="button">${icon('reset', 'icon-sm')}停止通知</button></div>
                  </form>
                </section>
                <section class="drawer-section" id="drawerTrafficSection" role="tabpanel" aria-labelledby="drawerTabTraffic" data-drawer-section="traffic" hidden>
                  <div class="table-wrap drawer-traffic-wrap"><table class="traffic-table"><colgroup><col style="width:22%" /><col style="width:30%" /><col style="width:16%" /><col style="width:16%" /><col style="width:16%" /></colgroup><thead><tr><th>日期</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th class="num">总量</th></tr></thead><tbody id="details"></tbody></table></div>
                  <footer class="drawer-table-footer"><span class="count-text" id="trafficPageSummary">0 条</span><div class="pagination-controls" id="trafficPagination"></div></footer>
                </section>
                <section class="drawer-section" id="drawerMergeSection" role="tabpanel" aria-labelledby="drawerTabMerge" data-drawer-section="merge" hidden>
                  <div class="merge-zone">
                    <label class="field" for="mergeTarget">合并到<select id="mergeTarget"><option value="">选择保留的用户</option></select></label>
                    <button class="button secondary" id="previewMerge" type="button" disabled>预览合并</button>
                    <div class="merge-preview hidden" id="mergePreview" aria-live="polite">
                      <div class="preview-grid" id="mergePreviewSummary"></div>
                      <div class="conflict-box hidden" id="mergeConflict"><label class="field" for="mergeResolution">配置处理方式<select id="mergeResolution"><option value="">请选择配置处理方式</option><option value="keep_target">保留目标配置</option><option value="use_source">使用当前用户配置</option><option value="reset_to_global">重置为全局配置</option></select></label></div>
                      <button class="button danger" id="confirmMerge" type="button" disabled>${icon('merge', 'icon-sm')}合并用户</button>
                    </div>
                  </div>
                </section>
              </div>
            </aside>
          </div>
          <div class="drawer-backdrop" id="drawerBackdrop"></div>
        </section>

        <section class="view-panel" id="viewConfig" data-view-panel="config" hidden>
          <div class="section-switcher" data-section-switcher="config" role="tablist" aria-label="配置内容">
            <button class="is-active" type="button" role="tab" aria-selected="true" data-config-section="global">全局配置</button>
            <button type="button" role="tab" aria-selected="false" data-config-section="quota">订阅周期</button>
            <button type="button" role="tab" aria-selected="false" data-config-section="distribution">配置分布</button>
          </div>
          <div class="management-grid">
            <article class="panel accent-purple config-panel" data-config-pane="global">
              <div class="panel-head"><div class="panel-heading">${icon('config')}<div><h2 class="panel-title">全局配置</h2><p class="panel-subtitle">适用于跟随全局的用户</p></div></div><span class="chip" id="globalVersion">v1</span></div>
              <form class="panel-body" id="globalConfigForm">
                <div class="config-block"><span class="chip gray" id="globalSubscriptionState" hidden>未配置</span>
                  <div class="form-grid">
                    <label class="field wide" for="globalSubscription">订阅链接<input id="globalSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" aria-describedby="globalSubscriptionError" /></label>
                    <div class="field-error wide" id="globalSubscriptionError" role="alert"></div>
                    <label class="field" for="globalEnabled">状态<select id="globalEnabled"><option value="true">启用</option><option value="false">停用</option></select></label>
                    <label class="field" for="globalCanEditManagedConfig">自行配置<select id="globalCanEditManagedConfig"><option value="true">允许</option><option value="false">不允许</option></select></label>
                    <label class="field" for="globalRuleProfile">规则<select id="globalRuleProfile"><option value="ruleset">智能规则</option><option value="subscription">机场规则</option></select></label>
                    <label class="field" for="globalPreferredRegion">优先地区<select id="globalPreferredRegion"><option value="jp">日本</option><option value="hk">香港</option><option value="tw">台湾</option><option value="sg">新加坡</option><option value="us">美国</option><option value="kr">韩国</option><option value="auto">最低延迟</option></select></label>
                    <label class="field" for="globalRegionFallback">地区不可用<select id="globalRegionFallback"><option value="global">自动切换</option><option value="strict">保持地区</option></select></label>
                  </div>
                </div>
                <div class="config-footer"><button class="button" id="saveGlobal" type="submit">${icon('save', 'icon-sm')}保存</button><button class="button danger" id="syncGlobalUsers" type="button">${icon('reset', 'icon-sm')}清除覆盖</button></div>
              </form>
            </article>

            <div class="config-column">
              <article class="panel accent-blue" data-config-pane="quota">
                <div class="panel-head"><div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">订阅周期</h2></div></div></div>
                <form class="panel-body quota-config-grid" id="trafficLimitForm">
                  <div class="quota-fields">
                    <label class="field" for="trafficLimitGb">套餐额度<div class="input-suffix"><input id="trafficLimitGb" type="number" min="1" step="1" inputmode="numeric" value="648" /><span>GB</span></div></label>
                    <label class="field" for="trafficPeriodStartedAt">开始时间<input id="trafficPeriodStartedAt" type="datetime-local" step="60" required /></label>
                    <label class="field" for="trafficExpiresAt">到期时间<input id="trafficExpiresAt" type="datetime-local" step="60" required /></label>
                    <button class="button quota-save" id="saveTrafficLimit" type="submit">${icon('save', 'icon-sm')}保存</button>
                  </div>
                  ${quotaDonut()}
                </form>
                <div class="panel-body" style="padding-top:0"><div class="quota-legend"><div class="quota-line"><span class="quota-dot"></span><span>本期已用</span><strong data-quota-used>—</strong></div><div class="quota-line"><span class="quota-dot muted"></span><span>剩余流量</span><strong data-quota-balance>—</strong></div></div></div>
              </article>

              <article class="panel accent-cyan" data-config-pane="distribution">
                <div class="panel-head"><div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">配置分布</h2></div></div></div>
                <div class="panel-body"><div class="distribution-list" id="configDistribution"></div></div>
              </article>
            </div>
          </div>
        </section>

        <section class="view-panel" id="viewAnomalies" data-view-panel="anomalies" hidden>
          <div class="metric-grid anomaly-summary">
            ${metricCard('purple', 'database', '异常总数', 'anomalyRecords')}
            ${metricCard('blue', 'users', '涉及用户', 'anomalyUsers')}
            ${metricCard('cyan', 'upload', '最大上传', 'anomalyMaxUpload')}
            ${metricCard('sky', 'download', '最大下载', 'anomalyMaxDownload')}
            ${metricCard('coral', 'clock', '最近时间', 'anomalyLatest')}
          </div>

          <div class="section-switcher" data-section-switcher="anomaly" role="tablist" aria-label="异常内容">
            <button class="is-active" type="button" role="tab" aria-selected="true" data-anomaly-section="records">异常记录</button>
            <button type="button" role="tab" aria-selected="false" data-anomaly-section="distribution">异常分布</button>
          </div>

          <article class="panel accent-purple anomaly-distribution" data-anomaly-pane="distribution">
            <div class="panel-head"><div class="panel-heading">${icon('chart')}<div><h2 class="panel-title">异常分布</h2><p class="panel-subtitle">按用户统计</p></div></div></div>
            <div class="panel-body distribution-card-body"><div class="distribution-list" id="anomalyDistribution"></div><div class="other-users"><span>其他用户</span><strong id="otherAnomalyCount">0 条</strong></div></div>
          </article>

          <article class="panel accent-red anomaly-records" data-anomaly-pane="records">
            <div class="panel-head"><div class="panel-heading">${icon('warning')}<div><h2 class="panel-title">异常记录</h2><p class="panel-subtitle">仅含流量突增</p></div></div><span class="count-text" id="anomalyCount" hidden>0 条</span></div>
            <div class="anomaly-toolbar">
              <label class="search-box"><span class="visually-hidden">搜索异常</span>${icon('search')}<input id="anomalySearch" type="search" placeholder="搜索用户或设备" autocomplete="off" /></label>
              <div class="toolbar-group"><select class="compact" id="anomalySortKey" aria-label="异常排序字段"><option value="createdAt">时间</option><option value="uploadBytes">上传</option><option value="downloadBytes">下载</option></select><select class="compact" id="anomalySortDirection" aria-label="异常排序方向"><option value="desc">降序</option><option value="asc">升序</option></select></div>
            </div>
            <div class="table-wrap"><table class="anomaly-table"><colgroup><col class="col-user" /><col class="col-device" /><col class="col-date" /><col class="col-upload" /><col class="col-download" /><col class="mobile-anomaly-total" /><col class="col-reason" /><col class="col-time" /><col class="col-action" /></colgroup><thead><tr><th>用户</th><th>设备</th><th>日期</th><th class="num">上传</th><th class="num">下载</th><th class="num mobile-anomaly-total">总量</th><th>原因</th><th>记录时间</th><th>操作</th></tr></thead><tbody id="anomalies"></tbody></table></div>
            <footer class="list-footer"><span class="count-text" id="anomalyPageSummary">0 条</span><div class="pagination-controls" id="anomalyPagination"></div></footer>
          </article>
        </section>
      </div>
    </main>
  </div>

  <dialog id="confirmDialog" aria-labelledby="confirmText">
    <form class="dialog-form" method="dialog">
      <p id="confirmText"></p>
      <label class="field hidden" id="confirmPhraseWrap" for="confirmPhrase">确认内容<input id="confirmPhrase" autocomplete="off" /></label>
      <div class="button-row"><button class="button secondary" type="submit" value="cancel">取消</button><button class="button" id="confirmAccept" type="submit" value="confirm">确认</button></div>
    </form>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="/admin/assets/app.js" defer></script>
</body>
</html>`;
}

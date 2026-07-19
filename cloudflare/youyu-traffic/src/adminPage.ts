export function adminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>YouYu 后台</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f4f6f8;
      --panel: #ffffff;
      --panel-subtle: #f7f8fa;
      --ink: #17202a;
      --ink-soft: #3d4854;
      --muted: #66727e;
      --line: #dfe3e8;
      --line-strong: #c9d0d8;
      --hover: #f0f2f5;
      --accent: #7c4dbc;
      --accent-hover: #6f45ad;
      --accent-soft: #efe9fa;
      --success: #21704f;
      --success-soft: #e5f3eb;
      --warning: #9a5a16;
      --warning-soft: #fbefdf;
      --danger: #ac3b35;
      --danger-soft: #f9e9e7;
      --shadow: 0 1px 2px rgba(31, 42, 55, 0.045);
      --shadow-float: 0 18px 48px rgba(31, 42, 55, 0.16);
      --radius: 12px;
      --radius-control: 9px;
      --focus: 0 0 0 3px rgba(124, 77, 188, 0.22);
      --control-height: 40px;
      --page-gap: 16px;
    }

    * { box-sizing: border-box; }
    html {
      min-width: 320px;
      overflow-y: scroll;
      scrollbar-gutter: stable both-edges;
      background: var(--canvas);
    }
    body {
      min-width: 320px;
      min-height: 100vh;
      margin: 0;
      padding: 20px 24px 32px;
      background: var(--canvas);
      color: var(--ink);
      font-family: "Segoe UI Variable Text", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }

    button,
    input,
    select { font: inherit; }

    button,
    input,
    select,
    summary { -webkit-tap-highlight-color: transparent; }

    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    summary:focus-visible,
    tr[tabindex]:focus-visible {
      outline: none;
      box-shadow: var(--focus);
    }

    .admin-shell {
      position: relative;
      width: min(1560px, 100%);
      min-width: 0;
      margin: 0 auto;
    }

    .topbar {
      position: sticky;
      top: 12px;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      min-height: 72px;
      margin-bottom: var(--page-gap);
      padding: 12px 16px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: var(--shadow);
    }

    .topbar h1,
    .panel h2,
    .panel h3,
    .topbar p { margin: 0; }

    .topbar h1 {
      font-family: "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif;
      font-size: clamp(24px, 2vw, 30px);
      font-weight: 720;
      line-height: 1.08;
      letter-spacing: -0.025em;
    }

    .status-text {
      max-width: min(70vw, 920px);
      min-height: 21px;
      margin-top: 4px !important;
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-group {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: nowrap;
      gap: 8px;
    }

    button {
      position: relative;
      min-width: 88px;
      height: var(--control-height);
      min-height: var(--control-height);
      display: inline-grid;
      place-items: center;
      flex: none;
      border: 1px solid transparent;
      border-radius: var(--radius-control);
      padding: 0 15px;
      background: var(--accent);
      color: #ffffff;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
      --button-spinner: #ffffff;
    }

    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:active:not(:disabled) { box-shadow: inset 0 0 0 1px rgba(23, 32, 42, 0.12); }
    button:disabled { cursor: not-allowed; opacity: 0.52; }

    button.secondary {
      border-color: var(--line);
      background: var(--hover);
      color: var(--ink-soft);
      --button-spinner: var(--accent);
    }

    button.secondary:hover:not(:disabled) {
      border-color: var(--line-strong);
      background: #dde6ea;
      color: var(--ink);
    }

    button.danger-button {
      border-color: #edcbc7;
      background: var(--danger-soft);
      color: var(--danger);
      --button-spinner: var(--danger);
    }

    button.danger-button:hover:not(:disabled) {
      border-color: #dfaaa5;
      background: #f3d9d6;
      color: #8f2f2a;
    }

    button[aria-busy="true"] { color: transparent; }
    button[aria-busy="true"]::after {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border: 2px solid var(--button-spinner);
      border-right-color: transparent;
      border-radius: 50%;
      content: "";
      animation: spin 720ms linear infinite;
    }

    .auth-panel {
      position: absolute;
      top: calc(100% + 10px);
      right: 0;
      z-index: 30;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 10px;
      width: min(560px, calc(100vw - 48px));
      margin: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow-float);
    }

    .admin-workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      gap: var(--page-gap);
    }

    .management-grid {
      display: grid;
      grid-template-columns: minmax(390px, 0.82fr) minmax(520px, 1.18fr);
      align-items: start;
      gap: var(--page-gap);
    }

    .panel {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: clip;
    }

    .panel-head,
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .panel-head {
      min-height: 64px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }

    .panel-head h2,
    .section-head h3 {
      min-width: 0;
      font-family: "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif;
      color: var(--ink);
      font-weight: 700;
      line-height: 1.2;
    }

    .panel-head h2 {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-head > .action-group {
      flex: none;
      flex-wrap: nowrap;
    }

    .panel-head h2 { font-size: 18px; }
    .section-head h3 { font-size: 15px; }

    .panel-body {
      display: grid;
      gap: 14px;
      padding: 16px;
    }

    .users-panel { overflow: clip; }
    .users-panel .table-wrap {
      max-height: min(48vh, 520px);
      overflow: auto;
      scrollbar-gutter: stable;
    }

    .detail-rail {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    .detail-rail > .panel { box-shadow: var(--shadow); }
    .global-config,
    .placeholder-panel,
    #userConfigPanel { min-height: 488px; }
    .placeholder-panel .panel-body { min-height: 486px; align-content: center; justify-items: center; text-align: center; }

    .muted { color: var(--muted); }
    .count-text {
      color: var(--muted);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .field {
      display: grid;
      min-width: 0;
      gap: 6px;
      color: var(--ink-soft);
      font-size: 13px;
      font-weight: 650;
    }

    .field.wide,
    .field-error.wide { grid-column: 1 / -1; }

    input,
    select {
      width: 100%;
      min-width: 0;
      height: var(--control-height);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-control);
      padding: 0 11px;
      background: #ffffff;
      color: var(--ink);
      font-weight: 500;
      transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
    }

    input:hover:not(:disabled),
    select:hover:not(:disabled) { border-color: #99acb6; }

    input:focus,
    select:focus { border-color: var(--accent); }

    input:disabled,
    select:disabled {
      background: var(--panel-subtle);
      color: var(--muted);
      cursor: not-allowed;
    }

    input::placeholder { color: #8b99a3; }
    [aria-invalid="true"] { border-color: var(--danger); }

    .field-error {
      min-height: 19px;
      color: var(--danger);
      font-size: 12px;
      font-weight: 650;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      max-width: 100%;
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--hover);
      color: var(--ink-soft);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
    }

    .chip.good { background: var(--success-soft); color: var(--success); }
    .chip.warn { background: var(--warning-soft); color: var(--warning); }
    .chip.off { background: #edf0f2; color: var(--muted); }

    .subsection {
      display: grid;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }

    .subsection:first-child { padding-top: 0; border-top: 0; }

    .merge-zone {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-subtle);
    }

    .merge-preview {
      display: grid;
      gap: 10px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }

    .preview-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .preview-card {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
    }

    .preview-card strong,
    .preview-card span { display: block; min-width: 0; overflow-wrap: anywhere; }
    .preview-card strong { margin-bottom: 4px; font-size: 13px; }
    .preview-card span { color: var(--muted); font-size: 12px; }

    .conflict-box {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid #e8c798;
      border-radius: 8px;
      background: var(--warning-soft);
    }

    .table-wrap { min-width: 0; overflow: auto; }
    table {
      width: 100%;
      min-width: 580px;
      border-collapse: collapse;
      table-layout: fixed;
      font-variant-numeric: tabular-nums;
    }

    .users-table { min-width: 1040px; }
    .users-table .col-name { width: 17%; }
    .users-table .col-subscription { width: 11%; }
    .users-table .col-devices { width: 7%; }
    .users-table .col-upload,
    .users-table .col-download,
    .users-table .col-total { width: 10.5%; }
    .users-table .col-anomalies { width: 7%; }
    .users-table .col-seen { width: 18%; }
    .users-table .col-actions { width: 8.5%; }
    th,
    td {
      padding: 11px 9px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .users-table td { height: 56px; }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #fbfcfd;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    th.sortable { padding: 0; }
    th.sortable button {
      width: 100%;
      min-width: 0;
      height: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 4px;
      border: 0;
      border-radius: 0;
      padding: 0 9px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      text-align: inherit;
    }

    th.sortable button:hover:not(:disabled) { background: var(--hover); color: var(--ink); }
    th[aria-sort="ascending"] button,
    th[aria-sort="descending"] button { color: var(--ink); }
    .sort-mark {
      width: 16px;
      height: 16px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 16px;
      margin: 0;
      color: #95a3ac;
      line-height: 1;
    }
    th[aria-sort="ascending"] .sort-mark,
    th[aria-sort="descending"] .sort-mark { color: var(--accent); }

    td.num,
    th.num,
    th.num button { text-align: right; }
    th.num button { justify-content: flex-end; }

    tbody tr { transition: background-color 120ms ease, box-shadow 120ms ease; }
    .users-table tbody tr { cursor: pointer; }
    tbody tr:hover { background: #f6f9fa; }
    tbody tr.is-active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
    tbody tr:last-child td { border-bottom: 0; }

    .user-name-cell {
      max-width: 0;
      overflow: hidden;
      color: var(--ink);
      font-weight: 700;
      text-overflow: ellipsis;
    }

    .table-action {
      min-width: 72px;
      height: 34px;
      min-height: 34px;
      padding: 0 12px;
    }

    .danger { color: var(--danger); font-weight: 750; }
    .empty-cell { height: 96px; color: var(--muted); text-align: center; }

    .anomaly-panel summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 58px;
      padding: 0 16px;
      cursor: pointer;
      list-style: none;
    }

    .anomaly-panel summary::-webkit-details-marker { display: none; }
    .anomaly-panel summary strong { display: block; font-size: 16px; }
    .anomaly-panel .table-wrap { border-top: 1px solid var(--line); }
    .summary-action { color: var(--ink-soft); font-size: 13px; font-weight: 700; }
    .summary-action::before { content: "展开"; }
    .anomaly-panel[open] .summary-action::before { content: "收起"; }

    dialog {
      width: min(430px, calc(100vw - 32px));
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      padding: 0;
      background: var(--panel);
      color: var(--ink);
      box-shadow: 0 22px 64px rgba(22, 39, 50, 0.22);
    }

    dialog::backdrop { background: rgba(24, 36, 47, 0.36); backdrop-filter: blur(2px); }
    .dialog-form { display: grid; gap: 16px; padding: 20px; }
    .dialog-form p { margin: 0; font-size: 15px; line-height: 1.6; }

    .visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }

    .hidden,
    [hidden] { display: none !important; }

    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 1100px) {
      body { padding: 16px; }
      .management-grid { grid-template-columns: minmax(0, 1fr); }
      .global-config,
      .placeholder-panel,
      #userConfigPanel { min-height: 0; }
      .placeholder-panel .panel-body { min-height: 180px; }
      .users-panel .table-wrap { max-height: min(52vh, 480px); }
    }

    @media (max-width: 720px) {
      body { padding: 10px; }
      .topbar {
        top: 8px;
        min-height: 68px;
        gap: 12px;
        margin-bottom: 12px;
        padding: 10px 12px;
      }
      .topbar h1 { font-size: 23px; }
      .status-text {
        max-width: 48vw;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .topbar button { min-width: 76px; padding: 0 12px; }
      .auth-panel {
        grid-template-columns: 1fr;
        width: min(480px, calc(100vw - 20px));
      }
      .admin-workspace,
      .management-grid { gap: 12px; }
      .panel-head,
      .section-head { align-items: flex-start; }
      .form-grid,
      .preview-grid { grid-template-columns: 1fr; }
      .field.wide,
      .field-error.wide { grid-column: auto; }
      .users-panel .table-wrap {
        max-height: min(68vh, 660px);
        overflow: auto;
        scrollbar-gutter: stable;
      }
      .users-table { display: block; min-width: 0; }
      .users-table colgroup { display: none; }
      .users-table thead {
        position: sticky;
        top: 0;
        z-index: 4;
        display: block;
        overflow-x: auto;
        border-bottom: 1px solid var(--line);
        scrollbar-width: thin;
      }
      .users-table thead tr {
        width: max-content;
        display: flex;
      }
      .users-table thead th {
        position: static;
        width: 92px;
        display: block;
        flex: 0 0 92px;
        border-right: 1px solid var(--line);
        border-bottom: 0;
      }
      .users-table thead th:nth-child(8) { width: 112px; flex-basis: 112px; }
      .users-table thead th:last-child { display: none; }
      .users-table tbody {
        display: grid;
        gap: 10px;
        padding: 10px;
        background: var(--panel-subtle);
      }
      .users-table tbody tr {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #ffffff;
        box-shadow: none;
      }
      .users-table tbody tr.is-active {
        border-color: #bca7da;
        background: var(--accent-soft);
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .users-table td {
        height: auto;
        min-height: 38px;
        display: grid;
        grid-template-columns: minmax(52px, 0.72fr) minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        text-align: right;
        white-space: normal;
      }
      .users-table td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
        text-align: left;
      }
      .users-table td .chip { justify-self: end; }
      .users-table tbody tr:last-child td { border-bottom: 1px solid var(--line); }
      .users-table td.user-name-cell,
      .users-table td:nth-child(8),
      .users-table td.actions-cell { grid-column: 1 / -1; }
      .users-table td.user-name-cell { max-width: none; }
      .users-table td.actions-cell,
      .users-table tbody tr:last-child td.actions-cell { display: block; border-bottom: 0; text-align: right; }
      .users-table td.actions-cell::before { content: none; }
      .users-table td.empty-cell { display: block; height: auto; grid-column: 1 / -1; text-align: center; }
      .users-table td.empty-cell::before { content: none; }
      .table-action { width: 100%; }
      .detail-table,
      .anomalies-table { min-width: 620px; }
    }

    @media (max-width: 520px) {
      .topbar { display: grid; }
      .topbar .action-group { justify-content: flex-start; }
      .status-text { max-width: calc(100vw - 44px); }
      .panel-head { display: grid; }
      .panel-head .action-group { justify-content: flex-start; }
      .panel-body { padding: 14px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }
  </style>
</head>
<body>
  <main class="admin-shell" id="adminShell" aria-busy="false">
    <header class="topbar">
      <div>
        <h1>YouYu 后台</h1>
        <p class="status-text" id="status" role="status" aria-live="polite">未加载</p>
      </div>
      <div class="action-group">
        <button class="secondary" id="changeToken" type="button" aria-controls="authPanel" aria-expanded="true">令牌</button>
        <button class="secondary" id="refresh" type="button" disabled>刷新</button>
      </div>
      <form class="auth-panel" id="authPanel">
        <label class="visually-hidden" for="token">管理令牌</label>
        <input id="token" type="password" placeholder="管理令牌" autocomplete="current-password" required />
        <button id="login" type="submit">进入</button>
      </form>
    </header>

    <div class="admin-workspace" id="adminWorkspace" hidden>
      <section class="panel users-panel" aria-labelledby="usersTitle">
        <div class="panel-head">
          <h2 id="usersTitle">用户</h2>
          <span class="count-text" id="userCount" aria-live="polite">0 个用户</span>
        </div>
        <div class="table-wrap">
          <table class="users-table">
            <colgroup>
              <col class="col-name" />
              <col class="col-subscription" />
              <col class="col-devices" />
              <col class="col-upload" />
              <col class="col-download" />
              <col class="col-total" />
              <col class="col-anomalies" />
              <col class="col-seen" />
              <col class="col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th class="sortable" data-sort="name" aria-sort="none"><button type="button">姓名<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="sortable" data-sort="subscriptionState" aria-sort="none"><button type="button">订阅<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="num sortable" data-sort="devices" aria-sort="none"><button type="button">设备<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="num sortable" data-sort="uploadBytes" aria-sort="none"><button type="button">上传<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="num sortable" data-sort="downloadBytes" aria-sort="none"><button type="button">下载<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="num sortable" data-sort="totalBytes" aria-sort="descending"><button type="button">总量<span class="sort-mark" aria-hidden="true">↓</span></button></th>
                <th class="num sortable" data-sort="anomalies" aria-sort="none"><button type="button">异常<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th class="sortable" data-sort="lastSeenAt" aria-sort="none"><button type="button">最后在线<span class="sort-mark" aria-hidden="true">↕</span></button></th>
                <th><span class="visually-hidden">操作</span></th>
              </tr>
            </thead>
            <tbody id="users"></tbody>
          </table>
        </div>
      </section>

      <div class="management-grid">
        <section class="panel global-config" aria-labelledby="globalTitle">
          <form id="globalConfigForm">
            <div class="panel-head">
              <h2 id="globalTitle">全局配置</h2>
              <div class="action-group">
                <span class="chip" id="globalVersion">v1</span>
                <button id="saveGlobal" type="submit">保存</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="section-head">
                <h3>全局订阅</h3>
                <span class="chip off" id="globalSubscriptionState">未配置</span>
              </div>
              <div class="form-grid">
                <label class="field wide" for="globalSubscription">订阅链接
                  <input id="globalSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" aria-describedby="globalSubscriptionError" />
                </label>
                <div class="field-error wide" id="globalSubscriptionError" role="alert"></div>
                <label class="field" for="globalEnabled">状态
                  <select id="globalEnabled"><option value="true">启用</option><option value="false">停用</option></select>
                </label>
                <label class="field" for="globalRuleProfile">规则
                  <select id="globalRuleProfile"><option value="ruleset">智能规则</option><option value="subscription">机场规则</option></select>
                </label>
              </div>
              <div class="action-group">
                <button class="danger-button" id="syncGlobalUsers" type="button">清除覆盖</button>
              </div>
            </div>
          </form>
        </section>

        <aside class="detail-rail" aria-label="配置与用户明细">
        <section class="panel placeholder-panel" id="sidePlaceholder">
          <div class="panel-body">
            <h2>用户明细</h2>
            <p class="muted">选择用户查看配置和流量</p>
          </div>
        </section>

        <section class="panel hidden" id="userConfigPanel" aria-labelledby="userConfigTitle">
          <form id="userConfigForm">
            <div class="panel-head">
              <h2 id="userConfigTitle">用户配置</h2>
              <div class="action-group">
                <button class="secondary" id="resetUserConfig" type="button">重置</button>
                <button id="saveUserConfig" type="submit">保存</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="section-head">
                <h3>用户订阅</h3>
                <span class="chip off" id="userSubscriptionState">跟随全局</span>
              </div>
              <div class="form-grid">
                <label class="field" for="userMode">模式
                  <select id="userMode"><option value="follow">跟随全局</option><option value="custom">单独配置</option><option value="disabled">停用</option></select>
                </label>
                <label class="field" for="userRuleProfile">规则
                  <select id="userRuleProfile"><option value="ruleset">智能规则</option><option value="subscription">机场规则</option></select>
                </label>
                <label class="field wide" for="userSubscription">订阅链接
                  <input id="userSubscription" placeholder="https://..." autocomplete="off" spellcheck="false" aria-describedby="userSubscriptionError" />
                </label>
                <div class="field-error wide" id="userSubscriptionError" role="alert"></div>
              </div>
            </div>
          </form>

          <div class="panel-body subsection" aria-labelledby="mergeTitle">
            <div class="section-head"><h3 id="mergeTitle">合并用户</h3></div>
            <div class="merge-zone">
              <label class="field" for="mergeTarget">合并到
                <select id="mergeTarget"><option value="">选择保留的用户</option></select>
              </label>
              <button class="secondary" id="previewMerge" type="button" disabled>预览合并</button>
              <div class="merge-preview hidden" id="mergePreview" aria-live="polite">
                <div class="preview-grid" id="mergePreviewSummary"></div>
                <div class="conflict-box hidden" id="mergeConflict">
                  <label class="field" for="mergeResolution">配置处理方式
                    <select id="mergeResolution">
                      <option value="">请选择配置处理方式</option>
                      <option value="keep_target">保留目标配置</option>
                      <option value="use_source">使用当前用户配置</option>
                      <option value="reset_to_global">重置为全局配置</option>
                    </select>
                  </label>
                </div>
                <button class="danger-button" id="confirmMerge" type="button" disabled>合并用户</button>
              </div>
            </div>
          </div>
        </section>

        </aside>
      </div>

      <section class="panel hidden" id="detailPanel" aria-labelledby="detailTitle">
        <div class="panel-head">
          <h2 id="detailTitle">流量明细</h2>
          <button class="secondary" id="closeDetail" type="button">收起</button>
        </div>
        <div class="table-wrap">
          <table class="detail-table">
            <colgroup><col style="width: 24%" /><col style="width: 40%" /><col style="width: 18%" /><col style="width: 18%" /></colgroup>
            <thead><tr><th>日期</th><th>设备</th><th class="num">上传</th><th class="num">下载</th></tr></thead>
            <tbody id="details"></tbody>
          </table>
        </div>
      </section>

      <details class="panel anomaly-panel hidden" id="anomalyPanel">
        <summary>
          <span><strong>异常</strong><span class="muted" id="anomalyCount">0 条</span></span>
          <span class="summary-action" aria-hidden="true"></span>
        </summary>
        <div class="table-wrap">
          <table class="anomalies-table">
            <colgroup><col style="width: 20%" /><col style="width: 28%" /><col style="width: 14%" /><col style="width: 14%" /><col style="width: 24%" /></colgroup>
            <thead><tr><th>用户</th><th>设备</th><th class="num">上传</th><th class="num">下载</th><th>时间</th></tr></thead>
            <tbody id="anomalies"></tbody>
          </table>
        </div>
      </details>
    </div>
  </main>

  <dialog id="confirmDialog" aria-labelledby="confirmText">
    <form class="dialog-form" method="dialog">
      <p id="confirmText"></p>
      <label class="field hidden" id="confirmPhraseWrap" for="confirmPhrase">确认内容
        <input id="confirmPhrase" autocomplete="off" />
      </label>
      <div class="action-group">
        <button class="secondary" type="submit" value="cancel">取消</button>
        <button id="confirmAccept" type="submit" value="confirm">确认</button>
      </div>
    </form>
  </dialog>

  <script>
    const adminShell = document.getElementById('adminShell');
    const adminWorkspace = document.getElementById('adminWorkspace');
    const authPanel = document.getElementById('authPanel');
    const tokenInput = document.getElementById('token');
    const loginButton = document.getElementById('login');
    const changeTokenButton = document.getElementById('changeToken');
    const refreshButton = document.getElementById('refresh');
    const statusEl = document.getElementById('status');
    const usersBody = document.getElementById('users');
    const userCountEl = document.getElementById('userCount');
    const detailsBody = document.getElementById('details');
    const anomaliesBody = document.getElementById('anomalies');
    const anomalyCountEl = document.getElementById('anomalyCount');
    const anomalyPanel = document.getElementById('anomalyPanel');
    const detailPanel = document.getElementById('detailPanel');
    const detailTitle = document.getElementById('detailTitle');
    const userConfigPanel = document.getElementById('userConfigPanel');
    const userConfigTitle = document.getElementById('userConfigTitle');
    const sidePlaceholder = document.getElementById('sidePlaceholder');
    const globalSubscriptionState = document.getElementById('globalSubscriptionState');
    const userSubscriptionState = document.getElementById('userSubscriptionState');
    const userModeEl = document.getElementById('userMode');
    const mergeTargetEl = document.getElementById('mergeTarget');
    const mergePreviewEl = document.getElementById('mergePreview');
    const mergePreviewSummary = document.getElementById('mergePreviewSummary');
    const mergeConflictEl = document.getElementById('mergeConflict');
    const mergeResolutionEl = document.getElementById('mergeResolution');
    const previewMergeButton = document.getElementById('previewMerge');
    const confirmMergeButton = document.getElementById('confirmMerge');
    const confirmDialog = document.getElementById('confirmDialog');
    const confirmText = document.getElementById('confirmText');
    const confirmPhraseWrap = document.getElementById('confirmPhraseWrap');
    const confirmPhrase = document.getElementById('confirmPhrase');
    const confirmAccept = document.getElementById('confirmAccept');
    const userSort = { key: 'totalBytes', direction: 'desc' };
    let loadedUsers = [];
    let activeUserId = '';
    let activeUserName = '';
    let activeRequests = 0;
    let mergePreviewState = null;
    let mergeRequestId = '';
    let userLoadSequence = 0;
    let mergePreviewSequence = 0;

    const sessionToken = sessionStorage.getItem('youyu_admin_token') || '';
    const legacyToken = localStorage.getItem('youyu_admin_token') || '';
    let committedToken = sessionToken || legacyToken;
    tokenInput.value = committedToken;
    if (!sessionToken && legacyToken) {
      sessionStorage.setItem('youyu_admin_token', legacyToken);
      localStorage.removeItem('youyu_admin_token');
    }

    authPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      runAction(loginButton, '验证中', authenticate);
    });
    changeTokenButton.addEventListener('click', () => {
      setAuthPanelOpen(authPanel.hidden);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !adminWorkspace.hidden && !authPanel.hidden) setAuthPanelOpen(false);
    });
    document.addEventListener('pointerdown', (event) => {
      if (adminWorkspace.hidden || authPanel.hidden) return;
      if (!authPanel.contains(event.target) && !changeTokenButton.contains(event.target)) setAuthPanelOpen(false);
    });
    refreshButton.addEventListener('click', () => runAction(refreshButton, '刷新中', () => loadAll(true)));
    document.getElementById('globalConfigForm').addEventListener('submit', (event) => {
      event.preventDefault();
      runAction(document.getElementById('saveGlobal'), '保存中', saveGlobalConfig);
    });
    document.getElementById('syncGlobalUsers').addEventListener('click', () => runAction(document.getElementById('syncGlobalUsers'), '清除中', syncGlobalUsers));
    document.getElementById('userConfigForm').addEventListener('submit', (event) => {
      event.preventDefault();
      runAction(document.getElementById('saveUserConfig'), '保存中', saveUserConfig);
    });
    document.getElementById('resetUserConfig').addEventListener('click', () => runAction(document.getElementById('resetUserConfig'), '重置中', resetUserConfig));
    document.getElementById('closeDetail').addEventListener('click', () => {
      detailPanel.classList.add('hidden');
      updateSidePlaceholder();
    });
    userModeEl.addEventListener('change', updateUserModeState);
    mergeTargetEl.addEventListener('change', resetMergePreview);
    mergeResolutionEl.addEventListener('change', updateMergeConfirmState);
    previewMergeButton.addEventListener('click', () => runAction(previewMergeButton, '预览中', previewUserMerge));
    confirmMergeButton.addEventListener('click', () => runAction(confirmMergeButton, '合并中', mergeUsers));

    document.querySelectorAll('th.sortable button').forEach((button) => {
      button.addEventListener('click', () => {
        const header = button.closest('th');
        const key = header.dataset.sort;
        if (userSort.key === key) userSort.direction = userSort.direction === 'desc' ? 'asc' : 'desc';
        else {
          userSort.key = key;
          userSort.direction = key === 'name' || key === 'subscriptionState' ? 'asc' : 'desc';
        }
        renderUsers();
      });
    });

    async function authenticate() {
      const token = tokenInput.value.trim();
      if (!token) {
        setAuthenticated(false);
        tokenInput.focus();
        throw new Error('请输入管理令牌');
      }
      await loadAll(false, token);
      committedToken = token;
      sessionStorage.setItem('youyu_admin_token', committedToken);
      tokenInput.value = committedToken;
      setAuthenticated(true);
      statusEl.textContent = '已更新';
    }

    function setAuthenticated(value) {
      adminWorkspace.hidden = !value;
      authPanel.hidden = value;
      refreshButton.disabled = !value;
      adminShell.classList.toggle('is-authenticated', value);
      changeTokenButton.setAttribute('aria-expanded', authPanel.hidden ? 'false' : 'true');
    }

    function setAuthPanelOpen(value) {
      authPanel.hidden = !value;
      changeTokenButton.setAttribute('aria-expanded', value ? 'true' : 'false');
      tokenInput.value = committedToken;
      if (value) tokenInput.focus();
    }

    async function runAction(button, loadingText, action) {
      if (button && button.disabled) return;
      activeRequests += 1;
      adminShell.setAttribute('aria-busy', 'true');
      if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      }
      statusEl.textContent = loadingText;
      try {
        return await action();
      } catch (error) {
        if (error && (error.status === 401 || error.status === 403)) setAuthenticated(false);
        statusEl.textContent = formatAdminError(error);
        return undefined;
      } finally {
        activeRequests = Math.max(0, activeRequests - 1);
        adminShell.setAttribute('aria-busy', activeRequests ? 'true' : 'false');
        if (button) {
          button.removeAttribute('aria-busy');
          if (button === refreshButton) button.disabled = adminWorkspace.hidden;
          else if (button === previewMergeButton) button.disabled = !activeUserId || !mergeTargetEl.value;
          else if (button !== confirmMergeButton) button.disabled = false;
        }
        updateMergeConfirmState();
      }
    }

    async function api(path, options, tokenOverride) {
      const token = tokenOverride || committedToken;
      const headers = Object.assign({ authorization: 'Bearer ' + token }, options && options.headers ? options.headers : {});
      const response = await fetch(path, Object.assign({}, options || {}, { headers: headers }));
      const text = await response.text();
      const data = parseJson(text);
      if (!response.ok) {
        const error = new Error(formatApiError(response.status, data));
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data || {};
    }

    async function loadAll(refreshActive, tokenOverride) {
      const selectedId = refreshActive ? activeUserId : '';
      await Promise.all([loadGlobalConfig(tokenOverride), loadUsers(tokenOverride), loadAnomalies(tokenOverride)]);
      if (selectedId) {
        const selected = loadedUsers.find((user) => user.id === selectedId);
        if (selected) await loadUserOverview(selected.id, selected.name || selected.id || '未命名');
        else clearUserContext();
      }
    }

    async function loadGlobalConfig(tokenOverride) {
      const data = await api('/api/admin/config', undefined, tokenOverride);
      const config = data.config || {};
      document.getElementById('globalEnabled').value = config.enabled === false ? 'false' : 'true';
      document.getElementById('globalSubscription').value = config.subscriptionUrl || '';
      document.getElementById('globalRuleProfile').value = normalizeRuleProfile(config.ruleProfile);
      document.getElementById('globalVersion').textContent = 'v' + (config.version || 1);
      setGlobalSubscriptionState(config);
    }

    async function saveGlobalConfig() {
      if (!validateSubscriptionField('global')) return;
      const payload = {
        enabled: document.getElementById('globalEnabled').value === 'true',
        subscriptionUrl: document.getElementById('globalSubscription').value.trim() || null,
        ruleProfile: document.getElementById('globalRuleProfile').value
      };
      const data = await api('/api/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const config = data.config || payload;
      document.getElementById('globalEnabled').value = config.enabled === false ? 'false' : 'true';
      document.getElementById('globalSubscription').value = config.subscriptionUrl || '';
      document.getElementById('globalRuleProfile').value = normalizeRuleProfile(config.ruleProfile);
      document.getElementById('globalVersion').textContent = 'v' + (config.version || 1);
      setGlobalSubscriptionState(config);
      await loadUsers();
      statusEl.textContent = '已保存，客户端会自动同步';
    }

    async function syncGlobalUsers() {
      const confirmed = await askConfirm('清除所有用户的单独配置？输入“清除”确认', '清除', '清除');
      if (!confirmed) {
        statusEl.textContent = '已取消';
        return;
      }
      const data = await api('/api/admin/config/sync-users', { method: 'POST' });
      if (activeUserId) {
        const config = data.config || {};
        setUserConfigFields(config);
        setUserMode('follow');
        setUserSubscriptionState(config, null);
        userConfigTitle.textContent = activeUserName + ' 配置';
      }
      await loadUsers();
      statusEl.textContent = '已清除 ' + (data.clearedUsers || 0) + ' 个覆盖';
    }

    async function loadUsers(tokenOverride) {
      const data = await api('/api/admin/users', undefined, tokenOverride);
      loadedUsers = Array.isArray(data.users) ? data.users : [];
      renderUsers();
      userCountEl.textContent = loadedUsers.length + ' 个用户';
      populateMergeTargets();
      if (mergePreviewState) resetMergePreview();
    }

    function renderUsers() {
      usersBody.innerHTML = '';
      updateSortHeaders();
      const users = sortUsers(loadedUsers);
      if (!users.length) {
        usersBody.innerHTML = '<tr><td class="empty-cell" colspan="9">暂无用户</td></tr>';
        return;
      }
      for (const user of users) {
        const tr = document.createElement('tr');
        const displayName = user.name || user.id || '未命名';
        const uploadBytes = numberValue(user.uploadBytes);
        const downloadBytes = numberValue(user.downloadBytes);
        const logicalDevices = numberValue(user.devices);
        const deviceRecords = numberValue(user.deviceRecords);
        const deviceHint = deviceRecords > logicalDevices ? ' title="逻辑设备 ' + logicalDevices + '，原始记录 ' + deviceRecords + '" aria-label="逻辑设备 ' + logicalDevices + '，原始记录 ' + deviceRecords + '"' : '';
        const anomalyText = user.anomalies ? '<span class="danger">' + numberValue(user.anomalies) + '</span>' : '0';
        tr.dataset.userId = user.id || '';
        tr.tabIndex = 0;
        tr.setAttribute('aria-label', displayName + '，查看');
        if (user.id === activeUserId) tr.classList.add('is-active');
        tr.innerHTML = '<td class="user-name-cell" data-label="姓名" title="' + escapeHtml(displayName) + '">' + escapeHtml(displayName) + '</td>' +
          '<td data-label="订阅">' + subscriptionBadge(user.subscriptionState) + '</td>' +
          '<td class="num" data-label="设备"' + deviceHint + '>' + logicalDevices + '</td>' +
          '<td class="num" data-label="上传">' + formatBytes(uploadBytes) + '</td>' +
          '<td class="num" data-label="下载">' + formatBytes(downloadBytes) + '</td>' +
          '<td class="num" data-label="总量">' + formatBytes(uploadBytes + downloadBytes) + '</td>' +
          '<td class="num" data-label="异常">' + anomalyText + '</td>' +
          '<td data-label="最后在线">' + formatTime(user.lastSeenAt) + '</td>' +
          '<td class="actions-cell"><button class="secondary table-action" type="button" data-action="manage">查看</button></td>';
        const openUser = () => runAction(null, displayName + ' 加载中', () => loadUserOverview(user.id, displayName));
        tr.addEventListener('click', (event) => { if (!event.target.closest('button')) openUser(); });
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openUser();
          }
        });
        tr.querySelector('[data-action="manage"]').addEventListener('click', (event) => {
          event.stopPropagation();
          openUser();
        });
        usersBody.appendChild(tr);
      }
    }

    function updateSortHeaders() {
      document.querySelectorAll('th.sortable').forEach((header) => {
        const active = header.dataset.sort === userSort.key;
        header.setAttribute('aria-sort', active ? (userSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        const mark = header.querySelector('.sort-mark');
        if (mark) mark.textContent = active ? (userSort.direction === 'asc' ? '↑' : '↓') : '↕';
      });
    }

    function sortUsers(users) {
      return users.slice().sort((a, b) => {
        const result = compareUserValue(a, b, userSort.key);
        return userSort.direction === 'asc' ? result : -result;
      });
    }

    function compareUserValue(a, b, key) {
      if (key === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
      if (key === 'subscriptionState') return String(a.subscriptionState || '').localeCompare(String(b.subscriptionState || ''), 'zh-CN');
      if (key === 'lastSeenAt') return dateValue(a.lastSeenAt) - dateValue(b.lastSeenAt);
      if (key === 'totalBytes') return numberValue(a.uploadBytes) + numberValue(a.downloadBytes) - numberValue(b.uploadBytes) - numberValue(b.downloadBytes);
      return numberValue(a[key]) - numberValue(b[key]);
    }

    async function loadUserOverview(userId, name) {
      const loadSequence = ++userLoadSequence;
      const data = await Promise.all([
        api('/api/admin/users/' + encodeURIComponent(userId) + '/config'),
        api('/api/admin/users/' + encodeURIComponent(userId) + '/traffic')
      ]);
      if (loadSequence !== userLoadSequence) return;
      activeUserId = userId;
      activeUserName = name;
      renderUserConfig(name, data[0]);
      renderUserTraffic(name, data[1].rows || []);
      userConfigPanel.classList.remove('hidden');
      detailPanel.classList.remove('hidden');
      sidePlaceholder.classList.add('hidden');
      revealSelectedUser(userId);
      populateMergeTargets();
      resetMergePreview();
      statusEl.textContent = name + ' 已加载';
    }

    function renderUserConfig(name, data) {
      const override = data.override || null;
      const effective = data.effective || {};
      setUserConfigFields(override || effective);
      setUserMode(getUserModeFromConfig(override));
      setUserSubscriptionState(effective, override);
      userConfigTitle.textContent = name + ' 配置';
    }

    function setUserConfigFields(config) {
      document.getElementById('userSubscription').value = config.subscriptionUrl || '';
      document.getElementById('userRuleProfile').value = normalizeRuleProfile(config.ruleProfile);
    }

    async function saveUserConfig() {
      if (!activeUserId) return;
      const userId = activeUserId;
      const userName = activeUserName;
      const userSequence = userLoadSequence;
      const mode = getUserMode();
      if (mode === 'follow') {
        const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config/reset', { method: 'POST' });
        if (!isCurrentUserContext(userId, userSequence)) return;
        setUserConfigFields(data.effective || {});
        setUserMode('follow');
        setUserSubscriptionState(data.effective || {}, null);
        statusEl.textContent = userName + ' 已跟随全局';
        await loadUsers();
        return;
      }
      if (!validateSubscriptionField('user')) return;
      const payload = {
        enabled: mode !== 'disabled',
        subscriptionUrl: mode === 'custom' ? document.getElementById('userSubscription').value.trim() || null : null,
        ruleProfile: document.getElementById('userRuleProfile').value
      };
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!isCurrentUserContext(userId, userSequence)) return;
      renderUserConfig(userName, data);
      statusEl.textContent = userName + ' 已保存';
      await loadUsers();
    }

    async function resetUserConfig() {
      if (!activeUserId) return;
      const userId = activeUserId;
      const userName = activeUserName;
      const userSequence = userLoadSequence;
      const data = await api('/api/admin/users/' + encodeURIComponent(userId) + '/config/reset', { method: 'POST' });
      if (!isCurrentUserContext(userId, userSequence)) return;
      setUserConfigFields(data.effective || {});
      setUserMode('follow');
      setUserSubscriptionState(data.effective || {}, null);
      userConfigTitle.textContent = userName + ' 配置';
      statusEl.textContent = userName + ' 已重置为跟随全局';
      await loadUsers();
    }

    function isCurrentUserContext(userId, sequence) {
      return activeUserId === userId && userLoadSequence === sequence;
    }

    function getUserMode() {
      return userModeEl.value === 'custom' || userModeEl.value === 'disabled' ? userModeEl.value : 'follow';
    }

    function setUserMode(mode) {
      userModeEl.value = mode;
      updateUserModeState();
    }

    function getUserModeFromConfig(override) {
      if (!override) return 'follow';
      return override.enabled === false ? 'disabled' : 'custom';
    }

    function updateUserModeState() {
      const editable = getUserMode() === 'custom';
      document.getElementById('userSubscription').disabled = !editable;
      document.getElementById('userRuleProfile').disabled = !editable;
    }

    function revealSelectedUser(userId) {
      usersBody.querySelectorAll('tr[data-user-id]').forEach((row) => row.classList.toggle('is-active', row.dataset.userId === userId));
    }

    function clearUserContext() {
      userLoadSequence += 1;
      activeUserId = '';
      activeUserName = '';
      userConfigPanel.classList.add('hidden');
      detailPanel.classList.add('hidden');
      sidePlaceholder.classList.remove('hidden');
      revealSelectedUser('');
      resetMergePreview();
    }

    function updateSidePlaceholder() {
      const visible = !userConfigPanel.classList.contains('hidden') || !detailPanel.classList.contains('hidden');
      sidePlaceholder.classList.toggle('hidden', visible);
    }

    function renderUserTraffic(name, rows) {
      detailTitle.textContent = name + ' 流量';
      detailsBody.innerHTML = '';
      const visibleRows = (Array.isArray(rows) ? rows : []).slice(0, 14);
      if (!visibleRows.length) {
        detailsBody.innerHTML = '<tr><td colspan="4" class="empty-cell">暂无流量</td></tr>';
        return;
      }
      for (const row of visibleRows) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.date || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num">' + formatBytes(numberValue(row.uploadBytes)) + '</td><td class="num">' + formatBytes(numberValue(row.downloadBytes)) + '</td>';
        detailsBody.appendChild(tr);
      }
    }

    async function loadAnomalies(tokenOverride) {
      const data = await api('/api/admin/anomalies', undefined, tokenOverride);
      const anomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
      anomaliesBody.innerHTML = '';
      for (const row of anomalies.slice(0, 20)) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(row.userName || row.userId || '') + '</td><td>' + escapeHtml(row.deviceName || row.deviceId || '') + '</td><td class="num danger">' + formatBytes(numberValue(row.uploadBytes)) + '</td><td class="num danger">' + formatBytes(numberValue(row.downloadBytes)) + '</td><td>' + formatTime(row.createdAt) + '</td>';
        anomaliesBody.appendChild(tr);
      }
      anomalyCountEl.textContent = anomalies.length > 20 ? anomalies.length + ' 条，显示 20 条' : anomalies.length + ' 条';
      anomalyPanel.classList.toggle('hidden', anomalies.length === 0);
      if (!anomalies.length) anomalyPanel.open = false;
    }

    function populateMergeTargets() {
      const selected = mergeTargetEl.value;
      mergeTargetEl.innerHTML = '<option value="">选择保留的用户</option>';
      for (const user of loadedUsers) {
        if (!user.id || user.id === activeUserId) continue;
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = user.name || user.id || '未命名';
        mergeTargetEl.appendChild(option);
      }
      if ([...mergeTargetEl.options].some((option) => option.value === selected)) mergeTargetEl.value = selected;
      previewMergeButton.disabled = !activeUserId || !mergeTargetEl.value;
    }

    function resetMergePreview() {
      mergePreviewSequence += 1;
      mergePreviewState = null;
      mergeRequestId = '';
      mergePreviewEl.classList.add('hidden');
      mergeConflictEl.classList.add('hidden');
      mergeResolutionEl.value = '';
      mergePreviewSummary.innerHTML = '';
      previewMergeButton.disabled = !activeUserId || !mergeTargetEl.value;
      confirmMergeButton.disabled = true;
    }

    async function previewUserMerge() {
      const targetUserId = mergeTargetEl.value;
      if (!activeUserId || !targetUserId || activeUserId === targetUserId) return;
      const sourceUserId = activeUserId;
      const previewSequence = ++mergePreviewSequence;
      const data = await api('/api/admin/users/' + encodeURIComponent(activeUserId) + '/merge-preview?targetUserId=' + encodeURIComponent(targetUserId));
      if (previewSequence !== mergePreviewSequence || sourceUserId !== activeUserId || targetUserId !== mergeTargetEl.value) return;
      const preview = data.preview && typeof data.preview === 'object' ? data.preview : data;
      const conflict = hasConfigConflict(data, preview);
      mergePreviewState = {
        targetUserId: targetUserId,
        conflict: conflict,
        source: preview.source || data.source || null,
        target: preview.target || data.target || null
      };
      mergeRequestId = createRequestId();
      renderMergePreview(targetUserId, conflict, mergePreviewState.source, mergePreviewState.target);
      statusEl.textContent = '合并预览已更新';
    }

    function hasConfigConflict(data, preview) {
      const conflicts = preview && preview.conflicts && typeof preview.conflicts === 'object' ? preview.conflicts : null;
      const raw = preview.configConflict !== undefined ? preview.configConflict :
        data.configConflict !== undefined ? data.configConflict :
        preview.config && preview.config.conflict !== undefined ? preview.config.conflict :
        data.config && data.config.conflict !== undefined ? data.config.conflict :
        preview.requiresConfigResolution !== undefined ? preview.requiresConfigResolution :
        data.requiresConfigResolution !== undefined ? data.requiresConfigResolution :
        conflicts && conflicts.config !== undefined ? conflicts.config : false;
      if (raw && typeof raw === 'object') {
        if (raw.hasConflict !== undefined) return Boolean(raw.hasConflict);
        if (raw.required !== undefined) return Boolean(raw.required);
        return Object.keys(raw).length > 0;
      }
      return Boolean(raw);
    }

    function renderMergePreview(targetUserId, conflict, previewSource, previewTarget) {
      const source = Object.assign({}, loadedUsers.find((user) => user.id === activeUserId) || {}, previewSource || {});
      const target = Object.assign({}, loadedUsers.find((user) => user.id === targetUserId) || {}, previewTarget || {});
      mergePreviewSummary.innerHTML = '';
      mergePreviewSummary.appendChild(createPreviewCard('当前用户', source.name || activeUserName || activeUserId, source));
      mergePreviewSummary.appendChild(createPreviewCard('目标用户', target.name || targetUserId, target));
      mergeConflictEl.classList.toggle('hidden', !conflict);
      mergeResolutionEl.value = '';
      mergePreviewEl.classList.remove('hidden');
      updateMergeConfirmState();
    }

    function createPreviewCard(label, name, user) {
      const card = document.createElement('div');
      card.className = 'preview-card';
      const title = document.createElement('strong');
      const detail = document.createElement('span');
      title.textContent = label + '：' + name;
      detail.textContent = '逻辑设备 ' + numberValue(user.devices) + ' · 原始记录 ' + numberValue(user.deviceRecords);
      card.appendChild(title);
      card.appendChild(detail);
      return card;
    }

    function updateMergeConfirmState() {
      const needsResolution = mergePreviewState && mergePreviewState.conflict;
      const hasResolution = !needsResolution || Boolean(mergeResolutionEl.value);
      confirmMergeButton.disabled = !mergePreviewState || !hasResolution || activeRequests > 0;
    }

    async function mergeUsers() {
      if (!mergePreviewState || mergePreviewState.targetUserId !== mergeTargetEl.value) return;
      if (mergePreviewState.conflict && !mergeResolutionEl.value) {
        mergeResolutionEl.focus();
        statusEl.textContent = '请选择配置处理方式';
        return;
      }
      const sourceUserId = activeUserId;
      const sourceSequence = userLoadSequence;
      const previewState = mergePreviewState;
      const targetUserId = mergePreviewState.targetUserId;
      const target = loadedUsers.find((user) => user.id === targetUserId);
      const targetName = target ? target.name || target.id || '未命名' : targetUserId;
      const confirmed = await askConfirm('当前用户的数据将并入“' + targetName + '”，合并后不能撤销。', '合并');
      if (!confirmed) {
        statusEl.textContent = '已取消';
        return;
      }
      if (!isCurrentUserContext(sourceUserId, sourceSequence) || mergePreviewState !== previewState) return;
      const payload = {
        targetUserId: targetUserId,
        configResolution: mergePreviewState.conflict ? mergeResolutionEl.value : undefined,
        requestId: mergeRequestId || createRequestId()
      };
      try {
        await api('/api/admin/users/' + encodeURIComponent(sourceUserId) + '/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        if (error && error.status === 409) {
          if (!isCurrentUserContext(sourceUserId, sourceSequence) || mergePreviewState !== previewState) return;
          mergePreviewState.conflict = true;
          mergeConflictEl.classList.remove('hidden');
          mergeResolutionEl.value = '';
          mergeResolutionEl.focus();
          statusEl.textContent = '配置存在冲突，请选择处理方式后重试';
          return;
        }
        throw error;
      }
      if (!isCurrentUserContext(sourceUserId, sourceSequence)) {
        await loadUsers();
        return;
      }
      activeUserId = '';
      activeUserName = '';
      await loadAll(false);
      const refreshedTarget = loadedUsers.find((user) => user.id === targetUserId);
      if (refreshedTarget) await loadUserOverview(targetUserId, refreshedTarget.name || targetName);
      else clearUserContext();
      statusEl.textContent = '用户已合并';
    }

    function askConfirm(message, acceptLabel, phrase) {
      if (!confirmDialog || typeof confirmDialog.showModal !== 'function') return Promise.resolve(window.confirm(message));
      confirmText.textContent = message;
      confirmAccept.textContent = acceptLabel;
      confirmPhraseWrap.classList.toggle('hidden', !phrase);
      confirmPhrase.value = '';
      confirmAccept.disabled = Boolean(phrase);
      const onInput = () => { confirmAccept.disabled = Boolean(phrase) && confirmPhrase.value.trim() !== phrase; };
      confirmPhrase.addEventListener('input', onInput);
      confirmDialog.returnValue = '';
      confirmDialog.showModal();
      if (phrase) confirmPhrase.focus();
      return new Promise((resolve) => {
        confirmDialog.addEventListener('close', () => {
          confirmPhrase.removeEventListener('input', onInput);
          resolve(confirmDialog.returnValue === 'confirm');
        }, { once: true });
      });
    }

    function validateSubscriptionField(prefix) {
      const input = document.getElementById(prefix + 'Subscription');
      const errorEl = document.getElementById(prefix + 'SubscriptionError');
      const value = input.value.trim();
      input.removeAttribute('aria-invalid');
      errorEl.textContent = '';
      if (value && !value.startsWith('https://')) {
        const message = '订阅链接需以 https:// 开头';
        input.setAttribute('aria-invalid', 'true');
        errorEl.textContent = message;
        statusEl.textContent = message;
        input.focus();
        return false;
      }
      return true;
    }

    function normalizeRuleProfile(value) { return value === 'subscription' ? 'subscription' : 'ruleset'; }

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

    function setSubscriptionChip(element, text) {
      element.textContent = text;
      element.className = 'chip ' + subscriptionClass(text);
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

    function createRequestId() {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    function parseJson(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (error) { return null; }
    }

    function formatApiError(status, data) {
      const error = data && data.error ? String(data.error) : '';
      if (status === 403) return error === 'admin disabled' ? '后台未启用管理' : '管理 token 不对';
      if (status === 401) return '设备签名无效';
      if (status === 409) return error === 'config conflict' ? '用户配置存在冲突' : '当前数据已发生变化，请刷新后重试';
      if (status === 429) return '请求太频繁';
      if (status === 400) return error === 'invalid subscription url' ? '订阅链接无效' : '请求内容有误';
      if (status === 404) return '接口不存在';
      if (status >= 500) return '后台暂时不可用';
      return '请求失败';
    }

    function formatAdminError(error) {
      return error instanceof Error && error.message ? error.message : '无法加载';
    }

    function numberValue(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }

    function dateValue(value) {
      const time = value ? new Date(value).getTime() : 0;
      return Number.isFinite(time) ? time : 0;
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatTime(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '-';
      return date.toLocaleString('zh-CN', { hour12: false });
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }

    if (tokenInput.value.trim()) runAction(loginButton, '验证中', authenticate);
  </script>
</body>
</html>`;
}

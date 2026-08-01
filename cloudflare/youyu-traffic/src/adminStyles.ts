export const ADMIN_STYLES = String.raw`
:root {
  color-scheme: light;
  --sidebar: #0c1a36;
  --sidebar-deep: #0c1a36;
  --canvas: #eef2f6;
  --canvas-accent: #eef2f6;
  --panel: #ffffff;
  --panel-solid: #ffffff;
  --panel-muted: #f6f7fa;
  --ink: #17213a;
  --ink-soft: #465169;
  --muted: #707b91;
  --line: #dfe4ec;
  --line-strong: #cbd3df;
  --purple: #6254c7;
  --purple-deep: #5145ad;
  --purple-soft: #f0effa;
  --blue: #6254c7;
  --blue-soft: #f0effa;
  --cyan: #6254c7;
  --cyan-soft: #f0effa;
  --green: #25805c;
  --green-soft: #eaf5ef;
  --orange: #b96a35;
  --orange-soft: #fbf0e8;
  --red: #cf4356;
  --red-soft: #faecef;
  --shadow: 0 1px 2px rgba(18, 30, 65, 0.05);
  --shadow-float: 0 16px 42px rgba(7, 22, 58, 0.18);
  --radius: 12px;
  --radius-sm: 9px;
  --control: 40px;
  --focus: 0 0 0 3px rgba(103, 81, 245, 0.22);
}

* { box-sizing: border-box; }
html {
  min-width: 320px;
  min-height: 100%;
  overflow-y: scroll;
  scrollbar-gutter: stable both-edges;
  background: var(--canvas);
}
body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font: 14px/1.5 "Segoe UI Variable Text", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
}
button, input, select { font: inherit; }
button, input, select { -webkit-tap-highlight-color: transparent; }
button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: none;
  box-shadow: var(--focus);
}
button { border: 0; }
[hidden], .hidden { display: none !important; }
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
.icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-sm { width: 17px; height: 17px; }
.app-shell {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  padding: 22px 14px 18px;
  color: rgba(255, 255, 255, 0.78);
  background: var(--sidebar);
  box-shadow: inset -1px 0 rgba(255, 255, 255, 0.06);
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 48px;
  margin: 0 4px 24px;
  color: #fff;
  text-decoration: none;
}
.brand img {
  width: 40px;
  height: 40px;
  object-fit: contain;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.brand-copy { display: grid; line-height: 1.1; }
.brand-copy strong { font-size: 19px; font-weight: 740; letter-spacing: -0.02em; }
.brand-copy span { display: none; }
.primary-nav { display: grid; gap: 7px; }
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 48px;
  border-radius: 10px;
  padding: 0 14px;
  background: transparent;
  color: rgba(255, 255, 255, 0.72);
  font-weight: 650;
  text-align: left;
  cursor: pointer;
  transition: color .18s ease, background .18s ease, transform .18s ease;
}
.nav-item:hover { color: #fff; background: rgba(255,255,255,.09); transform: translateX(2px); }
.nav-item.is-active {
  color: #fff;
  background: var(--purple-deep);
  box-shadow: none;
}
.nav-item.is-active::after {
  position: absolute;
  top: 12px;
  right: 0;
  width: 3px;
  height: 24px;
  border-radius: 3px 0 0 3px;
  background: #c9c3ef;
  content: "";
}
.nav-item .icon { width: 21px; height: 21px; }
.sidebar-note { display: none; }

.main-shell { min-width: 0; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 82px;
  padding: 13px 24px;
  border-bottom: 1px solid var(--line);
  background: #f7f8fa;
}
.page-heading { min-width: 0; }
.page-heading h1 {
  margin: 0;
  font: 740 24px/1.2 "Segoe UI Variable Display", "Microsoft YaHei UI", sans-serif;
  letter-spacing: -.025em;
}
.status-text {
  min-height: 20px;
  max-width: min(70vw, 800px);
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-text:empty { display: none; }
.top-actions, .button-row, .toolbar-group, .pagination-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.top-actions { position: relative; flex: 0 0 auto; }
.button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 96px;
  height: var(--control);
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--purple);
  color: #fff;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: none;
  transition: border-color .15s ease, background .15s ease, color .15s ease;
  --spinner: #fff;
}
.button:hover:not(:disabled) { background: var(--purple-deep); box-shadow: none; }
.button:active:not(:disabled) { background: #473c99; }
.button.secondary {
  border-color: var(--line-strong);
  background: #fff;
  color: var(--ink-soft);
  box-shadow: none;
  --spinner: var(--purple);
}
.button.secondary:hover:not(:disabled) { border-color: #aebbd2; background: #e7ecf5; color: var(--ink); }
.button.ghost { min-width: 40px; width: 40px; padding: 0; border-color: var(--line); background: transparent; color: var(--ink-soft); box-shadow: none; }
.button.ghost:hover:not(:disabled) { background: var(--purple-soft); color: var(--purple-deep); }
.button.danger { border-color: #f1b7c1; background: var(--red-soft); color: #bc2e47; box-shadow: none; --spinner: var(--red); }
.button.danger:hover:not(:disabled) { border-color: #e994a3; background: #fadce2; box-shadow: none; }
.button.small { min-width: 72px; height: 34px; padding: 0 11px; font-size: 13px; }
.button:disabled { cursor: not-allowed; opacity: .52; transform: none; box-shadow: none; }
.button[aria-busy="true"] { color: transparent; }
.button[aria-busy="true"] .icon { visibility: hidden; }
.button[aria-busy="true"]::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 15px;
  height: 15px;
  margin: -9px;
  border: 2px solid var(--spinner);
  border-right-color: transparent;
  border-radius: 50%;
  content: "";
  animation: spin .7s linear infinite;
}
.auth-panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 70;
  display: grid;
  grid-template-columns: minmax(230px, 1fr) auto;
  gap: 9px;
  width: min(470px, calc(100vw - 32px));
  padding: 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  box-shadow: var(--shadow-float);
}

.admin-workspace { min-width: 0; padding: 20px 22px 28px; }
.view-panel { min-width: 0; }
.stack { display: grid; gap: 16px; }
.metric-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.metric-card {
  position: relative;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 110px;
  padding: 17px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-solid);
  box-shadow: var(--shadow);
}
.metric-card::after { display: none; }
.metric-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 11px;
  background: var(--metric-bg, var(--purple-soft));
  color: var(--metric, var(--purple));
  box-shadow: none;
}
.metric-icon .icon { width: 26px; height: 26px; }
.metric-copy { min-width: 0; position: relative; z-index: 1; }
.metric-label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.metric-value { display: block; overflow: hidden; font-size: clamp(19px, 1.55vw, 25px); font-weight: 760; line-height: 1.15; letter-spacing: -.025em; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.metric-note { display: block; margin-top: 5px; color: var(--ink-soft); font-size: 11px; white-space: nowrap; }
.metric-card.purple,
.metric-card.blue,
.metric-card.cyan,
.metric-card.sky { --metric:var(--purple); --metric-bg:var(--purple-soft); }
.metric-card.coral { --metric:var(--red); --metric-bg:var(--red-soft); }

.panel {
  min-width: 0;
  overflow: clip;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow);
}
.panel.accent-purple,
.panel.accent-blue,
.panel.accent-cyan { border-top: 2px solid var(--purple); }
.panel.accent-red { border-top: 2px solid var(--red); }
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 58px;
  padding: 12px 15px;
  border-bottom: 1px solid var(--line);
}
.panel-heading { display: flex; align-items: center; gap: 9px; min-width: 0; }
.panel-heading .icon { color: var(--purple); }
.panel-title { margin: 0; font-size: 16px; font-weight: 740; letter-spacing: -.01em; }
.panel-subtitle { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.panel-body { min-width: 0; padding: 16px; }
.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 1.18fr);
  gap: 16px;
}
.overview-grid .panel { min-height: 300px; }
.overview-grid .tall { min-height: 352px; }

.quota-layout {
  display: grid;
  grid-template-columns: minmax(180px, .78fr) minmax(220px, 1fr);
  align-items: center;
  gap: 20px;
}
.donut-wrap { display: grid; place-items: center; }
.donut {
  --ring: 0;
  --ring-color: var(--purple);
  position: relative;
  display: grid;
  place-items: center;
  width: 190px;
  aspect-ratio: 1;
  border-radius: 50%;
  background: conic-gradient(var(--ring-color) calc(var(--ring) * 1%), #dfe5f1 0);
  box-shadow: inset 0 0 0 1px rgba(81,69,173,.08);
}
.donut::before {
  position: absolute;
  inset: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(210,219,235,.9);
  content: "";
}
.donut.danger { --ring-color: var(--red); }
.donut.warning { --ring-color: var(--orange); }
.donut-content { position: relative; z-index: 1; text-align: center; }
.donut-content span { display: block; color: var(--muted); font-size: 12px; }
.donut-content strong { display: block; margin: 4px 0 1px; font-size: 28px; line-height: 1.05; font-variant-numeric: tabular-nums; }
.donut-content small { color: var(--ink-soft); font-size: 12px; }
.quota-legend { display: grid; gap: 10px; }
.quota-line { display: grid; grid-template-columns: 12px minmax(0,1fr) auto; align-items: center; gap: 9px; min-height: 42px; padding: 0 11px; border-radius: 9px; background: var(--panel-muted); }
.quota-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--purple); }
.quota-dot.muted { background: #cbd4e6; }
.quota-dot.red { background: var(--red); }
.quota-line span { color: var(--muted); font-size: 12px; }
.quota-line strong { font-variant-numeric: tabular-nums; }
.quota-action { margin-top: 2px; }

.ranking-list, .distribution-list { display: grid; gap: 13px; }
.ranking-row { display: grid; grid-template-columns: 26px minmax(84px, .45fr) minmax(100px, 1.2fr) minmax(78px, auto); align-items: center; gap: 10px; }
.rank-index { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 50%; background: var(--purple-soft); color: var(--purple-deep); font-size: 12px; font-weight: 760; }
.rank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 9px; overflow: hidden; border-radius: 999px; background: #e5eaf4; }
.bar-fill { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--purple); transition: width .2s ease; }
.rank-value { color: var(--ink-soft); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

.compact-table, table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.table-wrap { min-width: 0; overflow: auto; scrollbar-gutter: stable; }
th, td { height: 46px; padding: 0 11px; border-bottom: 1px solid #e5e9f2; text-align: left; vertical-align: middle; }
th { background: #f0f2fb; color: #5b6787; font-size: 12px; font-weight: 730; white-space: nowrap; }
td { color: var(--ink-soft); font-size: 13px; }
tbody tr { transition: background .15s ease, box-shadow .15s ease; }
tbody tr:hover { background: #f6f5ff; }
tbody tr.is-active { background: var(--purple-soft); box-shadow: inset 3px 0 var(--purple); }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.danger-text { color: var(--red) !important; font-weight: 700; }
.success-text { color: var(--green) !important; }
.muted { color: var(--muted); }
.empty-cell { height: 150px !important; color: var(--muted); text-align: center; }
.name-cell { overflow: hidden; color: var(--ink); font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.user-link {
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: var(--purple-deep);
  font: inherit;
  font-weight: 700;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.user-link:hover { text-decoration: underline; }
.sort-button { display: inline-flex; align-items: center; gap: 4px; width: 100%; padding: 0; background: transparent; color: inherit; font-weight: inherit; cursor: pointer; }
.num .sort-button { justify-content: flex-end; }
.sort-mark { display: inline-grid; place-items: center; width: 16px; height: 16px; color: #8a95af; }
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 25px;
  max-width: 100%;
  border-radius: 999px;
  padding: 3px 8px;
  background: var(--purple-soft);
  color: var(--purple-deep);
  font-size: 11px;
  font-weight: 720;
  line-height: 1.2;
  white-space: nowrap;
}
.chip.blue { background: var(--blue-soft); color: #216ccb; }
.chip.green { background: var(--green-soft); color: #187d58; }
.chip.orange { background: var(--orange-soft); color: #bc5b2f; }
.chip.red { background: var(--red-soft); color: #bd324a; }
.chip.gray { background: #ebeff5; color: #65718e; }
.list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 58px;
  padding: 9px 14px;
  border-top: 1px solid var(--line);
}
.count-text { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.pager-button { min-width: 34px; width: 34px; height: 34px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink-soft); cursor: pointer; }
.pager-button.is-active { border-color: var(--purple); background: var(--purple); color: #fff; }
.pager-button:disabled { opacity: .45; cursor: not-allowed; }

.users-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 438px;
  align-items: start;
  gap: 16px;
}
.user-list-panel { min-height: calc(100vh - 220px); }
.users-toolbar, .anomaly-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 62px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: rgba(248,250,253,.82);
}
.toolbar-group { min-width: 0; flex-wrap: wrap; }
.search-box { position: relative; min-width: 220px; flex: 1 1 250px; }
.users-toolbar > .toolbar-group:first-child { flex: 1 1 auto; flex-wrap: nowrap; }
.users-toolbar > .toolbar-group:last-child { flex: 0 0 auto; }
.users-toolbar .search-box { min-width: 180px; flex: 0 1 220px; }
.users-toolbar select.compact { min-width: 112px; }
.search-box .icon { position: absolute; top: 11px; left: 11px; width: 18px; height: 18px; color: #8792ac; pointer-events: none; }
.search-box input { padding-left: 37px; }
input, select, textarea {
  width: 100%;
  min-width: 0;
  height: var(--control);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 0 11px;
  background: rgba(255,255,255,.92);
  color: var(--ink);
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
textarea { min-height: 82px; padding: 9px 11px; resize: vertical; font: inherit; line-height: 1.45; }
input:hover:not(:disabled), select:hover:not(:disabled), textarea:hover:not(:disabled) { border-color: #9eacc4; }
input:focus, select:focus, textarea:focus { border-color: var(--purple); }
input:disabled, select:disabled, textarea:disabled { background: #eef1f6; color: #8792aa; cursor: not-allowed; }
input::placeholder { color: #98a2b7; }
select.compact { width: auto; min-width: 132px; }
.users-table { min-width: 840px; }
.users-table col.col-name { width: 15%; }
.users-table col.col-subscription { width: 12%; }
.users-table col.col-devices { width: 8%; }
.users-table col.col-upload { width: 11%; }
.users-table col.col-download { width: 11%; }
.users-table col.col-total { width: 12%; }
.users-table col.col-anomalies { width: 8%; }
.users-table col.col-seen { width: 16%; }
.users-table col.col-actions { width: 7%; }
.users-table .button { min-width: 58px; }

.user-drawer {
  position: sticky;
  top: 98px;
  min-width: 0;
  max-height: calc(100vh - 118px);
  overflow: auto;
  scrollbar-gutter: auto;
}
.user-config-state { justify-content: flex-end; margin-bottom: 8px; }
.drawer-backdrop { display: none; }
.drawer-placeholder {
  display: grid;
  place-items: center;
  min-height: 340px;
  padding: 28px;
  text-align: center;
}
.placeholder-mark { display: grid; place-items: center; width: 58px; height: 58px; margin: 0 auto 13px; border-radius: 17px; background: var(--purple-soft); color: var(--purple); }
.placeholder-mark .icon { width: 28px; height: 28px; }
.drawer-placeholder h2 { margin: 0; font-size: 17px; }
.drawer-placeholder p { margin: 7px 0 0; color: var(--muted); }
.drawer-profile { padding: 15px; border-bottom: 1px solid var(--line); background: #f7f7fb; }
.profile-head { display: flex; align-items: center; gap: 12px; }
.profile-avatar { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; background: var(--purple); color: #fff; font-size: 19px; font-weight: 760; box-shadow: none; }
.profile-copy { min-width: 0; flex: 1; }
.profile-copy h2 { margin: 0; overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
.profile-copy p { margin: 3px 0 0; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.profile-stats { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 7px; margin-top: 14px; }
.profile-stat { min-width: 0; padding: 9px 5px; border: 1px solid var(--line); border-radius: 9px; background: #fff; text-align: center; }
.profile-stat span { display: block; color: var(--muted); font-size: 10px; }
.profile-stat strong { display: block; margin-top: 3px; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.drawer-tabs { display: grid; grid-template-columns: repeat(4, 1fr); min-height: 44px; border-bottom: 1px solid var(--line); background: #fafbfe; }
.drawer-tab { position: relative; background: transparent; color: var(--muted); font-size: 12px; font-weight: 700; cursor: pointer; }
.drawer-tab::after { position: absolute; right: 22%; bottom: -1px; left: 22%; height: 2px; border-radius: 2px; background: transparent; content: ""; }
.drawer-tab.is-active { color: var(--purple-deep); }
.drawer-tab.is-active::after { background: var(--purple); }
.drawer-section { padding: 15px; }
.drawer-section[hidden] { display: none !important; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.section-title h3 { margin: 0; font-size: 14px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
.field { display: grid; gap: 6px; min-width: 0; color: var(--ink-soft); font-size: 12px; font-weight: 650; }
.field.wide, .field-error.wide { grid-column: 1 / -1; }
.field-error { min-height: 17px; color: var(--red); font-size: 11px; }
[aria-invalid="true"] { border-color: var(--red) !important; }
.drawer-actions { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; margin-top: 14px; }
.drawer-actions .button { width: 100%; min-width: 0; }
.drawer-actions.single { grid-template-columns: 1fr; }
.notice-editor { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); }
.traffic-table { min-width: 360px; }
.traffic-table td, .traffic-table th { height: 40px; padding: 0 4px; overflow: hidden; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.drawer-traffic-wrap { max-height: 430px; border: 1px solid var(--line); border-radius: 9px; }
.merge-zone { display: grid; gap: 11px; }
.merge-preview { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.preview-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.preview-card { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-muted); }
.preview-card strong, .preview-card span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-card strong { font-size: 12px; }
.preview-card span { margin-top: 4px; color: var(--muted); font-size: 10px; }
.conflict-box { padding: 10px; border: 1px solid #f0d0a8; border-radius: 9px; background: #fff8ee; }

.management-grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(380px, .92fr); align-items: start; gap: 16px; }
.config-column { display: grid; gap: 16px; }
.config-panel .panel-body { padding: 20px; }
.config-block + .config-block { margin-top: 19px; padding-top: 19px; border-top: 1px solid var(--line); }
.config-block h3 { margin: 0 0 12px; font-size: 14px; }
.config-footer { display: flex; justify-content: space-between; gap: 9px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.quota-config-grid { display: grid; grid-template-columns: minmax(170px,.7fr) minmax(190px,1fr); align-items: center; gap: 18px; }
.quota-config-grid .donut { width: 170px; }
.input-suffix { position: relative; }
.input-suffix input { padding-right: 44px; font-variant-numeric: tabular-nums; }
.input-suffix span { position: absolute; top: 10px; right: 12px; color: var(--muted); font-size: 12px; }
.distribution-row { display: grid; grid-template-columns: minmax(85px,.4fr) minmax(130px,1fr) minmax(92px,auto); align-items: center; gap: 12px; }
.distribution-value { color: var(--ink-soft); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }

.anomaly-summary { margin-bottom: 16px; }
.anomaly-distribution { margin-bottom: 16px; }
.anomaly-table { min-width: 1040px; }
.anomaly-table col.col-user { width: 14%; }
.anomaly-table col.col-device { width: 17%; }
.anomaly-table col.col-date { width: 10%; }
.anomaly-table col.col-upload { width: 11%; }
.anomaly-table col.col-download { width: 11%; }
.anomaly-table col.col-reason { width: 12%; }
.anomaly-table col.col-time { width: 17%; }
.anomaly-table col.col-action { width: 8%; }
.distribution-card-body { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; }
.other-users { min-width: 150px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-muted); }
.other-users span { display:block; color: var(--muted); font-size: 11px; }
.other-users strong { display:block; margin-top:5px; font-size:18px; }

dialog {
  width: min(440px, calc(100vw - 32px));
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 0;
  background: #fff;
  color: var(--ink);
  box-shadow: var(--shadow-float);
}
dialog::backdrop { background: rgba(7,22,58,.48); backdrop-filter: blur(3px); }
.dialog-form { display: grid; gap: 16px; padding: 20px; }
.dialog-form p { margin: 0; color: var(--ink-soft); }
.dialog-form .button-row { justify-content: flex-end; }
.toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 100;
  max-width: min(390px, calc(100vw - 32px));
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  color: var(--ink-soft);
  box-shadow: var(--shadow-float);
  transform: translateY(10px);
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
.toast.is-visible { transform: translateY(0); opacity: 1; }
.toast.is-error { border-color: #edb0bc; background: #fff7f8; color: #ae2941; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes view-enter { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 1420px) {
  .users-workbench { display: block; }
  .user-drawer {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 91;
    width: min(500px, calc(100vw - 48px));
    max-height: 100vh;
    height: 100vh;
    border-radius: 0;
    transform: translateX(104%);
    visibility: hidden;
    transition: transform .24s ease, visibility .24s ease;
    box-shadow: -22px 0 62px rgba(7,22,58,.24);
  }
  .user-drawer.is-open { transform: translateX(0); visibility: visible; }
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: block;
    background: rgba(7,22,58,.42);
    opacity: 0;
    visibility: hidden;
    transition: opacity .2s ease, visibility .2s ease;
  }
  .drawer-backdrop.is-open { opacity: 1; visibility: visible; }
  body.drawer-modal { overflow: hidden; }
  .drawer-placeholder { display: none; }
}

@media (max-width: 1180px) {
  .metric-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }
  .metric-card:nth-child(4), .metric-card:nth-child(5) { min-height: 96px; }
}

@media (max-width: 1279px) {
  .overview-grid { grid-template-columns: 1fr; }
  .management-grid { grid-template-columns: 1fr; }
}

@media (max-width: 1100px) {
  .app-shell { grid-template-columns: 78px minmax(0,1fr); }
  .sidebar { padding-inline: 10px; }
  .brand { justify-content: center; margin-inline: 0; }
  .brand img { width: 40px; height: 40px; }
  .brand-copy, .nav-item span, .sidebar-note { display: none; }
  .nav-item { justify-content: center; padding: 0; }
  .nav-item:hover { transform: none; }
  .nav-item.is-active::after { display: none; }
  .topbar { padding-inline: 18px; }
  .admin-workspace { padding: 17px 16px 24px; }
  .metric-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .quota-layout, .quota-config-grid { grid-template-columns: 1fr; }
  .quota-legend { width: 100%; }
}

@media (min-width: 981px) and (max-width: 1100px) {
  .metric-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .quota-layout { grid-template-columns: minmax(180px,.78fr) minmax(220px,1fr); }
  .quota-config-grid { grid-template-columns: minmax(170px,.7fr) minmax(190px,1fr); }
  .quota-legend { width: auto; }
}

@media (max-width: 820px) {
  .users-toolbar { align-items: stretch; flex-direction: column; }
  .users-toolbar .toolbar-group { width: 100%; }
  .users-toolbar > .toolbar-group:first-child { flex-wrap: wrap; }
  .users-toolbar .search-box { min-width: 100%; flex: 1 1 100%; }
  .users-toolbar select.compact { flex: 1 1 120px; }
}

@media (max-width: 700px) {
  .app-shell { display: block; }
  .sidebar {
    position: sticky;
    display: flex;
    flex-direction: row;
    align-items: center;
    height: 64px;
    padding: 8px 10px;
  }
  .brand { flex: 0 0 auto; margin: 0 8px 0 0; }
  .brand img { width: 38px; height: 38px; }
  .primary-nav { display: flex; min-width: 0; flex: 1; justify-content: flex-end; gap: 4px; }
  .nav-item { width: 45px; height: 45px; border-radius: 9px; }
  .nav-item .icon { width: 20px; height: 20px; }
  .topbar { top: 64px; min-height: 72px; padding: 10px 13px; }
  .page-heading h1 { font-size: 20px; }
  .status-text { max-width: calc(100vw - 185px); font-size: 11px; }
  .top-actions .button { min-width: 42px; width: 42px; padding: 0; }
  .top-actions .button span { display: none; }
  .admin-workspace { padding: 13px 11px 20px; }
  .metric-grid { grid-template-columns: 1fr 1fr; gap: 9px; }
  .metric-card { grid-template-columns: 40px minmax(0,1fr); min-height: 92px; padding: 12px; gap: 9px; }
  .metric-icon { width: 40px; height: 40px; }
  .metric-icon .icon { width: 22px; height: 22px; }
  .metric-value { font-size: 18px; }
  .metric-note { display: none; }
  .panel-head { align-items: flex-start; }
  .users-toolbar, .anomaly-toolbar { align-items: stretch; flex-direction: column; }
  .toolbar-group { width: 100%; }
  .search-box { min-width: 100%; }
  select.compact { flex: 1 1 120px; width: auto; }
  .list-footer { align-items: flex-start; flex-direction: column; }
  .pagination-controls { width: 100%; justify-content: space-between; }
  .ranking-row { grid-template-columns: 24px minmax(70px,.55fr) minmax(70px,1fr); }
  .rank-value { display: none; }
  .distribution-card-body { grid-template-columns: 1fr; }
  .other-users { min-width: 0; }
  .config-footer { flex-direction: column; }
  .config-footer .button { width: 100%; }
  .form-grid { grid-template-columns: 1fr; }
  .field.wide, .field-error.wide { grid-column: auto; }
  .user-drawer { width: 100vw; }
  .profile-stats { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .donut { width: 170px; }
  .quota-config-grid .donut { width: 155px; }
  .toast { right: 12px; bottom: 12px; }
}

@media (max-width: 430px) {
  .metric-grid { grid-template-columns: 1fr; }
  .metric-card { min-height: 86px; }
  .quota-layout { gap: 14px; }
  .auth-panel { grid-template-columns: 1fr; }
  .auth-panel .button { width: 100%; }
  .preview-grid { grid-template-columns: 1fr; }
}

/* Fixed-viewport management workbench */
html,
body {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  scrollbar-gutter: auto;
}
body { min-height: 0; }
.app-shell {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.main-shell {
  display: grid;
  grid-template-rows: 72px minmax(0, 1fr);
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.topbar {
  position: relative;
  top: auto;
  height: 72px;
  min-height: 72px;
  padding-block: 10px;
}
.admin-workspace {
  height: 100%;
  min-height: 0;
  padding: 12px 18px;
  overflow: hidden;
}
.view-panel:not([hidden]) {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.section-switcher {
  display: none;
  height: 36px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #e7eaf0;
}
.section-switcher button {
  min-width: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}
.section-switcher button.is-active {
  background: #fff;
  color: var(--purple-deep);
  box-shadow: 0 1px 2px rgba(18, 30, 65, .08);
}
.metric-grid {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  height: 80px;
  min-height: 0;
  margin: 0;
  gap: 10px;
}
.metric-card,
.metric-card:nth-child(4),
.metric-card:nth-child(5) {
  min-height: 0;
  height: 80px;
  padding: 10px 12px;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 10px;
}
.metric-icon { width: 42px; height: 42px; border-radius: 9px; }
.metric-icon .icon { width: 23px; height: 23px; }
.metric-value { font-size: clamp(18px, 1.35vw, 22px); }
.metric-note { margin-top: 3px; font-size: 10px; }
.panel-head {
  min-height: 50px;
  height: 50px;
  padding: 8px 13px;
}
.panel-title { font-size: 15px; }
.panel-subtitle { margin-top: 1px; font-size: 11px; }
.panel-body { padding: 12px; }
.table-wrap { min-height: 0; overflow: hidden; scrollbar-gutter: auto; }
th, td { height: 40px; padding-inline: 9px; }

#viewOverview {
  grid-template-rows: 80px minmax(0, 1fr);
  gap: 12px;
}
.overview-grid {
  height: 100%;
  min-height: 0;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 1.18fr);
  grid-template-rows: minmax(0, 1.08fr) minmax(0, .92fr);
  gap: 12px;
}
.overview-grid .panel,
.overview-grid .tall {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.overview-grid .panel-body,
.overview-grid .table-wrap { min-height: 0; }
.overview-grid .table-wrap { flex: 1 1 auto; }
.quota-layout { flex: 1 1 auto; gap: 14px; }
.donut { width: min(166px, 21vh); }
.donut::before { inset: 21px; }
.quota-line { min-height: 36px; }
.ranking-list, .distribution-list { gap: 9px; }
.config-column .distribution-list { gap: 8px; }
.ranking-row { gap: 8px; }

#viewUsers {
  grid-template-rows: 80px minmax(0, 1fr);
  gap: 12px;
}
.users-workbench,
.user-list-panel {
  height: 100%;
  min-height: 0;
}
.user-list-panel {
  display: grid;
  grid-template-rows: 50px 48px minmax(0, 1fr) 46px;
  min-height: 0;
}
.users-toolbar {
  min-height: 48px;
  height: 48px;
  padding: 4px 13px;
}
.users-table { min-width: 840px; }
.users-table th,
.users-table td { height: 40px; }
.list-footer {
  min-height: 46px;
  height: 46px;
  padding: 5px 12px;
}
.users-workbench > .user-drawer {
  top: auto;
  height: 100%;
  max-height: none;
  overflow: hidden;
}
#drawerContent:not([hidden]) {
  display: grid;
  grid-template-rows: auto 44px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.drawer-profile,
.drawer-tabs,
.drawer-section,
.drawer-section form,
.merge-zone { min-width: 0; }
.drawer-profile { padding: 11px 14px; }
.profile-avatar { width: 44px; height: 44px; }
.profile-stats { margin-top: 10px; }
.profile-stat { padding-block: 7px; }
.drawer-section {
  height: 100%;
  min-height: 0;
  padding: 12px 14px;
  overflow: hidden;
}
#drawerTrafficSection:not([hidden]) {
  display: grid !important;
  grid-template-rows: minmax(0, 1fr) 40px;
  gap: 6px;
}
#drawerProfileSection:not([hidden]) { overflow: auto; }
.drawer-traffic-wrap {
  height: 100%;
  max-height: none;
  overflow: hidden;
}
.drawer-table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 40px;
  border-top: 1px solid var(--line);
}
.traffic-table td,
.traffic-table th { height: 36px; }

@media (max-width: 1420px) {
  .users-workbench > .user-drawer {
    top: 0;
    height: 100dvh;
    max-height: 100dvh;
  }
}

#viewConfig {
  grid-template-rows: minmax(0, 1fr);
}
.management-grid {
  height: 100%;
  min-height: 0;
  grid-template-columns: minmax(0, 1.12fr) minmax(330px, .88fr);
  align-items: stretch;
  gap: 12px;
}
.management-grid > .panel,
.config-column,
.config-column > .panel { min-height: 0; height: 100%; }
.config-column {
  grid-template-rows: minmax(0, 1.2fr) minmax(0, .8fr);
  gap: 12px;
}
.config-panel .panel-body { padding: 16px; }
.config-block + .config-block { margin-top: 14px; padding-top: 14px; }
.config-footer { margin-top: 14px; padding-top: 12px; }
.quota-config-grid { padding-block: 10px; }
.quota-config-grid .donut { width: min(154px, 20vh); }

#viewAnomalies {
  grid-template-columns: minmax(270px, .32fr) minmax(0, 1fr);
  grid-template-rows: 80px minmax(0, 1fr);
  gap: 12px;
}
#viewAnomalies > .metric-grid {
  grid-column: 1 / -1;
  grid-row: 1;
}
.anomaly-summary,
.anomaly-distribution { margin: 0; }
.anomaly-distribution {
  grid-column: 1;
  grid-row: 2;
  height: 100%;
  min-height: 0;
}
.anomaly-records {
  display: grid;
  grid-column: 2;
  grid-row: 2;
  grid-template-rows: 50px 48px minmax(0, 1fr) 46px;
  height: 100%;
  min-height: 0;
}
.anomaly-toolbar {
  min-height: 48px;
  height: 48px;
  padding: 4px 13px;
}
.anomaly-table { min-width: 0; }
.anomaly-table th,
.anomaly-table td { height: 40px; padding-inline: 7px; font-size: 11px; }
.mobile-anomaly-total { display: none; }
.distribution-card-body {
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}
.distribution-row {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
}
.distribution-row .bar-track { grid-column: 1 / -1; grid-row: 2; }
.distribution-value { white-space: nowrap; }
.other-users { min-width: 0; padding: 10px; }
.users-table .button,
.anomaly-table .button {
  width: 100%;
  min-width: 0;
  padding-inline: 4px;
}
dialog::backdrop { backdrop-filter: none; }

@media (max-width: 1100px) {
  .users-table col.col-upload,
  .users-table col.col-download,
  .users-table th:nth-child(4),
  .users-table td:nth-child(4),
  .users-table th:nth-child(5),
  .users-table td:nth-child(5) { display: none; }
  .users-table { min-width: 0; }
  .users-table col.col-name { width: 18%; }
  .users-table col.col-subscription { width: 15%; }
  .users-table col.col-devices { width: 9%; }
  .users-table col.col-total { width: 14%; }
  .users-table col.col-anomalies { width: 9%; }
  .users-table col.col-seen { width: 23%; }
  .users-table col.col-actions { width: 12%; }
  .anomaly-table col.col-date,
  .anomaly-table col.col-reason,
  .anomaly-table th:nth-child(3),
  .anomaly-table td:nth-child(3),
  .anomaly-table th:nth-child(7),
  .anomaly-table td:nth-child(7) { display: none; }
  .anomaly-table col.col-user { width: 17%; }
  .anomaly-table col.col-device { width: 21%; }
  .anomaly-table col.col-upload,
  .anomaly-table col.col-download { width: 14%; }
  .anomaly-table col.col-time { width: 23%; }
  .anomaly-table col.col-action { width: 11%; }
}

@media (min-width: 901px) and (max-width: 1100px) {
  .quota-layout {
    grid-template-columns: minmax(150px, .72fr) minmax(0, 1fr);
    gap: 12px;
  }
  .quota-layout .donut { width: min(150px, 20vh); }
}

@media (max-width: 900px), (max-height: 700px) {
  .section-switcher {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
  }
  #viewOverview {
    grid-template-rows: 58px 36px minmax(0, 1fr);
    gap: 8px;
  }
  #viewOverview > .metric-grid { height: 58px; }
  .metric-grid,
  .metric-card,
  .metric-card:nth-child(4),
  .metric-card:nth-child(5) {
    height: 58px;
    min-height: 58px;
  }
  .metric-card {
    grid-template-columns: 28px minmax(0, 1fr);
    padding: 6px 7px;
    gap: 5px;
  }
  .metric-icon { width: 28px; height: 28px; }
  .metric-icon .icon { width: 17px; height: 17px; }
  .metric-label {
    margin-bottom: 1px;
    overflow: hidden;
    font-size: 9.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metric-value { font-size: 14px; line-height: 1.1; }
  .metric-note { display: none; }
  .overview-grid {
    display: block;
    height: 100%;
  }
  .overview-grid > .panel:not([hidden]) { height: 100%; }
  #viewConfig {
    grid-template-rows: 36px minmax(0, 1fr);
    gap: 8px;
  }
  #viewConfig .management-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
  }
  #viewConfig .config-column { display: contents; }
  #viewConfig [data-config-pane]:not([hidden]) { height: 100%; }
  #viewAnomalies {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 58px 36px minmax(0, 1fr);
    gap: 8px;
  }
  #viewAnomalies > .metric-grid {
    grid-column: 1;
    grid-row: 1;
    height: 58px;
  }
  #viewAnomalies > .section-switcher { grid-column: 1; grid-row: 2; }
  #viewAnomalies > [data-anomaly-pane]:not([hidden]) {
    grid-column: 1;
    grid-row: 3;
    height: 100%;
  }
  .anomaly-records { grid-template-rows: 50px 48px minmax(0, 1fr) 46px; }
}

@media (max-width: 900px) {
  .metric-card,
  .metric-card:nth-child(4),
  .metric-card:nth-child(5) {
    display: block;
    padding: 7px 9px;
  }
  .metric-icon { display: none; }
  .metric-value { font-size: 15px; }
}

@media (min-width: 701px) and (max-width: 900px) {
  .users-toolbar {
    flex-direction: row;
    align-items: center;
    height: 48px;
    min-height: 48px;
  }
  .users-toolbar .toolbar-group,
  .users-toolbar > .toolbar-group:first-child {
    width: auto;
    min-width: 0;
    flex-wrap: nowrap;
  }
  .users-toolbar > .toolbar-group:first-child { flex: 1 1 auto; }
  .users-toolbar > .toolbar-group:last-child { flex: 0 0 auto; }
  .users-toolbar .search-box {
    min-width: 140px;
    flex: 1 1 180px;
  }
  .users-toolbar select.compact {
    width: 88px;
    min-width: 80px;
    flex: 0 1 88px;
    padding-inline: 8px 24px;
  }
}

@media (max-width: 700px) {
  .app-shell { height: 100dvh; }
  .main-shell {
    grid-template-rows: 58px minmax(0, 1fr);
    height: calc(100dvh - 64px);
  }
  .topbar {
    top: auto;
    height: 58px;
    min-height: 58px;
    padding: 6px 11px;
  }
  .page-heading h1 { font-size: 18px; }
  .status-text { min-height: 16px; margin-top: 1px; }
  .admin-workspace { padding: 8px 10px; }
  .metric-grid,
  #viewOverview > .metric-grid,
  #viewAnomalies > .metric-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    height: 52px;
    min-height: 52px;
    gap: 4px;
  }
  .metric-card,
  .metric-card:nth-child(4),
  .metric-card:nth-child(5) {
    display: block;
    height: 52px;
    min-height: 52px;
    padding: 5px;
    border-radius: 8px;
  }
  .metric-icon,
  .metric-note { display: none; }
  .metric-label {
    margin: 0 0 2px;
    overflow: hidden;
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metric-value { font-size: 11px; letter-spacing: -.02em; }
  #viewOverview,
  #viewAnomalies { grid-template-rows: 52px 34px minmax(0, 1fr); gap: 6px; }
  #viewConfig { grid-template-rows: 34px minmax(0, 1fr); gap: 6px; }
  .section-switcher { height: 34px; }
  .section-switcher button { font-size: 10px; }
  .panel-head { height: 44px; min-height: 44px; padding: 6px 10px; }
  .panel-title { font-size: 14px; }
  .panel-subtitle { font-size: 10px; }
  .panel-body { padding: 10px; }
  .quota-layout {
    grid-template-columns: minmax(116px, .8fr) minmax(145px, 1fr);
    gap: 8px;
  }
  .donut { width: min(142px, 28vh); }
  .donut::before { inset: 18px; }
  .donut-content strong { font-size: 22px; }
  .quota-line { min-height: 34px; padding-inline: 8px; }
  #viewUsers { grid-template-rows: 52px minmax(0, 1fr); gap: 6px; }
  .user-list-panel { grid-template-rows: 44px 126px minmax(0, 1fr) 42px; }
  .users-toolbar {
    height: 126px;
    min-height: 126px;
    padding: 5px 8px;
    gap: 5px;
  }
  .users-toolbar .toolbar-group { gap: 5px; }
  .users-toolbar input,
  .users-toolbar select { height: 34px; }
  .search-box .icon { top: 8px; }
  .users-table { width: 100%; min-width: 0; }
  .users-table col.col-subscription,
  .users-table col.col-devices,
  .users-table col.col-upload,
  .users-table col.col-download,
  .users-table col.col-seen,
  .users-table col.col-actions,
  .users-table th:nth-child(2),
  .users-table td:nth-child(2),
  .users-table th:nth-child(3),
  .users-table td:nth-child(3),
  .users-table th:nth-child(4),
  .users-table td:nth-child(4),
  .users-table th:nth-child(5),
  .users-table td:nth-child(5),
  .users-table th:nth-child(8),
  .users-table td:nth-child(8),
  .users-table th:nth-child(9),
  .users-table td:nth-child(9) { display: none; }
  .users-table col.col-name { width: 45%; }
  .users-table col.col-total { width: 35%; }
  .users-table col.col-anomalies { width: 20%; }
  .users-table th,
  .users-table td { height: 38px; padding-inline: 9px; }
  .list-footer {
    min-height: 42px;
    height: 42px;
    padding: 4px 8px;
    flex-direction: row;
    align-items: center;
  }
  .list-footer > .count-text { display: none; }
  .pagination-controls { width: auto; margin-left: auto; }
  .pager-button { width: 30px; min-width: 30px; height: 30px; }
  .user-drawer {
    right: 0;
    left: 0;
    width: auto;
    max-width: none;
    height: 100dvh;
    max-height: 100dvh;
  }
  .drawer-profile { padding: 8px 10px; }
  .profile-head { gap: 8px; }
  .profile-avatar { width: 38px; height: 38px; }
  .profile-stats { grid-template-columns: repeat(4,minmax(0,1fr)); gap: 4px; margin-top: 7px; }
  .profile-stat { padding: 5px 2px; }
  .drawer-section { padding: 9px 10px; }
  .form-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
  .field.wide, .field-error.wide { grid-column: 1 / -1; }
  .drawer-actions { margin-top: 8px; }
  .drawer-table-footer { min-height: 36px; }
  .traffic-table td,
  .traffic-table th { height: 34px; font-size: 9.5px; }
  .traffic-table { width: 100%; min-width: 0; }
  .config-panel .panel-body { padding: 12px; }
  .config-block + .config-block { margin-top: 10px; padding-top: 10px; }
  .config-footer { margin-top: 10px; padding-top: 9px; flex-direction: row; }
  .config-footer .button { width: auto; }
  .quota-config-grid {
    grid-template-columns: minmax(120px,.8fr) minmax(140px,1fr);
    gap: 8px;
  }
  .quota-config-grid .donut { width: min(138px, 26vh); }
  .anomaly-records { grid-template-rows: 44px 88px minmax(0, 1fr) 42px; }
  .anomaly-toolbar {
    height: 88px;
    min-height: 88px;
    padding: 5px 8px;
    gap: 5px;
  }
  .anomaly-toolbar input,
  .anomaly-toolbar select { height: 34px; }
  .anomaly-table { width: 100%; min-width: 0; }
  .anomaly-table col.col-date,
  .anomaly-table col.col-upload,
  .anomaly-table col.col-download,
  .anomaly-table col.col-reason,
  .anomaly-table col.col-action,
  .anomaly-table th:nth-child(3),
  .anomaly-table td:nth-child(3),
  .anomaly-table th:nth-child(4),
  .anomaly-table td:nth-child(4),
  .anomaly-table th:nth-child(5),
  .anomaly-table td:nth-child(5),
  .anomaly-table th:nth-child(7),
  .anomaly-table td:nth-child(7),
  .anomaly-table th:nth-child(9),
  .anomaly-table td:nth-child(9) { display: none; }
  .anomaly-table col.col-user { width: 25%; }
  .anomaly-table col.col-device { width: 28%; }
  .anomaly-table col.mobile-anomaly-total { display: table-column; width: 18%; }
  .anomaly-table col.col-time { width: 29%; }
  .anomaly-table .mobile-anomaly-total { display: table-cell; }
  .anomaly-table th,
  .anomaly-table td { height: 38px; padding-inline: 5px; font-size: 10px; }
  .distribution-card-body { height: calc(100% - 44px); }
  .other-users {
    display: flex;
    align-items: center;
    align-self: start;
    justify-content: space-between;
    min-height: 42px;
    padding: 7px 9px;
  }
  .other-users strong { margin-top: 0; font-size: 15px; }
}

@media (max-width: 430px) {
  .metric-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .metric-card { min-height: 52px; }
  .metric-value { font-size: 10px; }
  .pagination-controls { gap: 5px; }
  .pager-button { width: 28px; min-width: 28px; height: 28px; }
  .quota-layout { gap: 8px; }
}

/* Overview data workbench */
.metric-grid {
  height: 72px;
}
.metric-card,
.metric-card:nth-child(4),
.metric-card:nth-child(5) {
  height: 72px;
  padding: 9px 11px;
}
.metric-card-pair { grid-template-columns: 40px minmax(0, 1fr); }
.metric-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-width: 0;
  margin: 0;
}
.metric-pair > div { min-width: 0; }
.metric-pair > div + div {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid var(--line);
}
.metric-pair dt {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-pair dd {
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 20px;
  font-weight: 760;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

#viewOverview {
  grid-template-rows: 72px minmax(0, 1fr);
}
.overview-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  grid-template-areas:
    "trend quota"
    "users ranking"
    "users anomalies";
  gap: 12px;
}
.overview-trend { grid-area: trend; }
.overview-users { grid-area: users; }
.overview-quota { grid-area: quota; }
.overview-ranking { grid-area: ranking; }
.overview-anomalies { grid-area: anomalies; }
.overview-grid .panel-head {
  height: 44px;
  min-height: 44px;
  padding: 6px 11px;
}
.overview-grid .panel-title { font-size: 14px; }
.overview-grid .panel-body,
.overview-grid .table-wrap { overflow: hidden; }

.trend-range {
  display: grid;
  grid-template-columns: repeat(3, 42px);
  height: 28px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel-muted);
}
.trend-range button {
  min-width: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.trend-range button.is-active {
  background: var(--purple);
  color: #fff;
}
.trend-body {
  display: grid;
  grid-template-rows: 20px minmax(0, 1fr);
  height: calc(100% - 44px);
  min-height: 0;
  padding: 5px 10px 8px;
}
.trend-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  color: var(--muted);
  font-size: 10.5px;
}
.trend-legend span::before {
  display: inline-block;
  width: 14px;
  height: 2px;
  margin: 0 5px 3px 0;
  background: var(--purple);
  content: "";
}
.trend-legend .download::before {
  height: 0;
  border-top: 2px dashed #8797bf;
  background: transparent;
}
.trend-chart-wrap {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 6px;
}
.trend-chart-wrap:focus-visible { box-shadow: inset var(--focus); }
#trafficTrendChart { display: block; overflow: visible; }
.trend-grid line { stroke: #e3e7ef; stroke-width: 1; }
.trend-grid text,
.trend-axis-x text {
  fill: #778197;
  font-family: inherit;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.trend-grid .trend-unit { fill: #687389; font-size: 8.5px; font-weight: 700; }
.trend-area { stroke: none; }
.trend-area-upload { fill: rgba(98, 84, 199, .11); }
.trend-area-download { fill: rgba(135, 151, 191, .09); }
.trend-line { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.trend-line-upload { stroke: var(--purple); }
.trend-line-download { stroke: #8797bf; stroke-dasharray: 5 4; }
.trend-cursor line { stroke: #9ba5b7; stroke-width: 1; stroke-dasharray: 3 3; }
.trend-cursor circle { fill: #fff; stroke-width: 2; }
.trend-cursor circle.upload { stroke: var(--purple); }
.trend-cursor circle.download { stroke: #8797bf; }
.trend-empty { fill: var(--muted); font-family: inherit; font-size: 12px; }
.trend-tooltip {
  position: absolute;
  top: 5px;
  z-index: 2;
  display: grid;
  width: 142px;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 7px;
  background: #17213a;
  color: #fff;
  box-shadow: 0 6px 18px rgba(18,30,65,.18);
  font-size: 10px;
  pointer-events: none;
}
.trend-tooltip strong { font-size: 11px; }
.trend-tooltip span { color: rgba(255,255,255,.82); }
.trend-tooltip i {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: #a89df2;
}
.trend-tooltip i.download { background: #a8b6d7; }

.overview-users-table col.recent-name { width: 18%; }
.overview-users-table col.recent-devices { width: 7%; }
.overview-users-table col.recent-upload,
.overview-users-table col.recent-download,
.overview-users-table col.recent-total { width: 14%; }
.overview-users-table col.recent-anomalies { width: 7%; }
.overview-users-table col.recent-seen { width: 26%; }
.overview-users-table th,
.overview-users-table td { height: 36px; padding-inline: 7px; font-size: 11px; }
.overview-users-table td { white-space: nowrap; }
.overview-users-table .recent-seen { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.overview-quota-layout {
  grid-template-columns: minmax(108px, .55fr) minmax(0, 1fr);
  height: calc(100% - 44px);
  padding: 8px 10px;
  gap: 10px;
}
.overview-quota-layout .donut { width: min(126px, 15vh); }
.overview-quota-layout .donut::before { inset: 15px; }
.overview-quota-layout .donut-content strong { font-size: 21px; }
.overview-quota-layout .quota-legend { gap: 0; }
.overview-quota-layout .quota-line {
  min-height: 27px;
  padding: 0 3px;
  border-bottom: 1px solid #e7eaf0;
  border-radius: 0;
  background: transparent;
}
.overview-quota-layout .quota-line:last-child { border-bottom: 0; }
.overview-quota-layout .quota-line span { font-size: 10.5px; }
.overview-quota-layout .quota-line strong { font-size: 11px; white-space: nowrap; }
.quota-dot.expiry { background: #8797bf; }

.overview-ranking .panel-body { height: calc(100% - 44px); padding: 8px 11px; }
.overview-ranking .ranking-list { gap: 6px; }
.overview-ranking .ranking-row { min-height: 28px; }
.overview-ranking .rank-index { width: 22px; height: 22px; font-size: 10px; }
.overview-ranking .bar-track { height: 7px; }
.overview-anomalies th,
.overview-anomalies td { height: 40px; padding-inline: 7px; font-size: 10.5px; }

.quota-fields { display: grid; gap: 10px; }
.quota-save { width: 100%; }

@media (max-width: 1279px), (max-height: 700px) {
  [data-section-switcher="overview"] {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
  }
  #viewOverview { grid-template-rows: 72px 36px minmax(0, 1fr); gap: 8px; }
  .overview-grid { display: block; height: 100%; }
  .overview-grid > .panel:not([hidden]) { width: 100%; height: 100%; }
  .overview-users-table col.recent-name { width: 18%; }
  .overview-users-table col.recent-devices { width: 8%; }
  .overview-users-table col.recent-upload,
  .overview-users-table col.recent-download,
  .overview-users-table col.recent-total { width: 14%; }
  .overview-users-table col.recent-anomalies { width: 8%; }
  .overview-users-table col.recent-seen { width: 24%; }
}

@media (min-width: 701px) and (max-width: 1100px) {
  .metric-card-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    padding: 7px 9px;
  }
  .metric-card-pair .metric-icon { display: none; }
  .metric-pair dd { margin-top: 4px; font-size: 15px; }
}

@media (max-width: 700px) {
  .metric-grid,
  #viewOverview > .metric-grid {
    height: 52px;
    min-height: 52px;
  }
  .metric-card,
  .metric-card:nth-child(4),
  .metric-card:nth-child(5) {
    display: block;
    height: 52px;
    min-height: 52px;
    padding: 5px;
  }
  .metric-card-pair { display: block; }
  .metric-pair > div + div { margin-left: 3px; padding-left: 3px; }
  .metric-pair dt { font-size: 7.5px; }
  .metric-pair dd { margin-top: 3px; font-size: 10px; }
  #viewOverview { grid-template-rows: 52px 34px minmax(0, 1fr); gap: 6px; }
  [data-section-switcher="overview"] { height: 34px; }
  .trend-range { grid-template-columns: repeat(3, 37px); }
  .overview-users-table .recent-devices,
  .overview-users-table .recent-total { display: none; }
  .overview-users-table col.recent-name { width: 20%; }
  .overview-users-table col.recent-upload,
  .overview-users-table col.recent-download { width: 17%; }
  .overview-users-table col.recent-anomalies { width: 12%; }
  .overview-users-table col.recent-seen { width: 34%; }
  .overview-users-table th,
  .overview-users-table td { height: 36px; padding-inline: 4px; font-size: 9.5px; }
  .overview-quota-layout {
    grid-template-columns: minmax(104px, .48fr) minmax(0, 1fr);
    height: calc(100% - 44px);
  }
  .overview-quota-layout .donut { width: min(122px, 24vh); }
  .overview-quota-layout .quota-line { min-height: 30px; }
}

@media (max-width: 430px) {
  .metric-pair dt { font-size: 7px; }
  .metric-pair dd { font-size: 9px; }
  .overview-users-table .recent-seen { display: none; }
  .overview-users-table col.recent-name { width: 28%; }
  .overview-users-table col.recent-upload,
  .overview-users-table col.recent-download { width: 24%; }
  .overview-users-table col.recent-anomalies { width: 24%; }
  .overview-quota-layout { grid-template-columns: minmax(92px, .44fr) minmax(0, 1fr); gap: 6px; }
  .overview-quota-layout .donut { width: min(108px, 22vh); }
  .overview-quota-layout .quota-line strong { font-size: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;

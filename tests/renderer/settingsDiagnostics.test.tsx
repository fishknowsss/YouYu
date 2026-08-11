import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '../../src/shared/ipc';
import { Settings } from '../../src/renderer/pages/Settings';
import { readRendererStyles } from './helpers/rendererStyles';

describe('settings diagnostic export', () => {
  it('renders cloud-managed fields as read-only when the account lacks permission', () => {
    const snapshot = createSnapshot(0);
    snapshot.trafficIdentity = {
      userId: 'user-1',
      deviceId: 'device-1',
      name: '测试用户',
      registeredAt: '2026-08-11T00:00:00.000Z'
    };
    snapshot.configSource = 'global';
    snapshot.remoteConfigReady = true;
    snapshot.canEditManagedConfig = false;

    const html = renderSettings('', snapshot);

    expect(html).toContain('订阅 · 跟随全局 · 只读');
    expect(html).toContain('规则来源 · 只读');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*placeholder="https:\/\/\.\.\."/);
  });

  it('asks a registered account to sync before editing when no current cloud cache exists', () => {
    const snapshot = createSnapshot(0);
    snapshot.trafficIdentity = {
      userId: 'user-1',
      deviceId: 'device-1',
      name: '测试用户',
      registeredAt: '2026-08-11T00:00:00.000Z'
    };
    snapshot.remoteConfigReady = false;

    expect(renderSettings('', snapshot)).toContain('订阅 · 先同步');
  });
  it('places the exportable log count to the left of a concise export button', () => {
    const html = renderToStaticMarkup(
      <Settings
        snapshot={createSnapshot(37)}
        busy={false}
        busyLabel=""
        message=""
        onRepair={vi.fn()}
        onSave={vi.fn()}
        onSyncRemoteConfig={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onCheckUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
      />
    );

    expect(html).toContain('class="settings-diagnostics-bar"');
    expect(html).toContain('class="settings-diagnostics-summary" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('诊断日志');
    expect(html).toContain('37 条');
    expect(html).toContain(
      'class="secondary-button settings-footer-action settings-diagnostics-export settings-action-export"'
    );
    expect(html).toContain('>导出</button>');
    expect(html).toContain('class="wide-button settings-action-check settings-footer-action"');
    expect(html).toContain('>检查</button>');
    expect(html).toContain('class="settings-action-status is-error"');
    expect(html).toContain('DNS 异常 · 点击修复');
  });

  it('keeps all six settings rows on one grid and gives diagnostics a full-width action', async () => {
    const styles = await readRendererStyles();
    const formRule = getRule(styles, '.settings-form-grid');
    const rowRule = getRule(styles, '.settings-row');
    const barRule = getRule(styles, '.settings-diagnostics-bar');
    const exportRule = getRule(styles, '.settings-diagnostics-export');
    const footerActionRule = getRule(styles, '.settings-footer-action');
    const updateRule = getRule(styles, '.update-row');

    expect(formRule).toContain('grid-template-rows: repeat(6, var(--settings-row-height))');
    expect(rowRule).toContain('grid-template-columns: subgrid');
    expect(barRule).toContain('grid-template-columns: minmax(0, 1fr) var(--settings-action-width)');
    expect(barRule).toContain('column-gap: 16px');
    expect(exportRule).toContain('grid-column: 2');
    expect(footerActionRule).toContain('font-size: 18px');
    expect(footerActionRule).toContain('font-weight: 700');
    expect(barRule).toContain('height: var(--settings-footer-row-height)');
    expect(updateRule).toContain('min-height: var(--settings-footer-row-height)');
    expect(updateRule).toContain('padding: 4px 0 4px 14px');
    expect(styles).not.toContain('.settings-controls-grid {');
    expect(styles).not.toContain('.settings-footer {');
  });

  it('shows a disabled in-progress export action', () => {
    const html = renderToStaticMarkup(
      <Settings
        snapshot={createSnapshot(37)}
        busy
        busyLabel="导出中"
        message=""
        onRepair={vi.fn()}
        onSave={vi.fn()}
        onSyncRemoteConfig={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onCheckUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
      />
    );

    expect(html).toMatch(
      /<button class="secondary-button settings-footer-action settings-diagnostics-export settings-action-export" disabled="">导出中<\/button>/
    );
  });

  it.each([0, 200])('keeps an exact exportable count at the supported boundary: %s', (logCount) => {
    const snapshot = createSnapshot(logCount);
    snapshot.diagnostics.issueKind = undefined;

    expect(renderSettings('', snapshot)).toContain(`${logCount} 条`);
  });

  it('caps a long diagnostic status without moving the log count or export action', async () => {
    const longMessage = `无法连接后台：${'网络路径仍不可用'.repeat(12)}`;
    const html = renderSettings(longMessage, createSnapshot(200));
    const styles = await readRendererStyles();
    const statusRule = getRule(styles, '.settings-action-status');

    expect(html).toContain(longMessage);
    expect(html).toContain('200 条');
    expect(html).toContain('>导出</button>');
    expect(statusRule).toContain('-webkit-line-clamp: 2');
    expect(statusRule).toContain('overflow: hidden');
  });

  it.each(['请重新登记', '没有可用节点'])('shows the current action error before a diagnostic issue: %s', (message) => {
    const html = renderSettings(message, createSnapshot(37));

    expect(html).toContain('class="settings-action-status is-error"');
    expect(html).toContain(message);
    expect(html).not.toContain('DNS 异常 · 点击修复');
  });

  it('shows the diagnostic issue before a successful action status', () => {
    const html = renderSettings('已同步', createSnapshot(37));

    expect(html).toContain('class="settings-action-status is-error"');
    expect(html).toContain('DNS 异常 · 点击修复');
    expect(html).not.toContain('已同步');
  });

  it('shows a successful action status when there is no diagnostic issue', () => {
    const snapshot = createSnapshot(37);
    snapshot.diagnostics.issueKind = undefined;
    const html = renderSettings('已修复', snapshot);

    expect(html).toContain('class="settings-action-status"');
    expect(html).toContain('已修复');
    expect(html).not.toContain('class="settings-action-status is-error"');
  });

  it.each([
    ['global', '跟随全局'],
    ['user', '单独配置'],
    ['local', '仅本机']
  ] as const)('shows the effective config ownership without locking professional edits: %s', (configSource, label) => {
    const snapshot = createSnapshot(0);
    snapshot.configSource = configSource;
    snapshot.remoteSubscriptionUrl = configSource === 'local' ? undefined : snapshot.subscriptionUrl;
    const html = renderSettings('', snapshot);

    expect(html).toContain(`订阅 · ${label}`);
    expect(html).toContain(`value="${snapshot.subscriptionUrl}"`);
    expect(html).not.toMatch(new RegExp(`value="${snapshot.subscriptionUrl}"[^>]*disabled`));
  });

  it.each(['net::ERR_NAME_NOT_RESOLVED', 'fetch failed (ENOTFOUND)'])(
    'shows a concise GitHub connection failure for update transport error: %s',
    (message) => {
      const snapshot = createSnapshot(0);
      snapshot.diagnostics.issueKind = undefined;
      snapshot.update = {
        ...snapshot.update,
        status: 'failed',
        message
      };

      expect(renderSettings('', snapshot)).toContain('失败：无法连接 GitHub');
    }
  );

  it('announces update progress without making the rest of the page wait for visual polling', () => {
    const snapshot = createSnapshot(0);
    snapshot.update = {
      ...snapshot.update,
      status: 'downloading',
      availableVersion: '1.6.0',
      percent: 37,
      downloadPhase: 'downloading'
    };

    const html = renderSettings('', snapshot);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="update-copy" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('正在下载更新包 1.6.0 37%');
  });

  it('does not apply the secondary hover surface to disabled buttons', async () => {
    const styles = await readRendererStyles();
    expect(styles).toContain('.secondary-button:hover:not(:disabled)');
    expect(styles).toContain('.wide-button:hover:not(:disabled)');
    expect(styles).not.toContain('.secondary-button:hover,');
    expect(styles).not.toContain('.wide-button:hover {');
  });

  it('keeps the selected sidebar item on an accent surface while hovering', async () => {
    const styles = await readRendererStyles();
    const selectedHoverRule = getRule(styles, '.nav-list button.active:hover:not(:disabled)');

    expect(styles).toContain('.nav-list button:not(.active):hover:not(:disabled)');
    expect(selectedHoverRule).toContain('background: var(--accent-strong)');
    expect(styles).not.toContain('.nav-list button:hover:not(:disabled),');
  });

  it('keeps the hidden version entry visually inert and lifted from the bottom edge', async () => {
    const styles = await readRendererStyles();
    const shellRule = getRule(styles, '.app-shell');
    const versionRule = getRule(styles, '.version-chip');
    const versionTextRule = getRule(styles, '.version-chip span');

    expect(shellRule).toContain('--sidebar-version-width: 88px;');
    expect(versionRule).toContain('width: var(--sidebar-version-width);');
    expect(versionRule).toContain('var(--sidebar-block-padding)');
    expect(versionRule).not.toContain('transition:');
    expect(versionTextRule).not.toContain('text-overflow: ellipsis');
    expect(versionTextRule).not.toContain('overflow: hidden');
    expect(styles).not.toContain('.version-chip:hover:not(:disabled)');
    expect(styles).not.toContain('.version-chip:active:not(:disabled)');
  });

  it('keeps repair semantic while the update check reuses the primary save-button vocabulary', async () => {
    const styles = await readRendererStyles();
    const repair = getRule(styles, '.settings-action-repair');
    const repairHover = getRule(styles, '.settings-action-repair:hover:not(:disabled)');
    const primary = getRule(styles, '.power-button,\n.wide-button');
    const primaryHover = getRule(styles, '.power-button:hover:not(:disabled),\n.wide-button:hover:not(:disabled)');

    expect(styles).toContain('.settings-action-sync:hover:not(:disabled)');
    expect(styles).toContain('.settings-action-export:hover:not(:disabled)');
    expect(repair).toContain('background: var(--danger-soft);');
    expect(repairHover).toContain('background: var(--danger-soft-hover);');
    expect(primary).toContain('background: var(--accent);');
    expect(primaryHover).toContain('background: var(--accent-strong);');
    expect(styles).not.toContain('.settings-action-check {');
    expect(styles).not.toContain('.settings-action-check:hover:not(:disabled) {');
  });
});

function renderSettings(message: string, snapshot: AppSnapshot): string {
  return renderToStaticMarkup(
    <Settings
      snapshot={snapshot}
      busy={false}
      busyLabel=""
      message={message}
      onRepair={vi.fn()}
      onSave={vi.fn()}
      onSyncRemoteConfig={vi.fn()}
      onExportDiagnostics={vi.fn()}
      onCheckUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
    />
  );
}

function createSnapshot(logCount: number): AppSnapshot {
  return {
    status: 'running',
    currentNode: '自动选择',
    nodes: [],
    nodeHealth: {
      nodeName: '自动选择',
      delayStatus: 'untested',
      availability: { status: 'untested', totalCount: 0 }
    },
    strategies: [],
    mode: 'rule',
    strategy: 'auto',
    ruleProfile: 'ruleset',
    features: {
      systemProxyEnabled: true,
      dnsEnhanced: true,
      snifferEnabled: true,
      tunEnabled: false,
      strictRouteEnabled: true,
      allowLan: false,
      subscriptionRefreshIntervalHours: 12
    },
    runtime: { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
    traffic: {
      totalUpload: 0,
      totalDownload: 0,
      todayUpload: 0,
      todayDownload: 0,
      pendingUpload: 0,
      pendingDownload: 0,
      nodeUsage: {},
      reportStatus: 'idle'
    },
    subscriptionUrl: 'https://example.com/subscription',
    update: { currentVersion: '1.5.11', buildChannel: 'standard', updateChannel: 'latest', status: 'idle' },
    diagnostics: { logs: ['可见日志'], logCount, issueKind: 'dns' }
  };
}

function getRule(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  const end = styles.indexOf('\n}', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return styles.slice(start, end);
}

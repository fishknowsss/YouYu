import React from 'react';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSnapshot } from '../../src/shared/ipc';
import { Settings } from '../../src/renderer/pages/Settings';

describe('settings diagnostic export', () => {
  it('places the exportable log count to the left of a concise export button', () => {
    const html = renderToStaticMarkup(
      <Settings
        snapshot={createSnapshot(37)}
        busy={false}
        busyLabel=""
        message=""
        onBack={vi.fn()}
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
    expect(html).toContain('class="secondary-button settings-control-button settings-diagnostics-export"');
    expect(html).toContain('>导出</button>');
    expect(html).toContain('class="settings-action-status is-error"');
    expect(html).toContain('DNS 异常 · 点击修复');
  });

  it('keeps the three control rows rhythmic and gives diagnostics a full-width footer', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const controlsRule = getRule(styles, '.settings-controls-grid');
    const barRule = getRule(styles, '.settings-diagnostics-bar');
    const exportRule = getRule(styles, '.settings-diagnostics-export');

    expect(controlsRule).toContain('grid-template-rows: repeat(3, var(--settings-row-height))');
    expect(controlsRule).not.toContain('var(--settings-control-height)');
    expect(barRule).toContain('grid-template-columns: minmax(0, 1fr) var(--settings-action-width)');
    expect(barRule).toContain('column-gap: 16px');
    expect(exportRule).toContain('grid-column: 2');
    expect(controlsRule).not.toContain('grid-row: 4');
  });

  it('shows a disabled in-progress export action', () => {
    const html = renderToStaticMarkup(
      <Settings
        snapshot={createSnapshot(37)}
        busy
        busyLabel="导出中"
        message=""
        onBack={vi.fn()}
        onRepair={vi.fn()}
        onSave={vi.fn()}
        onSyncRemoteConfig={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onCheckUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
      />
    );

    expect(html).toMatch(
      /<button class="secondary-button settings-control-button settings-diagnostics-export" disabled="">导出中<\/button>/
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
    const styles = await readFile('src/renderer/styles.css', 'utf8');
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
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    expect(styles).toContain('.secondary-button:hover:not(:disabled)');
    expect(styles).not.toContain('.secondary-button:hover,');
  });
});

function renderSettings(message: string, snapshot: AppSnapshot): string {
  return renderToStaticMarkup(
    <Settings
      snapshot={snapshot}
      busy={false}
      busyLabel=""
      message={message}
      onBack={vi.fn()}
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

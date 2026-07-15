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

    expect(html).toContain('class="network-status-item settings-diagnostics-count"');
    expect(html).toContain('诊断日志');
    expect(html).toContain('37 条');
    expect(html).toContain('class="secondary-button settings-control-button settings-diagnostics-export"');
    expect(html).toContain('>导出</button>');
    expect(html).toContain('class="settings-action-status is-error"');
    expect(html).toContain('DNS 异常 · 点击修复');
  });

  it('locks the export action into the fourth-row right columns', async () => {
    const styles = await readFile('src/renderer/styles.css', 'utf8');
    const countRule = getRule(styles, '.settings-diagnostics-count');
    const exportRule = getRule(styles, '.settings-diagnostics-export');

    expect(countRule).toContain('grid-column: 2');
    expect(countRule).toContain('grid-row: 4');
    expect(exportRule).toContain('grid-column: 3');
    expect(exportRule).toContain('grid-row: 4');
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

    expect(html).toContain('disabled=""');
    expect(html).toContain('>导出中</button>');
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

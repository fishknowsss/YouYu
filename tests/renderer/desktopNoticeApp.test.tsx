// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopNoticeApp } from '../../src/renderer/DesktopNoticeApp';
import type { AppSnapshot } from '../../src/shared/ipc';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Object.defineProperty(window, 'youyu', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

describe('DesktopNoticeApp', () => {
  it('loads once, follows main-process snapshots, and acknowledges from the desktop card', async () => {
    const initial = createSnapshot('info', '初始通知');
    const updated = createSnapshot('warning', '已更新的通知');
    let listener: ((snapshot: AppSnapshot) => void) | undefined;
    const dispose = vi.fn();
    const acknowledgeUserNotice = vi.fn(async () => ({ ...updated, userNotice: undefined }));
    const getSnapshot = vi.fn(async () => initial);
    Object.defineProperty(window, 'youyu', {
      configurable: true,
      value: {
        getSnapshot,
        acknowledgeUserNotice,
        onSnapshotUpdated: vi.fn((nextListener) => {
          listener = nextListener;
          return dispose;
        })
      } as unknown as NonNullable<Window['youyu']>
    });

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <React.StrictMode>
          <DesktopNoticeApp />
        </React.StrictMode>
      );
    });

    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('初始通知');

    await act(async () => listener?.(updated));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('已更新的通知');

    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '知道了'
    );
    await act(async () => confirm?.click());
    expect(acknowledgeUserNotice).toHaveBeenCalledWith(updated.userNotice?.revision);
    expect(container.querySelector('.user-notice-banner')).toBeNull();

    await act(async () => root?.unmount());
    root = undefined;
    expect(dispose).toHaveBeenCalled();
  });
});

function createSnapshot(tone: 'info' | 'warning', message: string): AppSnapshot {
  return {
    status: 'stopped',
    currentNode: '自动选择',
    nodeHealth: {
      nodeName: '自动选择',
      delayStatus: 'untested',
      availability: { status: 'untested', totalCount: 0 }
    },
    update: {
      currentVersion: '1.7.1',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'idle'
    },
    nodes: [],
    strategies: [],
    diagnostics: { logs: [], logCount: 0 },
    runtime: { activeConnections: 0, uploadTotal: 0, downloadTotal: 0 },
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
    userNotice: {
      revision: tone === 'warning' ? 2 : 1,
      tone,
      message,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

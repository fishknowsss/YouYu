// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  App,
  createOperationRequestTracker,
  getActionErrorMessage,
  RegistrationGate,
  startEasyProxy,
  withTimeout
} from '../../src/renderer/App';
import type { AppSnapshot } from '../../src/shared/ipc';
import { AppShell } from '../../src/renderer/components/AppShell';
import { Home } from '../../src/renderer/pages/Home';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Object.defineProperty(window, 'youyu', { configurable: true, value: undefined });
  window.history.replaceState({}, '', '/');
});

describe('renderer action behavior', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the operation that timed out and requests cancellation', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = withTimeout(new Promise<never>(() => undefined), 50, '同步', onTimeout);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ActionTimeoutError',
      operation: '同步'
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(onTimeout).toHaveBeenCalledOnce();
    await expect(withTimeout(Promise.resolve('ok'), 50, '启动', onTimeout)).resolves.toBe('ok');
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('keeps generic and operation-specific timeout copy separate', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 1, '修复');
    let timeoutError: unknown;
    void pending.catch((error) => {
      timeoutError = error;
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(getActionErrorMessage(timeoutError)).toBe('修复超时');
    expect(getActionErrorMessage(new Error('operation timed out'))).toBe('操作超时');
  });

  it('does not start the proxy when cancellation lands during the snapshot gap', async () => {
    let resolveSnapshot: ((snapshot: AppSnapshot) => void) | undefined;
    const snapshot = new Promise<AppSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const start = vi.fn();
    const controller = new AbortController();
    const api = {
      getSnapshot: vi.fn(() => snapshot),
      start
    } as unknown as NonNullable<Window['youyu']>;
    const running = startEasyProxy(api, createOperationRequestTracker(), controller.signal);

    controller.abort(new Error('operation canceled'));
    resolveSnapshot?.({ status: 'stopped' } as AppSnapshot);

    await expect(running).rejects.toThrow('operation canceled');
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps the successful sync message out of the home diagnostics panel', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/?mode=advanced&page=settings');
    const snapshot = {
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
      trafficIdentity: {
        userId: 'user-1',
        deviceId: 'device-1',
        name: '测试用户',
        registeredAt: '2026-07-15T00:00:00.000Z'
      },
      subscriptionUrl: 'https://example.com/subscription',
      update: {
        currentVersion: '1.5.11',
        buildChannel: 'standard',
        updateChannel: 'latest',
        status: 'idle'
      },
      diagnostics: { logs: ['运行正常'] }
    } as AppSnapshot;
    const api = {
      getSnapshot: vi.fn(async () => snapshot),
      syncRemoteConfig: vi.fn(async () => snapshot),
      onSnapshotUpdated: vi.fn(() => () => undefined),
      cancelOperation: vi.fn(async () => undefined)
    } as unknown as NonNullable<Window['youyu']>;
    Object.defineProperty(window, 'youyu', { configurable: true, value: api });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<App />));
    await act(async () => Promise.resolve());
    const syncButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '同步');
    expect(syncButton).toBeTruthy();
    await act(async () => syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('已同步');

    await act(async () => {
      const backButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回');
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.diagnostics-status')?.textContent ?? '').not.toContain('已同步');

    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(container.querySelector('.diagnostics-status')?.textContent ?? '').not.toContain('已同步');
  });

  it.each([
    { button: '保存', done: '已保存' },
    { button: '修复', done: '已修复' }
  ])('keeps the $done settings message out of the home diagnostics panel', async ({ button, done }) => {
    window.history.replaceState({}, '', '/?mode=advanced&page=settings');
    const snapshot = createRegisteredRendererSnapshot();
    const saveSettings = vi.fn(async () => snapshot);
    const repair = vi.fn(async () => snapshot);
    const api = {
      getSnapshot: vi.fn(async () => snapshot),
      saveSettings,
      repair,
      onSnapshotUpdated: vi.fn(() => () => undefined),
      cancelOperation: vi.fn(async () => undefined)
    } as unknown as NonNullable<Window['youyu']>;
    Object.defineProperty(window, 'youyu', { configurable: true, value: api });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<App />));
    await act(async () => Promise.resolve());
    const actionButton = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === button
    );
    expect(actionButton).toBeTruthy();
    await act(async () => actionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain(done);

    await act(async () => {
      const backButton = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === '返回'
      );
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.diagnostics-status')?.textContent ?? '').not.toContain(done);
    expect(button === '保存' ? saveSettings : repair).toHaveBeenCalledOnce();
  });

  it('exports diagnostics through the preload API and reports completion only after a saved file', async () => {
    window.history.replaceState({}, '', '/?mode=advanced&page=settings');
    const snapshot = createRegisteredRendererSnapshot();
    const exportDiagnostics = vi.fn(async () => ({ canceled: false, exportedCount: 12 }));
    const api = {
      getSnapshot: vi.fn(async () => snapshot),
      exportDiagnostics,
      onSnapshotUpdated: vi.fn(() => () => undefined),
      cancelOperation: vi.fn(async () => undefined)
    } as unknown as NonNullable<Window['youyu']>;
    Object.defineProperty(window, 'youyu', { configurable: true, value: api });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<App />));
    await act(async () => Promise.resolve());
    const exportButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '导出');
    expect(exportButton).toBeTruthy();

    await act(async () => {
      exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('已导出');
  });
});

function createRegisteredRendererSnapshot(): AppSnapshot {
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
    trafficIdentity: {
      userId: 'user-1',
      deviceId: 'device-1',
      name: '测试用户',
      registeredAt: '2026-07-15T00:00:00.000Z'
    },
    subscriptionUrl: 'https://example.com/subscription',
    update: {
      currentVersion: '1.5.11',
      buildChannel: 'standard',
      updateChannel: 'latest',
      status: 'idle'
    },
    diagnostics: { logs: ['运行正常'], logCount: 12 }
  };
}

describe('RegistrationGate', () => {
  it('renders a labelled modal form that requires both fields', () => {
    const html = renderToStaticMarkup(<RegistrationGate busy={false} message="" onRegister={() => undefined} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="registration-title"');
    expect(html).toContain('aria-describedby="registration-description registration-status"');
    expect(html).toContain('填写姓名和口令后开始使用');
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).toContain('type="submit"');
  });

  it('exposes the registration progress as an atomic live region', () => {
    const html = renderToStaticMarkup(<RegistrationGate busy message="" onRegister={() => undefined} />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('登记中');
  });

  it('focuses the first field and traps forward and reverse tab navigation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RegistrationGate busy={false} message="" onRegister={() => undefined} />));

    const name = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    const passphrase = container.querySelector<HTMLInputElement>('input[name="registration-passphrase"]')!;
    expect(document.activeElement).toBe(name);

    passphrase.focus();
    passphrase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(name);

    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(passphrase);
  });

  it('keeps the background inert while registration is required', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AppShell page="home" usageMode="easy" inert onPageChange={() => undefined}>
          <main>受限内容</main>
        </AppShell>
      )
    );

    const shell = container.querySelector('.app-shell');
    expect(shell?.hasAttribute('inert')).toBe(true);
    expect(shell?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('advanced home diagnostics', () => {
  it.each(['已同步', '已保存', '已修复'])('does not render %s above the diagnostic log', (message) => {
    const html = renderToStaticMarkup(
      <Home
        usageMode="advanced"
        snapshot={createRegisteredRendererSnapshot()}
        busy={false}
        busyLabel=""
        message={message}
        onQuickStart={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRepair={vi.fn()}
        onModeChange={vi.fn()}
        onStrategyChange={vi.fn()}
        onOpenNodes={vi.fn()}
        onUsageModeChange={vi.fn()}
        onInstallUpdate={vi.fn()}
      />
    );

    expect(html).not.toContain('diagnostics-status');
    expect(html).not.toContain(message);
  });

  it('keeps the diagnostics viewport on the latest log entry', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const snapshot = {
      status: 'running',
      currentNode: '自动选择',
      traffic: {
        todayUpload: 0,
        todayDownload: 0,
        totalUpload: 0,
        totalDownload: 0,
        nodeUsage: {}
      },
      diagnostics: {
        logs: ['日志 1', '日志 2', '日志 3', '日志 4', '日志 5', '日志 6', '重复日志']
      },
      strategy: 'auto',
      mode: 'rule',
      nodeHealth: {
        delayStatus: 'untested',
        availability: { status: 'untested', totalCount: 10 }
      }
    } as AppSnapshot;
    const props = {
      usageMode: 'advanced' as const,
      snapshot,
      busy: false,
      busyLabel: '',
      message: '',
      onQuickStart: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onRepair: vi.fn(),
      onModeChange: vi.fn(),
      onStrategyChange: vi.fn(),
      onOpenNodes: vi.fn(),
      onUsageModeChange: vi.fn(),
      onInstallUpdate: vi.fn()
    };

    await act(async () => root?.render(<Home {...props} />));
    expect(container.querySelector('.mode-strip button[aria-pressed="true"]')?.textContent).toBe('规则');
    expect(container.querySelector('.node-mode-toggle button[aria-pressed="true"]')?.textContent).toBe('自动');
    const log = container.querySelector<HTMLDivElement>('.diagnostics-log')!;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 240 });

    await act(async () =>
      root?.render(
        <Home
          {...props}
          snapshot={{
            ...snapshot,
            diagnostics: { logs: [...snapshot.diagnostics.logs, '重复日志'] }
          }}
        />
      )
    );

    expect(log.scrollTop).toBe(240);
    expect(log.lastElementChild?.textContent).toBe('重复日志');
  });

  it('uses a short status label when startup fails', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const snapshot = {
      status: 'failed',
      currentNode: '自动选择',
      traffic: {
        todayUpload: 0,
        todayDownload: 0,
        totalUpload: 0,
        totalDownload: 0,
        nodeUsage: {}
      },
      diagnostics: { logs: [] },
      strategy: 'auto',
      mode: 'rule',
      nodeHealth: {
        delayStatus: 'untested',
        availability: { status: 'untested', totalCount: 0 }
      }
    } as unknown as AppSnapshot;

    await act(async () =>
      root?.render(
        <Home
          usageMode="advanced"
          snapshot={snapshot}
          busy={false}
          busyLabel=""
          message=""
          onQuickStart={vi.fn()}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onRepair={vi.fn()}
          onModeChange={vi.fn()}
          onStrategyChange={vi.fn()}
          onOpenNodes={vi.fn()}
          onUsageModeChange={vi.fn()}
          onInstallUpdate={vi.fn()}
        />
      )
    );

    expect(container.querySelector('.status-badge')?.textContent).toBe('异常');
  });
});
